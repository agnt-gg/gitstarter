// Asks whether the service is actually working, and fixes the one failure it
// can fix by itself.
//
// "The process is running" is not the question. A node process can be alive and
// serving 500s, or serving a board that is empty because the chain scan has been
// throwing for six hours. Both look identical to a supervisor watching a PID,
// and both are invisible until somebody opens the site and finds nothing.
//
// So this probes the things a user would notice, in the order they would notice
// them, and it is deliberately allowed to restart the service — because the
// alternative to a watchdog is a person, and at 3am there is no person.
//
//   node scripts/healthcheck.mjs
//   node scripts/healthcheck.mjs --heal     restart the service if it is wedged
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1]; };

const BASE = arg('base') || process.env.HEALTHCHECK_URL || 'https://gitstarter.agnt.gg';
const BACKUP_DIR = process.env.DB_BACKUP_PATH || '/var/backups/gitstarter';
const MAX_BACKUP_AGE_HOURS = Number(process.env.MAX_BACKUP_AGE_HOURS || 3);
const PM2_NAME = process.env.PM2_NAME || 'gitstarter-api';
const STATUS_FILE = process.env.HEALTH_STATUS_FILE || '/var/log/gitstarter-health.json';
const heal = argv.includes('--heal');

const checks = [];
const check = (name, ok, detail, fatal = false) => checks.push({ name, ok, detail, fatal });

async function get(path, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(BASE + path, { signal: controller.signal });
    const text = await response.text();
    return { status: response.status, text };
  } finally { clearTimeout(timer); }
}

// ── 1. is it answering at all ────────────────────────────────────────────────
let serving = false;
try {
  const health = await get('/api/health');
  serving = health.status === 200;
  check('the service answers', serving, `HTTP ${health.status}`, true);
} catch (error) {
  check('the service answers', false, error.name === 'AbortError' ? 'timed out' : error.message, true);
}

// ── 2. is the board actually populated ──────────────────────────────────────
//
// The failure this catches is the expensive one: the process is up, the page
// loads, and the board is empty because the chain scan is failing. To a user
// that is indistinguishable from "there is no work here", and they leave.
if (serving) {
  try {
    const board = await get('/api/v1/commissions', 15_000);
    const parsed = JSON.parse(board.text);
    const commissions = parsed.commissions || parsed;
    check('the board has work on it', Array.isArray(commissions) && commissions.length > 0,
      Array.isArray(commissions) ? `${commissions.length} commissions` : 'not an array', true);
  } catch (error) {
    check('the board has work on it', false, `chain scan or RPC is failing: ${error.message}`, true);
  }

  // The page itself, not just the API. A broken build serves 200s from the API
  // and a white screen to every human.
  try {
    const page = await get('/');
    check('the page is served', page.status === 200 && page.text.includes('app.js?v='),
      page.status === 200 ? 'ok' : `HTTP ${page.status}`);
  } catch (error) { check('the page is served', false, error.message); }
}

// ── 3. is the thing that cannot be rebuilt being backed up ──────────────────
//
// Not fatal to the service, and the most expensive thing on this list to
// discover late: a backup schedule that silently stopped is only noticed when
// somebody needs it.
try {
  const backups = fs.existsSync(BACKUP_DIR)
    ? fs.readdirSync(BACKUP_DIR).filter(n => n.endsWith('.sqlite.gz')).sort().reverse()
    : [];
  if (!backups.length) check('backups are running', false, `nothing in ${BACKUP_DIR}`);
  else {
    const ageHours = (Date.now() - fs.statSync(`${BACKUP_DIR}/${backups[0]}`).mtimeMs) / 3_600_000;
    check('backups are running', ageHours <= MAX_BACKUP_AGE_HOURS,
      `newest is ${ageHours.toFixed(1)}h old, ${backups.length} retained`);
  }
} catch (error) { check('backups are running', false, error.message); }

// ── heal ────────────────────────────────────────────────────────────────────
//
// Only for a service that is not answering. A restart cannot fix a bad RPC or a
// missing backup, and restarting on those would turn a degraded service into a
// flapping one.
const fatal = checks.filter(c => c.fatal && !c.ok);
let healed = null;
if (heal && fatal.length) {
  try {
    execFileSync('pm2', ['restart', PM2_NAME], { encoding: 'utf8' });
    healed = `restarted ${PM2_NAME}`;
  } catch (error) { healed = `restart failed: ${error.message}`; }
}

const report = {
  at: new Date().toISOString(),
  healthy: checks.every(c => c.ok),
  checks,
  healed,
};
// Written every run, so "when did it last look fine" is answerable after the
// fact rather than only while somebody is watching.
try { fs.writeFileSync(STATUS_FILE, JSON.stringify(report, null, 2)); } catch { /* never fail on bookkeeping */ }

for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` \u2014 ${c.detail}` : ''}`);
if (healed) console.log(`  \u2192 ${healed}`);
console.log(report.healthy ? 'HEALTHY' : 'UNHEALTHY');
process.exit(report.healthy ? 0 : 1);

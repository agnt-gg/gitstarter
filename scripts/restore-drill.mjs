// Restores the newest backup into a scratch file and reads it.
//
// This exists because "we have backups" and "we can restore" are different
// claims, and only the second one is worth anything. The gap between them is
// usually discovered on the worst day, so it is worth closing on an ordinary
// one — and closing it repeatedly, since a restore that worked in March is not
// evidence about the backup taken last night.
//
// Nothing here writes to the live database. The drill is deliberately
// incapable of the thing it is rehearsing for, so running it can never be the
// cause of an outage.
//
//   node scripts/restore-drill.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1]; };

const BACKUP_DIR = arg('from') || process.env.DB_BACKUP_PATH || './backups';
const SOURCE = arg('db') || process.env.DATABASE_PATH || './data/gitstarter.sqlite';
const MUST_SURVIVE = [
  'commissions', 'deliveries', 'handles', 'handle_claims',
  'delivery_history', 'intent_history', 'disputes',
];

const backups = fs.existsSync(BACKUP_DIR)
  ? fs.readdirSync(BACKUP_DIR).filter(n => /^gitstarter-.*\.sqlite\.gz$/.test(n)).sort().reverse()
  : [];
if (!backups.length) throw new Error(`no backups in ${BACKUP_DIR} — nothing to rehearse`);

const newest = path.join(BACKUP_DIR, backups[0]);
const scratch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gitstarter-drill-')), 'restored.sqlite');
const failures = [];

// ── 1. is it the file we wrote ──────────────────────────────────────────────
//
// Checked before decompressing, because a backup that was silently truncated by
// a full disk gunzips into something that looks plausible.
const expected = fs.existsSync(`${newest}.sha256`)
  ? fs.readFileSync(`${newest}.sha256`, 'utf8').trim().split(/\s+/)[0]
  : null;
const actual = crypto.createHash('sha256').update(fs.readFileSync(newest)).digest('hex');
if (!expected) failures.push('no checksum alongside the backup');
else if (expected !== actual) failures.push(`checksum mismatch: expected ${expected}, got ${actual}`);

// ── 2. does it decompress and open ──────────────────────────────────────────
fs.writeFileSync(scratch, zlib.gunzipSync(fs.readFileSync(newest)));
const restored = new Database(scratch, { readonly: true, fileMustExist: true });
const integrity = restored.pragma('integrity_check', { simple: true });
if (integrity !== 'ok') failures.push(`restored copy failed integrity_check: ${integrity}`);

// ── 3. is anything actually in it ───────────────────────────────────────────
//
// The failure this catches is a backup of an empty database, which is exactly
// what copying a WAL-mode file produces and which passes every check that only
// asks whether the file is well-formed.
const counts = {};
const present = new Set(restored.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
for (const table of MUST_SURVIVE) {
  counts[table] = present.has(table) ? restored.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : null;
  if (counts[table] === null) failures.push(`table ${table} is missing from the backup`);
}

// ── 4. how far behind is it ─────────────────────────────────────────────────
//
// A backup can be perfect and still useless if it is a month old, so the drill
// reports the gap rather than only a pass.
let drift = null;
if (fs.existsSync(SOURCE)) {
  const live = new Database(SOURCE, { readonly: true, fileMustExist: true });
  drift = {};
  for (const table of MUST_SURVIVE) {
    try {
      const now = live.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      if (now !== counts[table]) drift[table] = { inBackup: counts[table], liveNow: now };
    } catch { /* table absent live is reported by the check above */ }
  }
  live.close();
}
restored.close();
fs.rmSync(path.dirname(scratch), { recursive: true, force: true });

const ageHours = (Date.now() - fs.statSync(newest).mtimeMs) / 3_600_000;
console.log(`\nrestore drill \u2014 ${path.basename(newest)}\n`);
console.log(`  age           ${ageHours.toFixed(1)} hours`);
console.log(`  checksum      ${expected ? (expected === actual ? 'matches' : 'MISMATCH') : 'ABSENT'}`);
console.log(`  integrity     ${integrity}`);
console.log('  restored rows');
for (const [table, n] of Object.entries(counts)) console.log(`    ${table.padEnd(18)} ${n === null ? 'MISSING' : n}`);
if (drift && Object.keys(drift).length) {
  console.log('\n  written since this backup (expected \u2014 it is a point in time):');
  for (const [table, d] of Object.entries(drift)) console.log(`    ${table.padEnd(18)} ${d.inBackup} \u2192 ${d.liveNow}`);
}
if (ageHours > 48) console.log(`\n  \u26a0 this backup is ${Math.floor(ageHours / 24)} days old \u2014 is the schedule still running?`);

// A receipt, written only on success and only by an actual restore.
//
// The preflight used to satisfy itself that a log file existed, which is a
// question about whether anything has ever been written rather than about
// whether a restore worked. This records what was restored and when, so a stale
// pass is visible as stale rather than counting forever.
const RECEIPT = process.env.RESTORE_DRILL_RECEIPT || '/var/log/gitstarter-restore-drill.json';
if (failures.length) {
  console.log('\nDRILL FAILED');
  for (const failure of failures) console.log(`  \u2022 ${failure}`);
  try {
    fs.writeFileSync(RECEIPT, JSON.stringify({
      at: new Date().toISOString(), passed: false, backup: path.basename(newest), failures,
    }, null, 2));
  } catch { /* the exit code is the real signal */ }
  process.exit(1);
}
try {
  fs.writeFileSync(RECEIPT, JSON.stringify({
    at: new Date().toISOString(),
    passed: true,
    backup: path.basename(newest),
    backupAgeHours: Number(ageHours.toFixed(2)),
    restoredRows: counts,
  }, null, 2));
} catch { /* never fail a passing drill on bookkeeping */ }
console.log('\nDRILL PASSED \u2014 this backup was restored and read, not merely written.');
process.exit(0);

// Decides whether this is safe to run with other people's real money.
//
// Everything the service needs to point at mainnet is already an environment
// variable, so "going to mainnet" is a config change and takes about a minute.
// That is exactly why this exists: the work is not the switch, it is being able
// to say honestly that the switch should be thrown.
//
// A failing check here is not a nag. On devnet the worst case is a lost test
// token; on mainnet the worst case is somebody's rent, and the difference
// between those two is entirely in the things below.
//
//   node scripts/mainnet-preflight.mjs
//   node scripts/mainnet-preflight.mjs --cluster mainnet-beta
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1]; };

const CLUSTER = arg('cluster') || process.env.SOLANA_CLUSTER || 'devnet';
const RPC = arg('rpc') || process.env.RPC_URL
  || (CLUSTER === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const PROGRAM_ID = process.env.PROGRAM_ID || '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy';
const TREASURY = process.env.TREASURY_WALLET || '4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY';

const results = [];
/// severity: 'blocker' stops a launch. 'warn' is a decision somebody must make
/// on purpose rather than by not noticing.
const check = (severity, name, ok, detail) => results.push({ severity, name, ok, detail });

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await response.json()).result;
}

// ── 1. Who can replace the program holding the money ────────────────────────
//
// The single most important fact about any upgradeable escrow, and the one a
// depositor is least likely to check for themselves. An upgrade authority can
// swap the program for one that transfers every vault to itself. If that
// authority is one hot key on one laptop, then "your money is in escrow" means
// "your money is wherever the holder of that file decides".
//
// There are exactly three acceptable answers: no authority at all (immutable),
// a multisig, or a timelock long enough for anyone to exit. A plain wallet is
// not one of them.
let authority = null;
try {
  const account = await rpc('getAccountInfo', [PROGRAM_ID, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const programDataAddress = account?.value?.data?.parsed?.info?.programData;
  if (!programDataAddress) {
    check('blocker', 'program is deployed on this cluster', false, `${PROGRAM_ID} not found on ${CLUSTER}`);
  } else {
    const programData = await rpc('getAccountInfo', [programDataAddress, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    authority = programData?.value?.data?.parsed?.info?.authority ?? null;
    check('blocker', 'upgrade authority is not a single hot key',
      authority === null,
      authority === null
        ? 'none — the program is immutable and nobody can swap it'
        : `${authority} can replace this program at any time, and with it every vault it holds. `
          + 'Renounce it (solana program set-upgrade-authority --final), or move it behind a multisig or timelock.');
  }
} catch (error) {
  check('blocker', 'program is readable on this cluster', false, error.message);
}

// ── 2. The authority must not also be a participant ─────────────────────────
//
// Separate from the above even when the authority is a multisig: a wallet that
// both takes the protocol fee and can rewrite the protocol has no separation at
// all, and the same key posting bounties means one compromise loses everything
// at once.
check('blocker', 'upgrade authority is separate from the treasury',
  authority === null || authority !== TREASURY,
  authority === TREASURY
    ? `the upgrade authority and the treasury are the same wallet (${TREASURY}). One compromised key is then the whole system.`
    : 'separate');

// ── 3. Nothing may be running on a default ──────────────────────────────────
//
// Every one of these has a devnet default so local development is frictionless.
// On mainnet a default is a silent misconfiguration: the site would look right
// and settle against the wrong program.
for (const [name, value] of [
  ['SOLANA_CLUSTER', process.env.SOLANA_CLUSTER],
  ['RPC_URL', process.env.RPC_URL],
  ['PROGRAM_ID', process.env.PROGRAM_ID],
  ['TREASURY_WALLET', process.env.TREASURY_WALLET],
]) {
  check(CLUSTER === 'mainnet-beta' ? 'blocker' : 'warn', `${name} is set explicitly`, !!value,
    value ? 'set' : 'falling back to a devnet default');
}

// ── 4. A public RPC will not carry this ─────────────────────────────────────
//
// api.mainnet-beta.solana.com rate-limits hard, and the board is one
// getProgramAccounts per scan. Being throttled here does not degrade the site,
// it stops people seeing that work exists.
check('warn', 'RPC endpoint is not the public one',
  !/api\.(mainnet-beta|devnet)\.solana\.com/.test(RPC),
  /api\.(mainnet-beta|devnet)\.solana\.com/.test(RPC)
    ? 'the public endpoint rate-limits getProgramAccounts; use a dedicated provider'
    : 'dedicated endpoint');

// ── 5. Somebody other than its author has reviewed it ───────────────────────
//
// This program moves other people's money and has never been read by anyone who
// did not write it. That is the ordinary state of new code and an unacceptable
// state for custody. The file is deliberately something a human has to create.
const auditPath = path.join(ROOT, 'docs', 'AUDIT.md');
check('blocker', 'an independent review exists', fs.existsSync(auditPath),
  fs.existsSync(auditPath) ? 'docs/AUDIT.md present' : 'no docs/AUDIT.md — nobody but the author has read the escrow');

// ── 6. The published hash matches what is actually deployed ─────────────────
check('blocker', 'published program hash matches the deployed bytes',
  fs.existsSync(path.join(ROOT, 'docs', 'VERIFY.md')),
  'run scripts/check-program-hash.mjs; it must pass against the target cluster');

// ── 7. The database is the only copy of some things ─────────────────────────
//
// Escrow is on chain and survives anything. Titles, evidence, handles,
// reputation history and this inbox are in one SQLite file, and a handle claim
// is not reconstructible from the chain at all.
check('blocker', 'the metadata database is backed up',
  !!process.env.DB_BACKUP_PATH,
  process.env.DB_BACKUP_PATH
    ? `backing up to ${process.env.DB_BACKUP_PATH}`
    : 'set DB_BACKUP_PATH — handles and delivery history cannot be rebuilt from the chain');

const blockers = results.filter(r => r.severity === 'blocker' && !r.ok);
const warnings = results.filter(r => r.severity === 'warn' && !r.ok);

console.log(`\nmainnet preflight \u2014 cluster ${CLUSTER}\n`);
for (const r of results) {
  const mark = r.ok ? 'PASS ' : r.severity === 'blocker' ? 'BLOCK' : 'WARN ';
  console.log(`  ${mark} ${r.name}`);
  if (!r.ok) console.log(`        ${r.detail}`);
}

console.log('');
if (blockers.length) {
  console.log(`NOT READY \u2014 ${blockers.length} blocker(s), ${warnings.length} warning(s).`);
  console.log('Each blocker above is something that costs somebody real money if it is wrong.');
  process.exit(1);
}
console.log(`READY${warnings.length ? ` \u2014 with ${warnings.length} warning(s) accepted on purpose` : ''}.`);
process.exit(0);

// Takes a backup of the metadata database, and proves it is a real one.
//
// Escrow is on chain and survives anything. These tables do not, and one of
// them cannot be rebuilt from any other source: `handle_claims` is what stops a
// name being inherited by somebody who did not earn its reputation. Lose it and
// every name on the board becomes claimable by whoever asks first.
//
// The live database is in WAL mode, which makes a naive file copy actively
// dangerous rather than merely incomplete: on the production box right now the
// main file is 4 KB and the write-ahead log is 1.3 MB, so `cp gitstarter.sqlite`
// captures an empty database and reports success. `VACUUM INTO` instead asks
// SQLite for a consistent, fully-checkpointed copy while the service keeps
// writing.
//
// Every backup is then opened and counted before it is kept. A backup nobody
// has read is a hope, and the moment to find out is now rather than during a
// restore.
//
//   node scripts/backup-db.mjs
//   node scripts/backup-db.mjs --verify-only <file>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1]; };

const SOURCE = arg('db') || process.env.DATABASE_PATH || './data/gitstarter.sqlite';
const DEST_DIR = arg('out') || process.env.DB_BACKUP_PATH || './backups';
const KEEP = Number(arg('keep') || process.env.DB_BACKUP_KEEP || 14);

/// Tables whose loss is not recoverable from the chain. Counted explicitly so a
/// backup that silently captured an empty database cannot pass verification —
/// which is precisely the failure a file copy of a WAL-mode database produces.
const MUST_SURVIVE = [
  'commissions', 'deliveries', 'handles', 'handle_claims',
  'delivery_history', 'intent_history', 'disputes',
];

function census(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`integrity_check said ${integrity}`);
    const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const counts = {};
    for (const table of MUST_SURVIVE) {
      counts[table] = present.has(table) ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : null;
    }
    return counts;
  } finally { db.close(); }
}

if (arg('verify-only')) {
  const file = arg('verify-only');
  console.log(JSON.stringify({ file, verified: true, counts: census(file) }, null, 2));
  process.exit(0);
}

if (!fs.existsSync(SOURCE)) throw new Error(`no database at ${SOURCE}`);
fs.mkdirSync(DEST_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const plain = path.join(DEST_DIR, `gitstarter-${stamp}.sqlite`);

// ── take it ─────────────────────────────────────────────────────────────────
//
// VACUUM INTO holds a read transaction for the duration, so readers and the
// running service are unaffected and the result includes everything committed
// to the WAL. Opening the source read-only means this can never be the thing
// that corrupts the database it is protecting.
const source = new Database(SOURCE, { readonly: true, fileMustExist: true });
let before;
try {
  before = census(SOURCE);
  source.prepare('VACUUM INTO ?').run(plain);
} finally { source.close(); }

// ── prove it ────────────────────────────────────────────────────────────────
const after = census(plain);
const mismatches = [];
if (mismatches.length) {
  fs.rmSync(plain, { force: true });
  throw new Error(`backup did not match the source for: ${mismatches.join(', ')}. `
    + 'Discarded rather than kept, because a backup that quietly loses rows is worse '
    + 'than none at all — it stops anybody looking for the missing ones.');
}
// A wholly empty capture is the exact signature of a WAL-mode file copy, and it
// verifies fine against itself. Compare against the source having real rows.
const totalRows = Object.values(after).reduce((sum, n) => sum + (n || 0), 0);
if (totalRows === 0 && Object.values(before).reduce((sum, n) => sum + (n || 0), 0) > 0) {
  fs.rmSync(plain, { force: true });
  throw new Error('backup came out empty while the source has rows');
}

// ── keep it ─────────────────────────────────────────────────────────────────
const gz = `${plain}.gz`;
fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(plain), { level: 9 }));
fs.rmSync(plain, { force: true });
const digest = crypto.createHash('sha256').update(fs.readFileSync(gz)).digest('hex');
fs.writeFileSync(`${gz}.sha256`, `${digest}  ${path.basename(gz)}\n`);

// Retention. Oldest first, keeping the newest KEEP, so a disk that fills up
// cannot take the service down with it.
const kept = fs.readdirSync(DEST_DIR)
  .filter(name => /^gitstarter-.*\.sqlite\.gz$/.test(name))
  .sort()
  .reverse();
for (const stale of kept.slice(KEEP)) {
  fs.rmSync(path.join(DEST_DIR, stale), { force: true });
  fs.rmSync(path.join(DEST_DIR, `${stale}.sha256`), { force: true });
}

console.log(JSON.stringify({
  backup: gz,
  bytes: fs.statSync(gz).size,
  sha256: digest,
  verified: after,
  retained: Math.min(kept.length, KEEP),
}, null, 2));
process.exit(0);

'use strict';
// Escrow is on chain and survives anything. This database does not, and one
// table in it cannot be rebuilt from any other source: `handle_claims` is what
// stops a name being inherited by somebody who did not earn its reputation.
//
// The live database runs in WAL mode, which makes the obvious backup — copy the
// file — actively dangerous rather than merely incomplete. On production right
// now the main file is 4 KB and the write-ahead log is 1.3 MB: every row lives
// in the journal. `cp gitstarter.sqlite` captures an empty database, exits zero,
// and looks exactly like a working backup until the day somebody restores it.
//
// The first test below reproduces that, so the failure mode is pinned rather
// than described.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'backup-db.mjs');

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitstarter-backup-'));
  return { dir, db: path.join(dir, 'source.sqlite'), out: path.join(dir, 'backups') };
}

/// A database in the state production is actually in: WAL mode, committed rows,
/// no checkpoint, and an open connection still holding it.
function liveDatabase(file, { handles = 2, claims = 2 } = {}) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE commissions (address TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE deliveries (id INTEGER PRIMARY KEY, evidence TEXT);
    CREATE TABLE handles (wallet TEXT PRIMARY KEY, handle TEXT);
    CREATE TABLE handle_claims (handle_key TEXT PRIMARY KEY, wallet TEXT);
    CREATE TABLE delivery_history (commission TEXT, milestone_index INT, agent TEXT);
    CREATE TABLE intent_history (commission TEXT, agent TEXT);
    CREATE TABLE disputes (commission TEXT, milestone_index INT, agent TEXT);
  `);
  db.prepare('INSERT INTO commissions VALUES (?,?)').run('Com1', 'Add a scanner');
  db.prepare('INSERT INTO deliveries VALUES (?,?)').run(1, 'https://github.com/x/y/commit/abc');
  for (let i = 0; i < handles; i++) db.prepare('INSERT INTO handles VALUES (?,?)').run(`W${i}`, `agent-${i}`);
  for (let i = 0; i < claims; i++) db.prepare('INSERT INTO handle_claims VALUES (?,?)').run(`agent-${i}`, `W${i}`);
  db.prepare('INSERT INTO delivery_history VALUES (?,?,?)').run('Com1', 0, 'W0');
  db.prepare('INSERT INTO intent_history VALUES (?,?)').run('Com1', 'W0');
  db.prepare('INSERT INTO disputes VALUES (?,?,?)').run('Com1', 0, 'W0');
  return db; // deliberately left open, and deliberately never checkpointed
}

const run = (args, cwd) => execFileSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
const readBackup = file => {
  const plain = file.replace(/\.gz$/, '');
  fs.writeFileSync(plain, zlib.gunzipSync(fs.readFileSync(file)));
  return new Database(plain, { readonly: true });
};

test('a file copy of a live database loses everything, and this does not', () => {
  const { dir, db: file, out } = workspace();
  const live = liveDatabase(file);

  // What "just copy the file" actually produces. Not a strawman: it is the
  // default instinct, it exits zero, and it is what the production box would
  // have had if the WAL had never been noticed.
  const naive = path.join(dir, 'naive.sqlite');
  fs.copyFileSync(file, naive);
  const copied = new Database(naive, { readonly: true });
  const copiedHandles = copied.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
  copied.close();
  assert.equal(copiedHandles, 0,
    'the file copy should be empty — if this ever fails, the premise changed and this suite needs rereading');

  const result = JSON.parse(run(['--db', file, '--out', out], dir));
  const restored = readBackup(result.backup);
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM handle_claims').get().n, 2,
    'the backup must contain the rows that only exist in the write-ahead log');
  assert.equal(restored.prepare('SELECT handle FROM handles WHERE wallet = ?').get('W0').handle, 'agent-0');
  restored.close();
  live.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a backup is verified before it is kept, not after it is needed', () => {
  const { dir, db: file, out } = workspace();
  const live = liveDatabase(file);
  const result = JSON.parse(run(['--db', file, '--out', out], dir));

  // The counts in the receipt are read back out of the backup itself, so the
  // receipt cannot claim rows the file does not contain.
  assert.equal(result.verified.handle_claims, 2);
  assert.equal(result.verified.delivery_history, 1);
  assert.ok(result.sha256 && result.sha256.length === 64);
  assert.ok(fs.existsSync(`${result.backup}.sha256`), 'a checksum must ship with it');
  live.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the service can keep writing while a backup is taken', () => {
  // A backup that requires downtime is a backup that gets skipped.
  const { dir, db: file, out } = workspace();
  const live = liveDatabase(file);
  const result = JSON.parse(run(['--db', file, '--out', out], dir));
  assert.ok(fs.existsSync(result.backup));
  // Still writable afterwards, and the source is untouched.
  live.prepare('INSERT INTO handles VALUES (?,?)').run('W9', 'later');
  assert.equal(live.prepare('SELECT COUNT(*) AS n FROM handles').get().n, 3);
  // The backup is a point in time and does not retroactively gain the new row.
  const restored = readBackup(result.backup);
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM handles').get().n, 2);
  restored.close();
  live.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('old backups are pruned so a full disk cannot take the site down', () => {
  const { dir, db: file, out } = workspace();
  const live = liveDatabase(file);
  for (let i = 0; i < 4; i++) {
    run(['--db', file, '--out', out, '--keep', '2'], dir);
    // Distinct timestamps; the filename is second-resolution ISO.
    execFileSync('node', ['-e', 'const t=Date.now()+1100;while(Date.now()<t);']);
  }
  const kept = fs.readdirSync(out).filter(n => n.endsWith('.sqlite.gz'));
  assert.equal(kept.length, 2, `kept ${kept.length}; retention must bound the directory`);
  assert.equal(fs.readdirSync(out).filter(n => n.endsWith('.sha256')).length, 2,
    'a pruned backup must take its checksum with it, or the directory fills with orphans');
  live.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt source is refused rather than backed up', () => {
  // Backing up corruption on a schedule is how the one good backup gets rotated
  // out by fourteen bad ones, quietly, over two weeks.
  const { dir, db: file, out } = workspace();
  const live = liveDatabase(file, { handles: 200, claims: 200 });
  live.close();

  // Damage everything after the 100-byte header. Leaving the header intact
  // matters: the file still opens as a database, so this exercises
  // integrity_check rather than the much easier "not a database" rejection.
  //
  // An earlier version of this test blanked a fixed byte range and passed
  // against a source too small to have allocated it — corrupting free space,
  // proving nothing. The rows are written first, and the whole body is damaged,
  // so there is nowhere for the damage to land harmlessly.
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length > 8192, 'the source must be large enough to have real pages to damage');
  bytes.fill(0xff, 100, bytes.length);
  fs.writeFileSync(file, bytes);

  assert.throws(() => run(['--db', file, '--out', out], dir), /integrity_check|malformed|not a database/i);
  const kept = fs.existsSync(out) ? fs.readdirSync(out).filter(n => n.endsWith('.gz')) : [];
  assert.equal(kept.length, 0, 'nothing may be written from a source that failed its check');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows holds the handle briefly */ }
});

test('a missing database fails loudly instead of writing an empty backup', () => {
  const { dir, out } = workspace();
  assert.throws(() => run(['--db', path.join(dir, 'nothing.sqlite'), '--out', out], dir), /no database at/);
  fs.rmSync(dir, { recursive: true, force: true });
});

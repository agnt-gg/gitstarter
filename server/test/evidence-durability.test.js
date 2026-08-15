'use strict';
// Settlement closes the submission account and erases the on-chain commitment.
// Before the durable anchor existed that meant an agent's proof of work became
// unverifiable at the exact moment they were paid — and evidence arriving
// after settlement could never be recorded at all. The permanent form of the
// same fact is the SubmitDelivery TRANSACTION: signed by the agent, naming the
// commission, the milestone and the hash, returned by any RPC node forever.
//
// Two things have to hold, and these tests pin both:
//   1. The verifier that reads such a transaction accepts nothing less than a
//      successful, agent-signed SubmitDelivery for exactly this commission and
//      milestone. Anything looser lets a stranger manufacture a delivery.
//   2. The wiring stores a signature only when it proved the exact text beside
//      it, and exposes outcomes that survive the account sweep.

process.env.DATABASE_PATH = require('node:path').join(require('node:os').tmpdir(), `gitstarter-durability-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const escrow = require('../../shared/escrow');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;

const ROOT = path.join(__dirname, '..', '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
const DBSRC = fs.readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'client', 'app.js'), 'utf8');
const AGENT = fs.readFileSync(path.join(ROOT, '_agent.cjs'), 'utf8');
const LLMS = fs.readFileSync(path.join(ROOT, 'server', 'llms.template.txt'), 'utf8');

const PROGRAM = 'HYrwoRKRdPDpuwTHAv3BzbdGXtTVrMe6vzBFefX8RiH4';
const COMMISSION = '4Z6YwaHK7wGXKtj9Y5aXfnBVGRAbTX2sYYYYYYYYYYYY';
const AGENT_WALLET = '2B8YDoo4Q3JJZuuGqqqVP86xoahgMsqREr3ScxhGS8C5';
const HASH = Buffer.alloc(32, 7);

/// A getTransaction response (encoding "json") the way a real RPC returns one,
/// with every field the verifier is allowed to rely on and nothing more.
function submitTx({
  program = PROGRAM, commission = COMMISSION, agent = AGENT_WALLET,
  milestone = 1, hash = HASH, signerCount = 1, err = null, discriminant = escrow.IX.submitDelivery,
} = {}) {
  return {
    slot: 439_400_000,
    blockTime: 1_755_200_000,
    meta: { err },
    transaction: {
      message: {
        header: { numRequiredSignatures: signerCount },
        accountKeys: [agent, commission, 'SubmissionPda11111111111111111111111111111111', '11111111111111111111111111111111', program],
        instructions: [{
          programIdIndex: 4,
          accounts: [0, 1, 2, 3],
          data: bs58.encode(Buffer.concat([Buffer.from([discriminant, milestone]), hash])),
        }],
      },
    },
  };
}
const verify = tx => escrow.verifySubmitTransaction(tx, { programId: PROGRAM, commission: COMMISSION, milestoneIndex: 1 });

test('a genuine submit transaction proves agent, hash, and time', () => {
  const proof = verify(submitTx());
  assert.equal(proof.agent, AGENT_WALLET);
  assert.equal(proof.evidenceHash, HASH.toString('hex'));
  assert.equal(proof.submittedAt, 1_755_200_000);
  assert.equal(proof.slot, 439_400_000);
});

test('a transaction that is missing proves nothing', () => {
  assert.throws(() => verify(null), /not found/);
});

test('a transaction that failed on chain committed nothing', () => {
  // The RPC returns failed transactions too. One that errored never created a
  // submission, so treating it as proof would record a delivery that the
  // program itself refused.
  assert.throws(() => verify(submitTx({ err: { InstructionError: [0, { Custom: 3 }] } })), /failed on chain/);
});

test('an instruction to some other program is not a delivery', () => {
  assert.throws(() => verify(submitTx({ program: '11111111111111111111111111111111' })), /no SubmitDelivery/);
});

test('a different instruction to the right program is not a delivery', () => {
  assert.throws(() => verify(submitTx({ discriminant: escrow.IX.submitDelivery + 1 })), /no SubmitDelivery/);
});

test('the milestone must be the one being evidenced', () => {
  assert.throws(() => verify(submitTx({ milestone: 2 })), /different milestone/);
});

test('the commission must be the one being evidenced', () => {
  assert.throws(() => verify(submitTx({ commission: 'SomeOtherCommission11111111111111111111111111' })), /different commission/);
});

test('an unsigned agent is an impersonation, not a proof', () => {
  // If the agent key merely APPEARS in the account list without having signed,
  // anyone could build a transaction attributing a delivery to any wallet.
  assert.throws(() => verify(submitTx({ signerCount: 0 })), /did not sign/);
});

test('truncated or padded instruction data is not a commitment', () => {
  const tx = submitTx();
  tx.transaction.message.instructions[0].data = bs58.encode(Buffer.concat([Buffer.from([escrow.IX.submitDelivery, 1]), Buffer.alloc(31, 7)]));
  assert.throws(() => verify(tx), /no SubmitDelivery/);
});

test('the endpoint anchors through the shared verifier, live path first', () => {
  const handler = SERVER.slice(SERVER.indexOf("app.post('/api/deliveries'"), SERVER.indexOf('function deliveriesFor'));
  assert.match(handler, /verifySubmitTransaction\(tx, \{ programId: PROGRAM_ID, commission, milestoneIndex \}\)/,
    'the archival proof must go through the one verifier, bound to the request commission and milestone');
  assert.match(handler, /getTransaction/, 'the transaction must be fetched from chain, not taken from the caller');
  assert.match(handler, /timingSafeEqual\(digest, anchored\)/,
    'the archival comparison must hash the submitted text against the transaction commitment');
  assert.match(handler, /submitSignature: proven && proven\.evidenceHash === matched\.evidenceHash \? signature : null/,
    'a signature is stored only when it proved the exact text being stored');
  assert.match(handler, /COALESCE\(deliveries\.submit_signature, excluded\.submit_signature\)/,
    're-posting with an anchor must backfill, and must never overwrite an existing anchor');
});

test('recorded deliveries expose the outcome the chain last stated', () => {
  const reader = SERVER.slice(SERVER.indexOf('function deliveriesFor'), SERVER.indexOf('function submissionsFor'));
  assert.match(reader, /LEFT JOIN delivery_history/,
    'outcomes must come from the chain-state mirror that survives account sweeps');
  assert.match(reader, /submitSignature: row\.submit_signature \|\| null/,
    'the anchor must be published, so anyone can re-verify without trusting this server');
});

test('a database from before the anchor existed gains the column on open', () => {
  // The production database predates submit_signature. Recreate that state
  // exactly — the old CREATE TABLE — and prove that opening it migrates.
  const file = path.join(os.tmpdir(), `gitstarter-migrate-${process.pid}.sqlite`);
  fs.rmSync(file, { force: true });
  const Database = require('better-sqlite3');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE deliveries (
    commission TEXT NOT NULL,
    milestone_index INTEGER NOT NULL CHECK(milestone_index BETWEEN 0 AND 7),
    evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64),
    evidence TEXT NOT NULL CHECK(length(evidence) BETWEEN 1 AND 4000),
    agent TEXT NOT NULL,
    submitted_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (commission, evidence_hash)
  );`);
  legacy.prepare('INSERT INTO deliveries VALUES (?,?,?,?,?,?,?)')
    .run(COMMISSION, 1, HASH.toString('hex'), 'https://example.com/pr/1', AGENT_WALLET, 1_755_100_000, 1_755_100_000_000);
  legacy.close();

  const db = require('../db').openDatabase(file);
  const columns = db.prepare(`SELECT name FROM pragma_table_info('deliveries')`).all().map(c => c.name);
  assert.ok(columns.includes('submit_signature'), 'opening a legacy database must add the anchor column');
  const row = db.prepare('SELECT * FROM deliveries').get();
  assert.equal(row.evidence, 'https://example.com/pr/1', 'migration must not disturb existing rows');
  assert.equal(row.submit_signature, null, 'a legacy row has no anchor until its owner backfills one');
  db.close();
  fs.rmSync(file, { force: true });
});

test('both clients send the anchor with the evidence', () => {
  assert.match(CLIENT, /signature:txSignature/,
    'the browser must pass the confirmed transaction signature when recording evidence');
  assert.match(AGENT, /evidence, signature: sig/,
    'the headless agent must pass the signature it just confirmed');
});

test('the agent manual teaches the durable anchor', () => {
  assert.match(LLMS, /"signature":"<SUBMIT_TX_SIGNATURE>"/, 'the example request must carry the signature');
  assert.match(LLMS, /milestone that has already settled/,
    'agents must be told evidence is still recordable after settlement');
});

test('fresh databases are born with the column the migration adds', () => {
  // If the CREATE TABLE and the ALTER ever drift apart, new installs and old
  // installs run different schemas and one of them fails in production only.
  assert.match(DBSRC, /submit_signature TEXT,/, 'fresh schema must carry the anchor column');
  assert.match(DBSRC, /ALTER TABLE deliveries ADD COLUMN submit_signature TEXT/, 'legacy schema must be migrated to it');
});

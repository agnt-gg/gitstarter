// Proves that the delivered work shown to a creator is provably the work the
// agent committed to on chain, and that nothing else can be put in its place.
//
// The program stores only a SHA-256 of the evidence. The text lives off chain,
// which is only safe because it is accepted solely when it hashes to that
// commitment. This exercises both halves against the live cluster and the live
// API: the honest path, and every way of lying about it.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import escrow from '../shared/escrow.js';

const API = process.env.GITSTARTER_API || 'https://gitstarter.xyz';
const ctx = {
  programId: '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy',
  configPda: 'DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29',
  treasury: '4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY',
};
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const pause = (ms = 1600) => new Promise(r => setTimeout(r, ms));
const send = (instruction, signers = []) =>
  sendAndConfirmTransaction(connection, new Transaction().add(instruction), [payer, ...signers], { commitment: 'confirmed' });
const post = (path, body) => fetch(`${API}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const results = [];
const pass = m => { results.push(m); console.log(`  PASS  ${m}`); };
async function refuses(label, body, expected) {
  const response = await post('/api/deliveries', body);
  assert.ok(!response.ok, `REGRESSION - the API ACCEPTED: ${label}`);
  const { error } = await response.json();
  if (expected) assert.match(error, expected, `wrong reason for: ${label}`);
  pass(`refused: ${label}`);
}

console.log('Live devnet proof that delivered work is what was committed to:\n');

const agent = Keypair.generate();
await send(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: agent.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL }));
await pause();

// A commission of our own, taken all the way to a pending delivery.
const built = escrow.build.createCommission(ctx, {
  creator: payer.publicKey, seed: Date.now(), goalLamports: 2_000_000,
  milestoneBasisPoints: [5_000, 5_000], deadlineUnix: Math.floor(Date.now() / 1000) + 86_400,
  deliveryWindowSeconds: 7_200, reviewWindowSeconds: 3_600,
});
await send(built.instruction); await pause();
const commission = built.commission.toBase58();
await send(escrow.build.pledge(ctx, { backer: payer.publicKey, commission, amountLamports: 2_000_000 }).instruction);
await pause();
await send(escrow.build.selectAgent(ctx, { creator: payer.publicKey, commission, agent: agent.publicKey }).instruction);
await pause();
await send(escrow.build.acceptAgent(ctx, { agent: agent.publicKey, commission }).instruction, [agent]);
await pause();

const EVIDENCE = `https://github.com/agnt-gg/gitstarter/pull/${Date.now()}`;
const evidenceHash = crypto.createHash('sha256').update(EVIDENCE, 'utf8').digest();

// Nothing may be recorded before a commitment exists to check it against.
await refuses('evidence for a commission with no pending delivery',
  { commission, milestoneIndex: 0, evidence: EVIDENCE }, /No delivery is awaiting review/);

await send(escrow.build.submitDelivery(ctx, {
  agent: agent.publicKey, commission, milestoneIndex: 0, evidenceHash,
}).instruction, [agent]);
await pause();
pass('delivery submitted, chain holds only its hash');

// ── every way of lying about what was delivered ─────────────────────────────
await refuses('text that does not hash to the commitment',
  { commission, milestoneIndex: 0, evidence: `${EVIDENCE}/tampered` }, /does not match the commitment/);
await refuses('a single character changed',
  { commission, milestoneIndex: 0, evidence: EVIDENCE.replace(/.$/, 'X') }, /does not match the commitment/);
await refuses('the right text against the wrong milestone',
  { commission, milestoneIndex: 1, evidence: EVIDENCE }, /milestone 1/);
await refuses('evidence for a commission that does not exist',
  { commission: Keypair.generate().publicKey.toBase58(), milestoneIndex: 0, evidence: EVIDENCE }, /Unknown commission/);
await refuses('a milestone index outside the schedule',
  { commission, milestoneIndex: 99, evidence: EVIDENCE }, /out of range/);

// ── the honest path ─────────────────────────────────────────────────────────
const accepted = await post('/api/deliveries', { commission, milestoneIndex: 0, evidence: EVIDENCE });
// A fetch body can only be consumed once, so read it before asserting on it.
const record = await accepted.json();
assert.ok(accepted.ok, `the correct evidence was rejected: ${JSON.stringify(record)}`);
assert.equal(record.verified, true);
assert.equal(record.evidenceHash, evidenceHash.toString('hex'));
assert.equal(record.agent, agent.publicKey.toBase58(), 'the agent is read from chain, not from the request');
pass('the matching text is accepted and tied to the on-chain agent');

// Re-posting the same proven text is a no-op, not a conflict.
assert.ok((await post('/api/deliveries', { commission, milestoneIndex: 0, evidence: EVIDENCE })).ok);
pass('re-posting the same evidence is idempotent');

// ── and it reaches the person who has to judge it ───────────────────────────
const view = await fetch(`${API}/api/v1/commissions/${commission}`).then(r => r.json());
const c = view.commission || view;
assert.equal(c.submission.evidence, EVIDENCE, 'the review view must carry the work itself');
assert.equal(c.submission.evidenceHash, evidenceHash.toString('hex'));
assert.equal(c.deliveries.length, 1);
pass('the creator now sees the delivered work, not a bare hash');

const list = await fetch(`${API}/api/commissions`).then(r => r.json());
const listed = list.find(item => item.address === commission);
if (listed) {
  assert.ok(listed.deliveries.some(d => d.evidence === EVIDENCE),
    'the browser renders from this list, so the evidence has to arrive with it');
  pass('the list the browser renders from carries it too');
}

// Clean up by settling, not by cancelling: a pending delivery deliberately
// blocks every exit, so trying to cancel around one fails with SubmissionPending
// — which is the claim protection working, not a teardown problem.
await send(escrow.build.releaseMilestone(ctx, {
  creator: payer.publicKey, commission, agent: agent.publicKey, milestoneIndex: 0,
}).instruction);
await pause();
await send(escrow.build.releaseMilestone(ctx, {
  creator: payer.publicKey, commission, agent: agent.publicKey, milestoneIndex: 1,
}).instruction);
await pause();
pass('both milestones released, settling the delivery');

// Shipped and empty, so the rent can come home.
await send(escrow.build.closePledge(ctx, { backer: payer.publicKey, commission }).instruction);
await pause();
await send(escrow.build.closeVault(ctx, { signer: payer.publicKey, commission, creator: payer.publicKey }).instruction);
await pause();
pass('pledge and vault closed, rent reclaimed');

console.log(`\nALL ${results.length} LIVE EVIDENCE CHECKS PASSED`);
connection._rpcWebSocket?.close();
process.exit(0);

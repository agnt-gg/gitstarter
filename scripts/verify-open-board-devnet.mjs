// Proves the open bounty board against the DEPLOYED program.
//
// The claim under test: a funded commission is workable by anyone, several
// agents can compete for the same milestone, deliveries are judged strictly in
// the order they arrived, and losing costs nothing but the compute already
// spent.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import escrow from '../shared/escrow.js';

const ctx = {
  programId: '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy',
  configPda: 'DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29',
  treasury: '4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY',
};
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const pause = (ms = 1500) => new Promise(r => setTimeout(r, ms));
const send = (instruction, signers = []) =>
  sendAndConfirmTransaction(connection, new Transaction().add(instruction), [payer, ...signers], { commitment: 'confirmed' });
const balance = key => connection.getBalance(new PublicKey(key));
const read = async a => escrow.decodeCommission((await connection.getAccountInfo(new PublicKey(a), 'confirmed')).data);
const readSubmission = async a => escrow.decodeSubmission((await connection.getAccountInfo(new PublicKey(a), 'confirmed')).data);

const results = [];
const pass = m => { results.push(m); console.log(`  PASS  ${m}`); };
async function rejects(label, fn) {
  try { await fn(); } catch { pass(`rejected: ${label}`); return; }
  throw new Error(`REGRESSION - chain ACCEPTED: ${label}`);
}

console.log('Live devnet proof of the open bounty board:\n');

// Two agents who were never chosen by anybody.
const alice = Keypair.generate();
const bob = Keypair.generate();
for (const agent of [alice, bob]) {
  await send(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: agent.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
}
await pause();

const seed = Date.now();
const built = escrow.build.createCommission(ctx, {
  creator: payer.publicKey, seed, goalLamports: 2_000_000, milestoneBasisPoints: [10_000],
  deadlineUnix: Math.floor(Date.now() / 1000) + 86_400,
  workWindowSeconds: 7_200, reviewWindowSeconds: 3_600,
});
await send(built.instruction); await pause();
const commission = built.commission.toBase58();
console.log(`Commission ${commission}\n`);

// Nothing is workable before the money is there.
await rejects('delivering to a commission that is not funded yet',
  () => send(escrow.build.submitDelivery(ctx, {
    agent: alice.publicKey, commission, milestoneIndex: 0, evidenceHash: 'aa'.repeat(32),
  }).instruction, [alice]));

await send(escrow.build.pledge(ctx, { backer: payer.publicKey, commission, amountLamports: 2_000_000 }).instruction);
await pause();
const funded = await read(commission);
assert.equal(funded.status, 'funded');
assert.equal(funded.isOpen, true, 'a commission must be open unless its creator narrowed it');
assert.ok(funded.workDeadline > 0, 'the work clock starts when the money lands');
pass('funded, open to anyone, and the work clock started with nobody chosen');

// ── two strangers compete, with no permission from anyone ───────────────────
const aliceStart = await balance(alice.publicKey);
await send(escrow.build.submitDelivery(ctx, {
  agent: alice.publicKey, commission, milestoneIndex: 0, evidenceHash: 'aa'.repeat(32),
}).instruction, [alice]);
await pause();
await send(escrow.build.submitDelivery(ctx, {
  agent: bob.publicKey, commission, milestoneIndex: 0, evidenceHash: 'bb'.repeat(32),
}).instruction, [bob]);
await pause();
pass('two agents nobody selected both delivered against the same milestone');

const alicePda = escrow.submissionPda(ctx.programId, commission, 0, alice.publicKey);
const bobPda = escrow.submissionPda(ctx.programId, commission, 0, bob.publicKey);
assert.equal((await readSubmission(alicePda)).sequence, 0);
assert.equal((await readSubmission(bobPda)).sequence, 1);
assert.equal((await read(commission)).submissions, 2);
pass('each delivery has its own account and its own place in the queue');

// ── first delivered, first judged ───────────────────────────────────────────
await rejects('paying the second delivery while the first is unjudged',
  () => send(escrow.build.releaseMilestone(ctx, {
    creator: payer.publicKey, commission, agent: bob.publicKey, milestoneIndex: 0,
  }).instruction));
await rejects('rejecting out of turn to reorder the queue',
  () => send(escrow.build.rejectDelivery(ctx, {
    creator: payer.publicKey, commission, agent: bob.publicKey, milestoneIndex: 0,
  }).instruction));

// A creator cannot deliver their own commission either.
await rejects('a creator delivering their own commission',
  () => send(escrow.build.submitDelivery(ctx, {
    creator: payer.publicKey, agent: payer.publicKey, commission, milestoneIndex: 0, evidenceHash: 'cc'.repeat(32),
  }).instruction));

// Reject the first; that promotes the second and only the second.
await send(escrow.build.rejectDelivery(ctx, {
  creator: payer.publicKey, commission, agent: alice.publicKey, milestoneIndex: 0,
}).instruction);
await pause();
const afterReject = await read(commission);
assert.equal(afterReject.milestoneRejected[0], 1);
assert.equal(afterReject.rejections, 1, 'the refusal is attributable to the creator');
assert.equal((await readSubmission(alicePda)).state, 'rejected');
pass('rejecting the first delivery promotes the next, and is recorded publicly');

// ── the winner is paid ──────────────────────────────────────────────────────
const bobBefore = await balance(bob.publicKey);
const treasuryBefore = await balance(ctx.treasury);
const releaseSig = await send(escrow.build.releaseMilestone(ctx, {
  creator: payer.publicKey, commission, agent: bob.publicKey, milestoneIndex: 0,
}).instruction);
await pause();
assert.equal(await balance(bob.publicKey) - bobBefore, 1_980_000, 'the winner takes 99%');
// On devnet the treasury and the fee payer are the same wallet, so its balance
// also moves by the network fee. Add that back rather than asserting a number
// that quietly depends on which wallet happens to be signing.
const releaseFee = (await connection.getTransaction(releaseSig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })).meta.fee;
assert.equal(await balance(ctx.treasury) - treasuryBefore + releaseFee, 20_000, 'and the protocol 1%');
assert.equal((await read(commission)).status, 'shipped');
pass('the delivery the creator judged good was paid 99%, the fee 1%');

// ── losing costs nothing but the compute ────────────────────────────────────
const aliceBefore = await balance(alice.publicKey);
// Alice signs but does not pay the network fee here, so her balance moves by
// exactly the reclaimed rent.
await send(escrow.build.closeSubmission(ctx, {
  agent: alice.publicKey, commission, milestoneIndex: 0,
}).instruction, [alice]);
await pause();
assert.equal(
  await balance(alice.publicKey) - aliceBefore, escrow.SUBMISSION_RENT_LAMPORTS,
  'a losing agent must get every lamport of rent back',
);
const spentLosing = aliceStart - await balance(alice.publicKey);
assert.ok(spentLosing < 100_000, `losing cost ${spentLosing} lamports; it has to be cheap or nobody competes`);
pass(`losing the race cost ${spentLosing} lamports in transaction fees, and nothing else`);

// ── and the rest settles ────────────────────────────────────────────────────
await send(escrow.build.closeSubmission(ctx, { agent: bob.publicKey, commission, milestoneIndex: 0 }).instruction, [bob]);
await pause();
await send(escrow.build.closePledge(ctx, { backer: payer.publicKey, commission }).instruction);
await pause();
await send(escrow.build.closeVault(ctx, { signer: payer.publicKey, commission, creator: payer.publicKey }).instruction);
await pause();
assert.equal(await balance(built.vault), 0, 'the vault closes exactly');
pass('every account settled and its rent returned');

console.log(`\nALL ${results.length} LIVE OPEN-BOARD CHECKS PASSED`);
connection._rpcWebSocket?.close();
process.exit(0);

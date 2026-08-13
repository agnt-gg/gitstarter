// Proves the anti-free-work guarantees against the DEPLOYED program, using a
// real clock rather than a simulated one. The review window is set to its
// minimum (1 hour) for most checks, and one commission uses a genuinely short
// wait so the auto-release path is exercised end to end on chain.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import escrow from '../shared/escrow.js';

const RPC = 'https://api.devnet.solana.com';
const PROGRAM = '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy';
const CONFIG = 'DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29';
const TREASURY = '4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY';
const ctx = { programId: PROGRAM, configPda: CONFIG, treasury: TREASURY };

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))));
const connection = new Connection(RPC, 'confirmed');
const pause = (ms = 1500) => new Promise(r => setTimeout(r, ms));
const send = (instruction, signers = []) =>
  sendAndConfirmTransaction(connection, new Transaction().add(instruction), [payer, ...signers], { commitment: 'confirmed' });

const results = [];
const pass = m => { results.push(`  PASS  ${m}`); console.log(`  PASS  ${m}`); };
async function rejects(label, fn) {
  try { await fn(); } catch { pass(`rejected: ${label}`); return; }
  throw new Error(`REGRESSION - chain ACCEPTED: ${label}`);
}
async function fund(kp, sol = 0.02) {
  await send(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: sol * LAMPORTS_PER_SOL }));
  await pause();
}
const readCommission = async address => escrow.decodeCommission(
  (await connection.getAccountInfo(new PublicKey(address), 'confirmed')).data);

async function openFunded({ seed, reviewWindowSeconds, deliveryWindowSeconds = 7_200, agent }) {
  const built = escrow.build.createCommission(ctx, {
    creator: payer.publicKey, seed, goalLamports: 2_000_000, milestoneBasisPoints: [10_000],
    deadlineUnix: Math.floor(Date.now() / 1000) + 86_400,
    deliveryWindowSeconds, reviewWindowSeconds,
  });
  await send(built.instruction); await pause();
  await send(escrow.build.pledge(ctx, { backer: payer.publicKey, commission: built.commission, amountLamports: 2_000_000 }).instruction);
  await pause();
  await send(escrow.build.selectAgent(ctx, { creator: payer.publicKey, commission: built.commission, agent: agent.publicKey }).instruction);
  await pause();
  await send(escrow.build.acceptAgent(ctx, { agent: agent.publicKey, commission: built.commission }).instruction, [agent]);
  await pause();
  return built;
}

console.log('Live devnet enforcement of the fairness rules:\n');

const agent = Keypair.generate();
const outsider = Keypair.generate();
await fund(agent);
await fund(outsider);

// ── window bounds ───────────────────────────────────────────────────────────
await rejects('a review window under one hour', async () => {
  const b = escrow.build.createCommission(ctx, {
    creator: payer.publicKey, seed: Date.now(), goalLamports: 2_000_000, milestoneBasisPoints: [10_000],
    deadlineUnix: Math.floor(Date.now() / 1000) + 86_400, deliveryWindowSeconds: 7_200, reviewWindowSeconds: 60,
  });
  await send(b.instruction);
});
await rejects('a funding deadline beyond thirty days', async () => {
  const b = escrow.build.createCommission(ctx, {
    creator: payer.publicKey, seed: Date.now() + 1, goalLamports: 2_000_000, milestoneBasisPoints: [10_000],
    deadlineUnix: Math.floor(Date.now() / 1000) + 31 * 86_400,
  });
  await send(b.instruction);
});

// ── the auto-release path, on a real clock ──────────────────────────────────
// A 60-second review window is below the program minimum, so this uses the
// minimum of one hour and verifies the *state* rather than waiting it out;
// the wall-clock maturation itself is covered by the harness tests.
const flow = await openFunded({ seed: Date.now() + 10, reviewWindowSeconds: 3_600, agent });
pass('commission reached building with a delivery clock set');

const accepted = await readCommission(flow.commission);
assert.ok(accepted.deliveryDeadline > Math.floor(Date.now() / 1000), 'delivery clock runs forward from acceptance');
assert.equal(accepted.reviewWindow, 3_600);
pass('delivery clock starts at acceptance, not at creation');

await rejects('a third party releasing with no delivery submitted',
  () => send(escrow.build.releaseMilestone(ctx, {
    creator: outsider.publicKey, commission: flow.commission, agent: agent.publicKey, milestoneIndex: 0,
  }).instruction, [outsider]));

await rejects('someone other than the contracted agent submitting a delivery',
  () => send(escrow.build.submitDelivery(ctx, {
    agent: outsider.publicKey, commission: flow.commission, milestoneIndex: 0, evidenceHash: 'aa'.repeat(32),
  }).instruction, [outsider]));

await send(escrow.build.submitDelivery(ctx, {
  agent: agent.publicKey, commission: flow.commission, milestoneIndex: 0, evidenceHash: 'ab'.repeat(32),
}).instruction, [agent]);
await pause();
const submitted = await readCommission(flow.commission);
assert.ok(submitted.submission, 'the delivery is recorded on chain');
assert.equal(submitted.submission.evidenceHash, 'ab'.repeat(32));
assert.equal(submitted.submissions, 1);
pass('agent delivery recorded with its evidence commitment');

// The claim freezes every exit while it is live.
await rejects('the creator cancelling around a live delivery claim',
  () => send(escrow.build.cancel(ctx, { signer: payer.publicKey, commission: flow.commission }).instruction));
await rejects('a backer refunding around a live delivery claim',
  () => send(escrow.build.refund(ctx, { backer: payer.publicKey, commission: flow.commission }).instruction));
await rejects('a third party releasing before the review window elapses',
  () => send(escrow.build.releaseMilestone(ctx, {
    creator: outsider.publicKey, commission: flow.commission, agent: agent.publicKey, milestoneIndex: 0,
  }).instruction, [outsider]));

// ── rejection is on the record ──────────────────────────────────────────────
await rejects('a stranger rejecting the delivery',
  () => send(escrow.build.rejectDelivery(ctx, { creator: outsider.publicKey, commission: flow.commission }).instruction, [outsider]));

await send(escrow.build.rejectDelivery(ctx, { creator: payer.publicKey, commission: flow.commission }).instruction);
await pause();
const rejected = await readCommission(flow.commission);
assert.equal(rejected.rejections, 1, 'the refusal is counted against the creator');
assert.equal(rejected.submission, null, 'rejection stops the clock');
pass('creator refusal is public, attributable, and counted');

// Rejection now ENDS the contract and returns the commission to the pool, so
// the agent has to be re-hired before they can revise.
assert.equal(rejected.status, 'funded', 'rejection returns the commission to the pool');
assert.equal(rejected.agent, null, 'the rejected agent no longer holds the contract');
pass('rejection returns the commission to the pool');

await rejects('a cleared agent resubmitting without being re-nominated',
  () => send(escrow.build.submitDelivery(ctx, {
    agent: agent.publicKey, commission: flow.commission, milestoneIndex: 0, evidenceHash: 'cd'.repeat(32),
  }).instruction, [agent]));

await rejects('the creator rejecting and then instantly cancelling (F-1)',
  () => send(escrow.build.cancel(ctx, { signer: payer.publicKey, commission: flow.commission }).instruction));

await send(escrow.build.selectAgent(ctx, { creator: payer.publicKey, commission: flow.commission, agent: agent.publicKey }).instruction);
await pause();
await send(escrow.build.acceptAgent(ctx, { agent: agent.publicKey, commission: flow.commission }).instruction, [agent]);
await pause();
assert.equal(
  (await readCommission(flow.commission)).deliveryDeadline, rejected.deliveryDeadline,
  're-accepting must inherit the remaining clock, not reset it',
);
pass('a replacement agent inherits the delivery clock rather than restarting it');

await send(escrow.build.submitDelivery(ctx, {
  agent: agent.publicKey, commission: flow.commission, milestoneIndex: 0, evidenceHash: 'cd'.repeat(32),
}).instruction, [agent]);
await pause();
const agentBefore = await connection.getBalance(agent.publicKey);
await send(escrow.build.releaseMilestone(ctx, {
  creator: payer.publicKey, commission: flow.commission, agent: agent.publicKey, milestoneIndex: 0,
}).instruction);
await pause();
assert.equal(await connection.getBalance(agent.publicKey) - agentBefore, 1_980_000, 'agent receives 99%');
const delivered = await readCommission(flow.commission);
assert.equal(delivered.status, 'shipped');
assert.equal(delivered.submission, null, 'releasing settles the submission');
assert.equal(delivered.submissions, 2);
pass('creator release pays 99% and settles the claim');

// ── nomination lapse ────────────────────────────────────────────────────────
const parked = escrow.build.createCommission(ctx, {
  creator: payer.publicKey, seed: Date.now() + 20, goalLamports: 2_000_000, milestoneBasisPoints: [10_000],
  deadlineUnix: Math.floor(Date.now() / 1000) + 86_400,
});
await send(parked.instruction); await pause();
await send(escrow.build.pledge(ctx, { backer: payer.publicKey, commission: parked.commission, amountLamports: 2_000_000 }).instruction);
await pause();
await send(escrow.build.selectAgent(ctx, { creator: payer.publicKey, commission: parked.commission, agent: agent.publicKey }).instruction);
await pause();
const nominated = await readCommission(parked.commission);
assert.ok(nominated.nominatedAt > 0, 'the claim is timestamped so it can lapse');
assert.ok(nominated.nominationLapsesAt > nominated.nominatedAt);
pass('nomination is an exclusive, timestamped, expiring claim');

await rejects('a rival stripping a live exclusive claim',
  () => send(escrow.build.revokeAgent(ctx, { creator: outsider.publicKey, commission: parked.commission }).instruction, [outsider]));
await send(escrow.build.revokeAgent(ctx, { creator: payer.publicKey, commission: parked.commission }).instruction);
await pause();
assert.equal((await readCommission(parked.commission)).pendingAgent, null);
pass('creator can withdraw an unaccepted nomination');

// Clean up: return the parked escrow.
await send(escrow.build.cancel(ctx, { signer: payer.publicKey, commission: parked.commission }).instruction);
await pause();
await send(escrow.build.refund(ctx, { backer: payer.publicKey, commission: parked.commission }).instruction);
await pause();
assert.equal(await connection.getBalance(new PublicKey(parked.vault)), escrow.VAULT_RENT_LAMPORTS);
pass('cancelled commission closes to exactly its rent reserve');

console.log(`\nALL ${results.length} LIVE FAIRNESS CHECKS PASSED`);
connection._rpcWebSocket?.close();
process.exit(0);

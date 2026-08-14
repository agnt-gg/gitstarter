// Proves that finishing a job returns every account deposit, in the same
// transaction, with nobody clicking anything.
//
// Solana holds a refundable deposit on each account. It used to be returned by
// asking each party to press a button, which meant it mostly was not returned at
// all. This measures the real lamports on the deployed program: one signature,
// paid milestone, every deposit home.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
const send = (instructions, signers = []) => sendAndConfirmTransaction(
  connection, new Transaction().add(...[].concat(instructions)), [payer, ...signers], { commitment: 'confirmed' },
);
const balance = key => connection.getBalance(new PublicKey(key));
const exists = async key => !!(await connection.getAccountInfo(new PublicKey(key), 'confirmed'));
const results = [];
const pass = m => { results.push(m); console.log(`  PASS  ${m}`); };

console.log('Live devnet proof that deposits come home by themselves:\n');

// Two agents compete, so there is a winner AND a loser with money tied up.
const winner = Keypair.generate();
const loser = Keypair.generate();
for (const agent of [winner, loser]) {
  await send(SystemProgram.transfer({
    fromPubkey: payer.publicKey, toPubkey: agent.publicKey, lamports: 0.04 * LAMPORTS_PER_SOL,
  }));
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
await send(escrow.build.pledge(ctx, { backer: payer.publicKey, commission, amountLamports: 2_000_000 }).instruction);
await pause();

// Deliveries are judged strictly in the order they arrive, so the one who is
// going to be rejected has to be at the front of the queue.
const sha = text => crypto.createHash('sha256').update(text, 'utf8').digest();
for (const [agent, text] of [[loser, 'losing delivery'], [winner, 'winning delivery']]) {
  await send(escrow.build.submitDelivery(ctx, {
    agent: agent.publicKey, commission, milestoneIndex: 0, evidenceHash: sha(text),
  }).instruction, [agent]);
  await pause();
}

// The loser is rejected, so the winner is at the front of the queue.
await send(escrow.build.rejectDelivery(ctx, {
  creator: payer.publicKey, commission, agent: loser.publicKey, milestoneIndex: 0,
}).instruction);
await pause();

const vault = built.vault.toBase58();
const pledge = escrow.pledgePda(ctx.programId, commission, payer.publicKey).toBase58();
const winnerSubmission = escrow.submissionPda(ctx.programId, commission, 0, winner.publicKey).toBase58();
const loserSubmission = escrow.submissionPda(ctx.programId, commission, 0, loser.publicKey).toBase58();

const locked = (await Promise.all([vault, pledge, winnerSubmission, loserSubmission].map(balance)))
  .reduce((a, b) => a + b, 0);
assert.ok(locked > 0);
pass(`${locked / LAMPORTS_PER_SOL} SOL of deposits are locked across four accounts`);

// ── the whole point: ONE transaction, ONE signature ─────────────────────────
const loserBefore = await balance(loser.publicKey);
const winnerBefore = await balance(winner.publicKey);
const payerBefore = await balance(payer.publicKey);

const settle = new Transaction().add(
  escrow.build.releaseMilestone(ctx, {
    creator: payer.publicKey, commission, agent: winner.publicKey, milestoneIndex: 0,
  }).instruction,
  escrow.build.closeVault(ctx, { signer: payer.publicKey, commission, creator: payer.publicKey }).instruction,
  escrow.build.closePledge(ctx, { backer: payer.publicKey, commission }).instruction,
  escrow.build.closeSubmission(ctx, { agent: winner.publicKey, commission, milestoneIndex: 0 }).instruction,
  escrow.build.closeSubmission(ctx, { agent: loser.publicKey, commission, milestoneIndex: 0 }).instruction,
);
// Only the creator signs. Neither agent is present, and neither needs to be.
const signature = await sendAndConfirmTransaction(connection, settle, [payer], { commitment: 'confirmed' });
await pause();
pass('one transaction, signed only by the creator, paid the milestone and swept every account');

const fee = (await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })).meta.fee;

for (const [name, account] of [['vault', vault], ['pledge', pledge], ['winner submission', winnerSubmission], ['loser submission', loserSubmission]]) {
  assert.equal(await exists(account), false, `the ${name} account should be gone`);
}
pass('all four accounts are closed, so nothing is left holding a deposit');

// The loser never signed and never asked, and their deposit is back.
assert.equal(
  await balance(loser.publicKey) - loserBefore, escrow.SUBMISSION_RENT_LAMPORTS,
  'an agent who lost the race must get their deposit back without lifting a finger',
);
pass(`the losing agent got ${escrow.SUBMISSION_RENT_LAMPORTS / LAMPORTS_PER_SOL} SOL back having signed nothing`);

// The winner got paid AND got their deposit back, in the same transaction.
assert.equal(
  await balance(winner.publicKey) - winnerBefore,
  1_980_000 + escrow.SUBMISSION_RENT_LAMPORTS,
  'the winner should receive the milestone and their deposit together',
);
pass('the winner was paid and refunded their deposit in one movement');

// The creator is also the backer here, so they get the vault and the pledge
// deposits back, net of the milestone they just paid and the network fee. On
// devnet this wallet is ALSO the treasury, so the 1% comes straight back to it —
// state that rather than asserting a number that quietly depends on it.
// The 2,000,000 of escrow left this wallet when it PLEDGED, which was long
// before the balance below was sampled, so it does not belong in this delta.
const feeReturnedToSelf = payer.publicKey.toBase58() === ctx.treasury ? 20_000 : 0;
const creatorDelta = await balance(payer.publicKey) - payerBefore + fee;
const expected = escrow.VAULT_RENT_LAMPORTS + escrow.PLEDGE_RENT_LAMPORTS + feeReturnedToSelf;
assert.equal(
  creatorDelta, expected,
  `the creator should recover both deposits they paid for: got ${creatorDelta}, expected ${expected}`,
);
pass('the creator recovered the vault and pledge deposits automatically');

const commissionRent = await balance(commission);
console.log(`\n  every reclaimable lamport returned in one signature`);
console.log(`  ${commissionRent / LAMPORTS_PER_SOL} SOL remains in the commission account itself, on purpose:`);
console.log('  it is the permanent public record reputation is computed from.');
console.log(`\nALL ${results.length} LIVE DEPOSIT CHECKS PASSED`);
connection._rpcWebSocket?.close();
process.exit(0);

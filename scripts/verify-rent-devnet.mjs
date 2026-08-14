// Proves rent reclamation against the DEPLOYED program, in lamports.
//
// Every account this program opens is rent-exempt, so SOL is locked for as long
// as it exists. On a 0.05 SOL bounty that overhead is a real percentage of the
// whole commission. This measures what actually comes back.
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
const pause = (ms = 1600) => new Promise(r => setTimeout(r, ms));
const send = (instruction, signers = []) =>
  sendAndConfirmTransaction(connection, new Transaction().add(instruction), [payer, ...signers], { commitment: 'confirmed' });
const balance = key => connection.getBalance(new PublicKey(key));
const results = [];
const pass = m => { results.push(m); console.log(`  PASS  ${m}`); };
async function rejects(label, fn) {
  try { await fn(); } catch { pass(`rejected: ${label}`); return; }
  throw new Error(`REGRESSION - chain ACCEPTED: ${label}`);
}

async function fundedCommission(seed, { delivery = 3_600, review = 3_600 } = {}) {
  const built = escrow.build.createCommission(ctx, {
    creator: payer.publicKey, seed, goalLamports: 2_000_000, milestoneBasisPoints: [10_000],
    deadlineUnix: Math.floor(Date.now() / 1000) + 86_400,
    deliveryWindowSeconds: delivery, reviewWindowSeconds: review,
  });
  await send(built.instruction); await pause();
  await send(escrow.build.pledge(ctx, { backer: payer.publicKey, commission: built.commission, amountLamports: 2_000_000 }).instruction);
  await pause();
  return built;
}

console.log('Live devnet rent reclamation:\n');

// ── the refund path ─────────────────────────────────────────────────────────
const refunded = await fundedCommission(Date.now());
const pledgeAccount = escrow.pledgePda(ctx.programId, refunded.commission, payer.publicKey);
assert.equal(
  await balance(pledgeAccount), escrow.PLEDGE_RENT_LAMPORTS,
  'a pledge account should hold exactly its rent-exemption minimum',
);
pass(`a pledge account locks ${escrow.PLEDGE_RENT_LAMPORTS / LAMPORTS_PER_SOL} SOL of rent`);

await send(escrow.build.cancel(ctx, { signer: payer.publicKey, commission: refunded.commission }).instruction);
await pause();
const beforeRefund = await balance(payer.publicKey);
const refundSig = await send(escrow.build.refund(ctx, { backer: payer.publicKey, commission: refunded.commission }).instruction);
await pause();
const refundFee = (await connection.getTransaction(refundSig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })).meta.fee;
const returned = await balance(payer.publicKey) - beforeRefund + refundFee;
assert.equal(
  returned, 2_000_000 + escrow.PLEDGE_RENT_LAMPORTS,
  `refund returned ${returned}, expected escrow plus pledge rent`,
);
assert.equal(await balance(pledgeAccount), 0, 'the pledge account should be closed');
pass('a refund returns the escrow AND the pledge rent, closing the account');

await rejects('replaying a refund against the closed pledge account',
  () => send(escrow.build.refund(ctx, { backer: payer.publicKey, commission: refunded.commission }).instruction));
await rejects('pledging again to resurrect the closed account',
  () => send(escrow.build.pledge(ctx, { backer: payer.publicKey, commission: refunded.commission, amountLamports: 1_000_000 }).instruction));

// The vault is empty and every backer has settled, so its reserve goes home.
assert.equal(await balance(refunded.vault), escrow.VAULT_RENT_LAMPORTS, 'the vault should hold only its reserve');
const beforeVault = await balance(payer.publicKey);
const vaultSig = await send(escrow.build.closeVault(ctx, {
  signer: payer.publicKey, commission: refunded.commission, creator: payer.publicKey,
}).instruction);
await pause();
const vaultFee = (await connection.getTransaction(vaultSig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })).meta.fee;
assert.equal(
  await balance(payer.publicKey) - beforeVault + vaultFee, escrow.VAULT_RENT_LAMPORTS,
  'the creator should recover exactly the vault rent',
);
assert.equal(await balance(refunded.vault), 0, 'the vault should be closed');
pass('an emptied vault returns its reserve to the creator');
await rejects('closing an already-closed vault',
  () => send(escrow.build.closeVault(ctx, { signer: payer.publicKey, commission: refunded.commission, creator: payer.publicKey }).instruction));

// ── the shipped path ────────────────────────────────────────────────────────
const agent = Keypair.generate();
await send(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: agent.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }));
await pause();

const shipped = await fundedCommission(Date.now() + 7);
await rejects('closing a pledge on a commission that is still live',
  () => send(escrow.build.closePledge(ctx, { backer: payer.publicKey, commission: shipped.commission }).instruction));

await send(escrow.build.selectAgent(ctx, { creator: payer.publicKey, commission: shipped.commission, agent: agent.publicKey }).instruction);
await pause();
await send(escrow.build.acceptAgent(ctx, { agent: agent.publicKey, commission: shipped.commission }).instruction, [agent]);
await pause();
await send(escrow.build.submitDelivery(ctx, {
  agent: agent.publicKey, commission: shipped.commission, milestoneIndex: 0, evidenceHash: 'ab'.repeat(32),
}).instruction, [agent]);
await pause();
await send(escrow.build.releaseMilestone(ctx, {
  creator: payer.publicKey, commission: shipped.commission, agent: agent.publicKey, milestoneIndex: 0,
}).instruction);
await pause();
assert.equal((await connection.getAccountInfo(new PublicKey(shipped.commission))
  && escrow.decodeCommission((await connection.getAccountInfo(new PublicKey(shipped.commission))).data)).status, 'shipped');

// No refund is ever coming, so the backer has to ask for the rent back.
const shippedPledge = escrow.pledgePda(ctx.programId, shipped.commission, payer.publicKey);
assert.equal(await balance(shippedPledge), escrow.PLEDGE_RENT_LAMPORTS);
const beforeClose = await balance(payer.publicKey);
const closeSig = await send(escrow.build.closePledge(ctx, { backer: payer.publicKey, commission: shipped.commission }).instruction);
await pause();
const closeFee = (await connection.getTransaction(closeSig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })).meta.fee;
assert.equal(
  await balance(payer.publicKey) - beforeClose + closeFee, escrow.PLEDGE_RENT_LAMPORTS,
  'the backer should recover exactly the pledge rent',
);
assert.equal(await balance(shippedPledge), 0);
pass('a shipped commission lets its backers reclaim their pledge rent');

await send(escrow.build.closeVault(ctx, {
  signer: payer.publicKey, commission: shipped.commission, creator: payer.publicKey,
}).instruction);
await pause();
assert.equal(await balance(shipped.vault), 0);
pass('and its vault reserve comes back too');

const recovered = escrow.PLEDGE_RENT_LAMPORTS + escrow.VAULT_RENT_LAMPORTS;
const total = recovered + escrow.COMMISSION_RENT_LAMPORTS;
console.log(`\n  recovered ${recovered / LAMPORTS_PER_SOL} SOL of ${total / LAMPORTS_PER_SOL} SOL`
  + ` (${Math.round(recovered / total * 100)}%) on a single-backer commission`);
console.log(`  the remaining ${escrow.COMMISSION_RENT_LAMPORTS / LAMPORTS_PER_SOL} SOL is the commission account, kept on purpose`);
console.log(`\nALL ${results.length} LIVE RENT CHECKS PASSED`);
connection._rpcWebSocket?.close();
process.exit(0);

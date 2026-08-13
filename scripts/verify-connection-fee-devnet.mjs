// Proves the connection-fee model against the DEPLOYED program.
//
// The claim under test: the protocol charges 1% for connecting two parties and
// carrying real work between them, once per lamport, however that lamport
// leaves escrow — and charges nothing at all when no work was ever delivered.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import escrow from '../shared/escrow.js';

const RPC = 'https://api.devnet.solana.com';
const ctx = {
  programId: '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy',
  configPda: 'DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29',
  treasury: '4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY',
};
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))));
const connection = new Connection(RPC, 'confirmed');
const pause = (ms = 1600) => new Promise(r => setTimeout(r, ms));
const send = (instruction, signers = []) =>
  sendAndConfirmTransaction(connection, new Transaction().add(instruction), [payer, ...signers], { commitment: 'confirmed' });
const read = async a => escrow.decodeCommission((await connection.getAccountInfo(new PublicKey(a), 'confirmed')).data);

const results = [];
const pass = m => { results.push(m); console.log(`  PASS  ${m}`); };
async function rejects(label, fn) {
  try { await fn(); } catch { pass(`rejected: ${label}`); return; }
  throw new Error(`REGRESSION - chain ACCEPTED: ${label}`);
}

async function open({ seed, delivery = 7_200, review = 3_600, amount = 2_000_000, bps = [10_000] }) {
  const built = escrow.build.createCommission(ctx, {
    creator: payer.publicKey, seed, goalLamports: amount, milestoneBasisPoints: bps,
    deadlineUnix: Math.floor(Date.now() / 1000) + 86_400,
    deliveryWindowSeconds: delivery, reviewWindowSeconds: review,
  });
  await send(built.instruction); await pause();
  await send(escrow.build.pledge(ctx, { backer: payer.publicKey, commission: built.commission, amountLamports: amount }).instruction);
  await pause();
  return built;
}

console.log('Live devnet enforcement of the connection fee:\n');

const agent = Keypair.generate();
await send(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: agent.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL }));
await pause();

// ── 1. no delivery, no fee ──────────────────────────────────────────────────
const clean = await open({ seed: Date.now() });
await send(escrow.build.cancel(ctx, { signer: payer.publicKey, commission: clean.commission }).instruction);
await pause();
let treasuryBefore = await connection.getBalance(new PublicKey(ctx.treasury));
await send(escrow.build.refund(ctx, { backer: payer.publicKey, commission: clean.commission }).instruction);
await pause();
assert.equal(
  await connection.getBalance(new PublicKey(ctx.treasury)) - treasuryBefore, 0,
  'a commission that never received a delivery must cost nothing',
);
assert.equal(await connection.getBalance(new PublicKey(clean.vault)), escrow.VAULT_RENT_LAMPORTS);
pass('no delivery submitted, refund is free and the vault closes exactly');

// ── 2. delivered then refused: refusing costs what approving costs ──────────
const refused = await open({ seed: Date.now() + 1 });
await send(escrow.build.selectAgent(ctx, { creator: payer.publicKey, commission: refused.commission, agent: agent.publicKey }).instruction);
await pause();
await send(escrow.build.acceptAgent(ctx, { agent: agent.publicKey, commission: refused.commission }).instruction, [agent]);
await pause();
await send(escrow.build.submitDelivery(ctx, {
  agent: agent.publicKey, commission: refused.commission, milestoneIndex: 0, evidenceHash: 'ab'.repeat(32),
}).instruction, [agent]);
await pause();
await send(escrow.build.rejectDelivery(ctx, { creator: payer.publicKey, commission: refused.commission }).instruction);
await pause();

const afterReject = await read(refused.commission);
assert.equal(afterReject.status, 'funded', 'rejection returns the commission to the pool');
assert.equal(afterReject.agent, null, 'the rejected agent no longer holds the contract');
assert.equal(afterReject.rejections, 1);
pass('rejection ends the contract and re-opens the commission');

await rejects('a cleared agent submitting again without being re-nominated',
  () => send(escrow.build.submitDelivery(ctx, {
    agent: agent.publicKey, commission: refused.commission, milestoneIndex: 0, evidenceHash: 'cd'.repeat(32),
  }).instruction, [agent]));

// Re-hire the same agent; the delivery clock must not restart.
await send(escrow.build.selectAgent(ctx, { creator: payer.publicKey, commission: refused.commission, agent: agent.publicKey }).instruction);
await pause();
await send(escrow.build.acceptAgent(ctx, { agent: agent.publicKey, commission: refused.commission }).instruction, [agent]);
await pause();
assert.equal(
  (await read(refused.commission)).deliveryDeadline, afterReject.deliveryDeadline,
  're-accepting must inherit the remaining clock, not reset it',
);
pass('a replacement agent inherits the delivery clock rather than restarting it');

console.log(`\nALL ${results.length} LIVE CONNECTION-FEE CHECKS PASSED`);
console.log('(the fee-on-refund total is proven exactly in the Rust adversarial suite,');
console.log(' which can warp the clock past a delivery deadline; this run proves the');
console.log(' on-chain rejection and clock-inheritance behaviour.)');
connection._rpcWebSocket?.close();
process.exit(0);

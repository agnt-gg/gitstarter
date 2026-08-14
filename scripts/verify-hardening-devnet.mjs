// Confirms the security fixes are enforced by the DEPLOYED program, not merely
// by the local test harness. Run against devnet after any program upgrade.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';

const RPC = 'https://api.devnet.solana.com';
const PROGRAM = new PublicKey('6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy');
const CONFIG = new PublicKey('DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29');
const TREASURY = new PublicKey('4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))));
const connection = new Connection(RPC, 'confirmed');

const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const pause = (ms = 1200) => new Promise(r => setTimeout(r, ms));
const send = (ixs, signers) =>
  sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [payer, ...signers], { commitment: 'confirmed' });

function addresses(creator, seed) {
  const [commission] = PublicKey.findProgramAddressSync([Buffer.from('commission'), creator.toBuffer(), u64(seed)], PROGRAM);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault'), commission.toBuffer()], PROGRAM);
  return { commission, vault };
}
const pledgePda = (commission, backer) =>
  PublicKey.findProgramAddressSync([Buffer.from('pledge'), commission.toBuffer(), backer.toBuffer()], PROGRAM)[0];

function createIx(creator, commission, vault, seed, goal, bps, deadline) {
  const count = Buffer.alloc(4); count.writeUInt32LE(bps.length);
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: CONFIG, isSigner: false, isWritable: false },
      { pubkey: commission, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    // CreateCommission carries two clocks after the funding deadline: the
    // delivery window and the review window. Zero selects the program defaults.
    // These are encoded by hand here on purpose — the point of this probe is to
    // exercise the chain without trusting our own encoder.
    data: Buffer.concat([Buffer.from([1]), u64(seed), u64(goal), count,
      ...bps.map(x => { const b = Buffer.alloc(2); b.writeUInt16LE(x); return b; }),
      i64(deadline), i64(0), i64(0)]),
  });
}
const pledgeIx = (backer, commission, vault, amount) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: backer, isSigner: true, isWritable: true },
    { pubkey: CONFIG, isSigner: false, isWritable: false },
    { pubkey: commission, isSigner: false, isWritable: true },
    { pubkey: pledgePda(commission, backer), isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([Buffer.from([2]), u64(amount)]),
});
const nominateIx = (creator, commission, agent) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: creator, isSigner: true, isWritable: false },
    { pubkey: commission, isSigner: false, isWritable: true },
    { pubkey: agent, isSigner: false, isWritable: false },
  ],
  data: Buffer.from([3]),
});
const acceptIx = (agent, commission) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: agent, isSigner: true, isWritable: false },
    { pubkey: commission, isSigner: false, isWritable: true },
  ],
  data: Buffer.from([8]),
});
const revokeIx = (creator, commission) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: creator, isSigner: true, isWritable: false },
    { pubkey: commission, isSigner: false, isWritable: true },
  ],
  data: Buffer.from([9]),
});
const cancelIx = (signer, commission) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: signer, isSigner: true, isWritable: false },
    { pubkey: commission, isSigner: false, isWritable: true },
  ],
  data: Buffer.from([6]),
});
// Refund credits the treasury when a delivery was ever submitted, so the
// treasury is part of the account list even on commissions that never saw one.
const refundIx = (backer, commission, vault) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: backer, isSigner: true, isWritable: true },
    { pubkey: commission, isSigner: false, isWritable: true },
    { pubkey: pledgePda(commission, backer), isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: TREASURY, isSigner: false, isWritable: true },
  ],
  data: Buffer.from([5]),
});

async function rejects(label, fn) {
  try { await fn(); }
  catch { console.log(`  PASS  rejected: ${label}`); return; }
  throw new Error(`SECURITY REGRESSION — chain ACCEPTED: ${label}`);
}

const creator = Keypair.generate(), backer = Keypair.generate(), agent = Keypair.generate();
for (const kp of [creator, backer, agent]) {
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL })], []);
  await pause();
}

const seed = Date.now();
const far = Math.floor(Date.now() / 1000) + 86400;
const { commission, vault } = addresses(creator.publicKey, seed);
await send([createIx(creator.publicKey, commission, vault, seed, 2_000_000, [10_000], far)], [creator]);
await pause();
await send([pledgeIx(backer.publicKey, commission, vault, 2_000_000)], [backer]);
await pause();

console.log('Live devnet enforcement:');

// A deadline far enough out is indistinguishable from never, which is what made
// escrow permanently unreachable.
await rejects('a deadline beyond the ceiling (permanent-lock primitive)', async () => {
  const s = seed + 1;
  const { commission: c2, vault: v2 } = addresses(creator.publicKey, s);
  await send([createIx(creator.publicKey, c2, v2, s, 2_000_000, [10_000], Math.floor(Date.now() / 1000) + 400 * 86400)], [creator]);
});
await rejects('a goal small enough to floor a milestone slice to zero', async () => {
  const s = seed + 2;
  const { commission: c3, vault: v3 } = addresses(creator.publicKey, s);
  await send([createIx(creator.publicKey, c3, v3, s, 500, [5_000, 5_000], far)], [creator]);
});

await rejects('creator naming themselves as the paid agent',
  () => send([nominateIx(creator.publicKey, commission, creator.publicKey)], [creator]));

// An unaccepted nomination must be withdrawable, so one unresponsive nominee
// cannot strand a funded raise.
await send([nominateIx(creator.publicKey, commission, backer.publicKey)], [creator]);
await pause();
await send([revokeIx(creator.publicKey, commission)], [creator]);
await pause();
console.log('  PASS  unaccepted nomination withdrawn');
await rejects('a withdrawn nominee accepting anyway',
  () => send([acceptIx(backer.publicKey, commission)], [backer]));

await send([nominateIx(creator.publicKey, commission, agent.publicKey)], [creator]);
await pause();
await rejects('a stranger accepting a contract nominated to someone else',
  () => send([acceptIx(backer.publicKey, commission)], [backer]));
await send([acceptIx(agent.publicKey, commission)], [agent]);
await pause();

await rejects('creator cancelling out from under a working agent',
  () => send([cancelIx(creator.publicKey, commission)], [creator]));
await rejects('an outsider cancelling a live build',
  () => send([cancelIx(backer.publicKey, commission)], [backer]));

// The agent may hand the money back early.
await send([cancelIx(agent.publicKey, commission)], [agent]);
await pause();
console.log('  PASS  agent walk-away accepted');

const before = await connection.getBalance(backer.publicKey);
await send([refundIx(backer.publicKey, commission, vault)], [backer]);
await pause();
const after = await connection.getBalance(backer.publicKey);
assert.ok(after > before, 'backer must be made whole');
await rejects('replaying an already-settled refund',
  () => send([refundIx(backer.publicKey, commission, vault)], [backer]));

const vaultLeft = await connection.getBalance(vault);
assert.equal(vaultLeft, 890_880, 'vault must retain only its rent reserve');
console.log('  PASS  escrow fully returned, vault holds only rent');
console.log(JSON.stringify({ ok: true, program: PROGRAM.toBase58(), commission: commission.toBase58() }, null, 2));
connection._rpcWebSocket?.close();
process.exit(0);

// Proves the two mechanisms behind "it updated without me reloading", against
// the live cluster:
//
//   1. A read pinned to the slot our transaction confirmed in reflects that
//      transaction on the FIRST attempt. Previously the read could be served by
//      a node that had not caught up, so a confirmed pledge still showed as
//      unfunded until a manual reload.
//   2. A websocket subscription is pushed the new account state, with no
//      polling, so activity by other people appears on its own.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import escrow from '../shared/escrow.js';

const ctx = {
  programId: '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy',
  configPda: 'DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29',
  treasury: '4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY',
};
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const programId = new PublicKey(ctx.programId);
const filters = [{ dataSize: escrow.COMMISSION_ACCOUNT_BYTES }, { memcmp: { offset: 0, bytes: '3' } }];
const pass = m => console.log(`  PASS  ${m}`);

// A commission of our own, so nothing in the live test data is disturbed.
const built = escrow.build.createCommission(ctx, {
  creator: payer.publicKey, seed: Date.now(), goalLamports: 2_000_000,
  milestoneBasisPoints: [10_000], deadlineUnix: Math.floor(Date.now() / 1000) + 86_400,
  deliveryWindowSeconds: 3_600, reviewWindowSeconds: 3_600,
});
await sendAndConfirmTransaction(connection, new Transaction().add(built.instruction), [payer], { commitment: 'confirmed' });
const address = built.commission.toBase58();
console.log(`Commission ${address}\n`);

// ── 2. the websocket must be pushed the change, unprompted ──────────────────
let pushed = null;
const subscription = connection.onProgramAccountChange(
  programId,
  ({ accountId, accountInfo }) => {
    if (accountId.toBase58() === address) pushed = escrow.decodeCommission(accountInfo.data);
  },
  'confirmed',
  filters,
);
await new Promise(r => setTimeout(r, 2500)); // let the subscription register

// ── 1. a pinned read must not be able to come back stale ────────────────────
const pledge = escrow.build.pledge(ctx, { backer: payer.publicKey, commission: address, amountLamports: 2_000_000 });
const signature = await sendAndConfirmTransaction(connection, new Transaction().add(pledge.instruction), [payer], { commitment: 'confirmed' });

const status = await connection.getSignatureStatuses([signature]);
const slot = status.value[0].slot;

// The bulk scan cannot be pinned: getProgramAccounts accepts minContextSlot and
// ignores it. Prove that here, because it is the whole reason a targeted read is
// required — and if a future RPC version starts honouring it, this fails loudly
// rather than leaving a stale comment behind.
const impossible = await connection.getSlot('confirmed') + 100_000;
const ignoredIt = await connection
  .getProgramAccounts(programId, { commitment: 'confirmed', filters, minContextSlot: impossible })
  .then(() => true, () => false);
assert.equal(ignoredIt, true, 'getProgramAccounts now honours minContextSlot; the bulk scan could be pinned');
pass('getProgramAccounts ignores minContextSlot, so the bulk scan cannot be trusted alone');

// Exactly what the client now does after a wallet confirms: a targeted read that
// refuses any node older than the slot we have proof of.
let info;
for (let attempt = 0; ; attempt++) {
  try { info = await connection.getAccountInfo(new PublicKey(address), { commitment: 'confirmed', minContextSlot: slot }); break; }
  catch (error) {
    assert.ok(attempt < 12, `no node reached slot ${slot}: ${error.message}`);
    await new Promise(r => setTimeout(r, 300));
  }
}
assert.ok(info?.data, 'the pinned read returned no account');
const decoded = escrow.decodeCommission(info.data);
assert.equal(decoded.pledged, 2_000_000, 'a pinned read must reflect the pledge that just confirmed');
assert.equal(decoded.status, 'funded', 'and must show the status the pledge produced');
pass('a read pinned to the confirming slot reflects the pledge immediately');
pass(`no reload required: status is "${decoded.status}", ${decoded.pledged / 1e9} SOL in escrow`);

// Give the push a moment to arrive, then confirm it did.
for (let attempt = 0; attempt < 20 && !pushed; attempt++) await new Promise(r => setTimeout(r, 500));
assert.ok(pushed, 'the websocket was never pushed the account change');
assert.equal(pushed.pledged, 2_000_000, 'the pushed account must carry the new state');
pass('the websocket was pushed the new state, with no polling');

await connection.removeProgramAccountChangeListener(subscription);

// Clean up: return the escrow so the test leaves nothing behind.
await sendAndConfirmTransaction(connection, new Transaction().add(
  escrow.build.cancel(ctx, { signer: payer.publicKey, commission: address }).instruction), [payer], { commitment: 'confirmed' });
await sendAndConfirmTransaction(connection, new Transaction().add(
  escrow.build.refund(ctx, { backer: payer.publicKey, commission: address }).instruction), [payer], { commitment: 'confirmed' });
pass('test commission cancelled and refunded');

console.log('\nALL LIVE UPDATE CHECKS PASSED');
process.exit(0);

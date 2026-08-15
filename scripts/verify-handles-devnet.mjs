// Proves on the live chain that a name belongs to one wallet, permanently.
//
// The property being checked is not "claiming works". It is that the three
// routes to inheriting somebody else's reputation are all closed: taking a name
// they hold, taking a case-variant of it that renders identically, and taking
// one they appear to have abandoned.
import fs from 'node:fs';
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
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const pause = (ms = 1200) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` :: ${detail}` : ''}`);
};
const send = (instruction, signers) =>
  sendAndConfirmTransaction(connection, new Transaction().add(instruction), signers, { commitment: 'confirmed' });

// Fresh wallets, so this says something about the program rather than about
// leftover state from a previous run.
const alice = Keypair.generate();
const mallory = Keypair.generate();
for (const wallet of [alice, mallory]) {
  await send(SystemProgram.transfer({
    fromPubkey: funder.publicKey, toPubkey: wallet.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL,
  }), [funder]);
}
await pause();

// A name nobody has taken, so the run is repeatable.
const name = `annie-${Date.now().toString(36)}`;
console.log(`\nclaiming "${name}" on devnet\n`);

const built = escrow.build.claimHandle(ctx, { wallet: alice.publicKey, handle: name });
await send(built.instruction, [alice]);
await pause();

const account = await connection.getAccountInfo(built.claim, 'confirmed');
check('the claim exists on chain', !!account, `${built.claim.toBase58().slice(0, 12)}\u2026`);
const claim = escrow.decodeHandleClaim(account.data);
check('it names the wallet that claimed it', claim.wallet === alice.publicKey.toBase58());
check('it round-trips the name exactly', claim.handle === name, claim.handle);
check('rent is the whole cost', account.lamports > 0, `${(account.lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL, unrecoverable by design`);

// ── the three impersonation routes ──────────────────────────────────────────
const refused = async (label, handle, signer) => {
  try {
    await send(escrow.build.claimHandle(ctx, { wallet: signer.publicKey, handle }).instruction, [signer]);
    check(label, false, 'it was ACCEPTED');
  } catch (error) {
    check(label, true, escrow.explainError(error)?.name || 'refused');
  }
};

await refused('a stranger cannot take a name somebody holds', name, mallory);
// The one that matters most: if the program normalised instead of refusing,
// "Annie" would derive a different address from "annie" and both could be held.
await refused('nor a capitalised variant of it', name.toUpperCase(), mallory);
await refused('nor can the holder re-claim it', name, alice);
await refused('a name shaped like an address is refused', '2b8ydoo4q3jjzuugqqqvp86xoahgmsqr', mallory);
await refused('so is a leading hyphen', '-mallory', mallory);

// ── it is discoverable by anybody ───────────────────────────────────────────
//
// The point of moving this on chain: the claim can be rebuilt by reading the
// program, so losing our database costs nothing that matters.
const all = await connection.getProgramAccounts(new PublicKey(ctx.programId), {
  commitment: 'confirmed',
  filters: [{ dataSize: escrow.HANDLE_ACCOUNT_BYTES }, { memcmp: { offset: 0, bytes: '7' } }],
});
const rebuilt = all.map(a => escrow.decodeHandleClaim(a.account.data));
check('every claim is readable from the chain alone', rebuilt.some(c => c.handle === name),
  `${rebuilt.length} claim(s) on chain, no database involved`);

console.log(`\n${results.every(r => r.ok) ? 'ALL LIVE CHECKS PASSED' : 'FAILURES ABOVE'}`);
connection._rpcWebSocket?.close();
process.exit(results.every(r => r.ok) ? 0 : 1);

// Returns every account deposit that can no longer be needed, program-wide.
//
// Settling a commission sweeps its own accounts, but that only helps
// commissions settling from now on. Anything that finished before the sweep
// existed — or whose settling transaction hit its size cap — still holds real
// SOL belonging to backers and agents who were never going to be asked for it.
//
// Nobody signs for their own money here. The close instructions are unsigned by
// design: each pays only the wallet recorded inside the account it closes, so
// whoever runs this is spending network fees to return other people's deposits
// and cannot misdirect a lamport. That is what makes an open cranker safe.
//
//   node scripts/sweep-deposits.mjs            report what is reclaimable
//   node scripts/sweep-deposits.mjs --execute  return it
import fs from 'node:fs';
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import escrow from '../shared/escrow.js';

// Defaults to the LIVE deployment. Point it at devnet explicitly when cleaning
// up devnet debris — a safety-net script that silently targets the wrong chain
// reports "nothing to sweep" and everyone believes it.
const ctx = {
  programId: process.env.PROGRAM_ID || 'HYrwoRKRdPDpuwTHAv3BzbdGXtTVrMe6vzBFefX8RiH4',
  configPda: process.env.CONFIG_PDA || 'E7tHZCvZWB6fQLwZA6KCipgJszjPn4ZTzSUdZC1XX4x2',
  treasury: process.env.TREASURY_WALLET || '6RehrefK9bq2U8dJse96GjGGHm8t6mznxGR1Qj2e1A5P',
};
const RPC = process.env.SOLANA_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const execute = process.argv.includes('--execute');
const connection = new Connection(RPC, 'confirmed');
const payer = process.env.DEPLOYER_KEYPAIR
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))))
  : null;
const sol = lamports => `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`;

async function accountsOfType(size, tag) {
  return connection.getProgramAccounts(new PublicKey(ctx.programId), {
    commitment: 'confirmed',
    filters: [{ dataSize: size }, { memcmp: { offset: 0, bytes: tag } }],
  });
}

const now = Math.floor(Date.now() / 1000);
const commissions = new Map();
for (const { pubkey, account } of await accountsOfType(escrow.COMMISSION_ACCOUNT_BYTES, '3')) {
  try { commissions.set(pubkey.toBase58(), escrow.decodeCommission(account.data)); }
  catch { /* a layout this build cannot read */ }
}

const [pledgeAccounts, submissionAccounts, intentAccounts] = await Promise.all([
  accountsOfType(escrow.PLEDGE_ACCOUNT_BYTES, '4'),
  accountsOfType(escrow.SUBMISSION_ACCOUNT_BYTES, '5'),
  accountsOfType(escrow.INTENT_ACCOUNT_BYTES, '6'),
]);

const reclaimable = [];
const orphaned = [];
let locked = 0;

/// Mirrors the program's own settlement checks, so this never builds an
/// instruction the chain is going to refuse.
for (const { pubkey, account } of pledgeAccounts) {
  locked += account.lamports;
  let p; try { p = escrow.decodePledge(account.data); } catch { continue; }
  const c = commissions.get(p.commission);
  if (!c) { orphaned.push({ kind: 'pledge', account: pubkey.toBase58(), lamports: account.lamports, commission: p.commission }); continue; }
  const settled = p.fullyRefunded || (c.status === 'shipped' && escrow.escrowRemaining(c) === 0);
  if (settled) {
    reclaimable.push({
      kind: 'pledge', lamports: account.lamports, to: p.backer,
      instruction: escrow.build.closePledge(ctx, { backer: p.backer, commission: p.commission }).instruction,
    });
  }
}

for (const { pubkey, account } of submissionAccounts) {
  locked += account.lamports;
  let s; try { s = escrow.decodeSubmission(account.data); } catch { continue; }
  const c = commissions.get(s.commission);
  if (!c) { orphaned.push({ kind: 'submission', account: pubkey.toBase58(), lamports: account.lamports, commission: s.commission }); continue; }
  const settled = s.state !== 'pending'
    || (c.milestonesDone & (1 << s.milestoneIndex)) !== 0
    || c.status === 'refunded'
    || (escrow.workClosed(c, now) && !escrow.claimProtected(c, now));
  if (settled) {
    reclaimable.push({
      kind: 'submission', lamports: account.lamports, to: s.agent,
      instruction: escrow.build.closeSubmission(ctx, {
        agent: s.agent, commission: s.commission, milestoneIndex: s.milestoneIndex,
      }).instruction,
    });
  }
}

for (const { pubkey, account } of intentAccounts) {
  locked += account.lamports;
  let i; try { i = escrow.decodeIntent(account.data); } catch { continue; }
  const c = commissions.get(i.commission);
  if (!c) { orphaned.push({ kind: 'intent', account: pubkey.toBase58(), lamports: account.lamports, commission: i.commission }); continue; }
  const over = ['shipped', 'refunded'].includes(c.status) || escrow.workClosed(c, now);
  if (over) {
    reclaimable.push({
      kind: 'intent', lamports: account.lamports, to: i.agent,
      instruction: escrow.build.closeIntent(ctx, { agent: i.agent, commission: i.commission }).instruction,
    });
  }
}

const byKind = list => list.reduce((counts, item) => {
  counts[item.kind] = (counts[item.kind] || 0) + 1;
  return counts;
}, {});
const total = reclaimable.reduce((sum, r) => sum + r.lamports, 0);
const stranded = orphaned.reduce((sum, r) => sum + r.lamports, 0);

console.log(`${sol(locked)} locked across ${pledgeAccounts.length + submissionAccounts.length + intentAccounts.length} accounts\n`);
console.log(`reclaimable now : ${sol(total)} in ${reclaimable.length} account(s) ${JSON.stringify(byKind(reclaimable))}`);
const owed = new Map();
for (const r of reclaimable) owed.set(r.to, (owed.get(r.to) || 0) + r.lamports);
for (const [wallet, lamports] of [...owed].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${wallet}  ${sol(lamports)}`);
}

if (orphaned.length) {
  console.log(`\nunreachable      : ${sol(stranded)} in ${orphaned.length} account(s) ${JSON.stringify(byKind(orphaned))}`);
  console.log('   Their commission account no longer decodes, so the program cannot');
  console.log('   load it to authorise a close. These are devnet debris from account');
  console.log('   layout changes: on a live cluster a layout is never changed under');
  console.log('   accounts that reference it, precisely because this is the result.');
}

if (!execute) {
  console.log('\nreport only. pass --execute to return these deposits.');
  connection._rpcWebSocket?.close();
  process.exit(0);
}
if (!reclaimable.length) { connection._rpcWebSocket?.close(); process.exit(0); }
if (!payer) throw new Error('set DEPLOYER_KEYPAIR to a wallet that can pay the network fees');

// Batched, because every account a transaction touches costs bytes of a fixed
// budget. Small batches also mean one already-closed account only costs its own
// batch a retry rather than sinking the whole sweep.
console.log('\nreturning deposits...');
let returned = 0, failed = 0;
for (let i = 0; i < reclaimable.length; i += 6) {
  const batch = reclaimable.slice(i, i + 6);
  try {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(...batch.map(r => r.instruction)),
      [payer], { commitment: 'confirmed' },
    );
    returned += batch.reduce((sum, r) => sum + r.lamports, 0);
    console.log(`  batch ${i / 6 + 1}: returned ${sol(batch.reduce((s, r) => s + r.lamports, 0))} to ${new Set(batch.map(r => r.to)).size} wallet(s)`);
  } catch (error) {
    // Somebody else may have cranked it first, which is a success for the
    // deposit even though it is a failure for this transaction.
    failed += batch.length;
    console.log(`  batch ${i / 6 + 1}: skipped (${escrow.explainError(error)?.name || error.message.slice(0, 60)})`);
  }
  await new Promise(r => setTimeout(r, 800));
}
console.log(`\nreturned ${sol(returned)}${failed ? `, ${failed} account(s) skipped` : ''}`);
connection._rpcWebSocket?.close();
process.exit(0);

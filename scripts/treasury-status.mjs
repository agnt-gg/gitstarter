// What the protocol has earned, and whether the wallet holding it is safe.
//
// Read-only and keyless on purpose. Working out what you are owed should never
// require the key that can spend it, and the treasury never signs anything in
// this protocol — it only ever receives — so it can and should live somewhere
// that is offline most of the time.
//
//   node scripts/treasury-status.mjs
//   node scripts/treasury-status.mjs --cluster mainnet-beta
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import escrow from '../shared/escrow.js';

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1]; };

const CLUSTER = arg('cluster') || process.env.SOLANA_CLUSTER || 'devnet';
const RPC = arg('rpc') || process.env.RPC_URL
  || (CLUSTER === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const PROGRAM_ID = process.env.PROGRAM_ID || '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy';
const CONFIG_PDA = process.env.CONFIG_PDA || 'DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29';
const sol = lamports => `${(lamports / 1e9).toFixed(6)} SOL`;

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

// ── who holds the two permanent roles ───────────────────────────────────────
//
// Read from the chain rather than from configuration, because what the server
// believes and what the program enforces are different claims, and only one of
// them decides where money goes.
const configAccount = await rpc('getAccountInfo', [CONFIG_PDA, { encoding: 'base64', commitment: 'confirmed' }]);
if (!configAccount?.value) throw new Error(`no config at ${CONFIG_PDA} on ${CLUSTER} — has InitConfig been run?`);
const config = escrow.decodeConfig(Buffer.from(configAccount.value.data[0], 'base64'));

// ── what has actually been earned ───────────────────────────────────────────
//
// Derived from the commissions themselves, so it can be recomputed by anybody
// and does not depend on this service having recorded anything.
const accounts = await rpc('getProgramAccounts', [PROGRAM_ID, {
  commitment: 'confirmed', encoding: 'base64',
  filters: [{ dataSize: escrow.COMMISSION_ACCOUNT_BYTES }, { memcmp: { offset: 0, bytes: '3' } }],
}]);

let pledged = 0, released = 0, refunded = 0, feeFromReleases = 0, feeFromRefunds = 0, live = 0;
const creators = new Set();
for (const entry of accounts) {
  let c;
  try { c = escrow.decodeCommission(Buffer.from(entry.account.data[0], 'base64')); } catch { continue; }
  creators.add(c.creator);
  pledged += c.pledged;
  released += c.released;
  refunded += c.refunded;
  feeFromReleases += Math.floor((c.released * escrow.FEE_BASIS_POINTS) / 10_000);
  // A refund is only charged if a delivery was ever made. A commission nobody
  // worked on costs its backers nothing, which is the point.
  if (c.submissions > 0) feeFromRefunds += Math.floor((c.refunded * escrow.FEE_BASIS_POINTS) / 10_000);
  if (!['shipped', 'refunded'].includes(c.status)) live += escrow.escrowRemaining(c);
}
const earned = feeFromReleases + feeFromRefunds;
const balance = (await rpc('getBalance', [config.treasury, { commitment: 'confirmed' }]))?.value ?? 0;

console.log(`\ntreasury status \u2014 ${CLUSTER}\n`);
console.log(`  treasury      ${config.treasury}`);
console.log(`  admin         ${config.admin}${config.paused ? '   (BOARD IS PAUSED)' : ''}`);
console.log('');
console.log(`  commissions   ${accounts.length}, ${sol(pledged)} pledged over their lifetime`);
console.log(`  released      ${sol(released)} to agents`);
console.log(`  refunded      ${sol(refunded)} to backers`);
console.log(`  still escrowed${' '.repeat(1)}${sol(live)}  \u2190 not yours, and never will be`);
console.log('');
console.log(`  fees earned   ${sol(earned)}  (${sol(feeFromReleases)} on releases, ${sol(feeFromRefunds)} on refunds)`);
console.log(`  treasury holds${' '.repeat(1)}${sol(balance)}`);

// ── is this wallet doing more than one job? ─────────────────────────────────
//
// The reason to care is not tidiness. Each role has a different worst case, and
// collapsing them means every worst case shares one key.
const problems = [];
if (config.admin === config.treasury) {
  problems.push('The admin and the treasury are the same wallet. The admin key gets used — it '
    + 'is how you pause — and the treasury key should almost never be online. One of those '
    + 'habits has to lose, and it will be the safe one.');
}
if (creators.has(config.treasury)) {
  problems.push('The treasury has posted commissions itself, so it is also an operating wallet '
    + 'that signs regularly. Fee income and operating float are then indistinguishable: the '
    + `balance above is ${sol(balance)}, of which roughly ${sol(earned)} is actually revenue.`);
}
if (problems.length) {
  console.log('\n  \u26a0 role overlap');
  for (const problem of problems) console.log(`    \u2022 ${problem}`);
}

// ── how to take it out ──────────────────────────────────────────────────────
//
// Deliberately printed rather than executed. A script that sweeps needs the
// treasury key at hand, which is the exact property the treasury should not
// have; and a payout is rare enough that typing it is not a burden.
console.log('\n  to pay yourself, from wherever that key lives:');
console.log(`    solana transfer <YOUR_WALLET> ${(earned / 1e9).toFixed(6)} \\`);
console.log(`      --from <TREASURY_KEYPAIR> --fee-payer <TREASURY_KEYPAIR> --url ${RPC}`);
console.log('\n  The treasury never signs as part of this protocol, so a payout is an ordinary');
console.log('  transfer and nothing about the board is involved. Leave enough behind to stay');
console.log('  rent-exempt (0.00089 SOL) or the account is closed and future fees are lost.');

process.exit(0);

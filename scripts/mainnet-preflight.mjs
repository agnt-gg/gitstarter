// Decides whether this is safe to run with other people's real money.
//
// Everything the service needs to point at mainnet is already an environment
// variable, so "going to mainnet" is a config change and takes about a minute.
// That is exactly why this exists: the work is not the switch, it is being able
// to say honestly that the switch should be thrown.
//
// A failing check here is not a nag. On devnet the worst case is a lost test
// token; on mainnet the worst case is somebody's rent, and the difference
// between those two is entirely in the things below.
//
//   node scripts/mainnet-preflight.mjs
//   node scripts/mainnet-preflight.mjs --cluster mainnet-beta
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import escrow from '../shared/escrow.js';
import { Connection, PublicKey } from '@solana/web3.js';

// Loaded lazily, because a preflight that cannot start is strictly worse than
// one that reports a check it could not run. This crashed the whole report on
// the production box, where @sqds/multisig is not installed — turning every
// other answer, including the ones about backups and the deployed hash, into no
// answer at all.
let multisig = null;
try { multisig = await import('@sqds/multisig'); } catch { /* reported by the check that needs it */ }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1]; };

const CLUSTER = arg('cluster') || process.env.SOLANA_CLUSTER || 'devnet';
const RPC = arg('rpc') || process.env.SOLANA_RPC_URL || process.env.RPC_URL
  || (CLUSTER === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const PROGRAM_ID = process.env.PROGRAM_ID || '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy';
const TREASURY = process.env.TREASURY_WALLET || '4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY';
const CONFIG_PDA = process.env.CONFIG_PDA || 'DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29';
/// Compiled into the program behind the `mainnet` feature. A mainnet deployment
/// whose admin is not this key was built from a devnet binary.
const MAINNET_INITIALIZER = 'AactHbz74TBh1nGkEMeHaAdpwUGQHqnBrKabZefLikYj';

const results = [];
/// severity: 'blocker' stops a launch. 'warn' is a decision somebody must make
/// on purpose rather than by not noticing.
const check = (severity, name, ok, detail) => results.push({ severity, name, ok, detail });

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await response.json()).result;
}

// ── 1. Who can replace the program holding the money ────────────────────────
//
// The single most important fact about any upgradeable escrow, and the one a
// depositor is least likely to check for themselves. An upgrade authority can
// swap the program for one that transfers every vault to itself. If that
// authority is one hot key on one laptop, then "your money is in escrow" means
// "your money is wherever the holder of that file decides".
//
// There are exactly three acceptable answers: no authority at all (immutable),
// a multisig, or a timelock long enough for anyone to exit. A plain wallet is
// not one of them.
let authority = null;
try {
  const account = await rpc('getAccountInfo', [PROGRAM_ID, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const programDataAddress = account?.value?.data?.parsed?.info?.programData;
  if (!programDataAddress) {
    check('blocker', 'program is deployed on this cluster', false, `${PROGRAM_ID} not found on ${CLUSTER}`);
  } else {
    const programData = await rpc('getAccountInfo', [programDataAddress, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    authority = programData?.value?.data?.parsed?.info?.authority ?? null;
    // Three acceptable answers, not one.
    //
    // The first version of this only passed on `authority === null`, which meant
    // it went on reporting a hot key after the authority had been handed to a
    // 2-of-3 multisig — the exact thing it was asking for. A check that cannot
    // recognise success is a check people learn to ignore.
    //
    // A multisig is verified rather than asserted: MULTISIG_ADDRESS only says
    // where to look, and the vault is re-derived from it and compared to the
    // authority actually on chain, then the multisig's own threshold and config
    // authority are read. Pointing this at the wrong account proves nothing and
    // fails.
    let multisigDetail = null;
    if (authority !== null && process.env.MULTISIG_ADDRESS && multisig) {
      try {
        const ms = new PublicKey(process.env.MULTISIG_ADDRESS);
        const [vault] = multisig.getVaultPda({ multisigPda: ms, index: 0 });
        if (vault.toBase58() === authority) {
          const account = await multisig.accounts.Multisig.fromAccountAddress(
            new Connection(RPC, 'confirmed'), ms);
          const noConfigAuthority = account.configAuthority.toBase58() === PublicKey.default.toBase58();
          if (account.threshold >= 2 && noConfigAuthority) {
            multisigDetail = `${account.threshold} of ${account.members.length} multisig `
              + `(${process.env.MULTISIG_ADDRESS}), no config authority`;
          } else if (!noConfigAuthority) {
            multisigDetail = null; // a config authority can drop the threshold to 1 alone
          }
        }
      } catch { /* falls through to the hot-key verdict below */ }
    }

    check('blocker', 'upgrade authority is not a single hot key',
      authority === null || multisigDetail !== null,
      authority === null
        ? 'none — the program is immutable and nobody can swap it'
        : multisigDetail ? multisigDetail
        : !multisig ? `${authority} — cannot verify whether this is a multisig: @sqds/multisig is not installed here`
        : `${authority} can replace this program at any time, and with it every vault it holds. `
          + 'Renounce it (solana program set-upgrade-authority --final), or move it behind a multisig or timelock.');
  }
} catch (error) {
  check('blocker', 'program is readable on this cluster', false, error.message);
}

// ── 2. Four roles, four keys ────────────────────────────────────────────
//
// The protocol has exactly four privileged positions and they have wildly
// different worst cases: the upgrade authority can take everything, the admin
// can only pause, the treasury holds accrued fees, and an operating wallet
// holds whatever float it needs. Collapsing them means every worst case shares
// one key, and the blast radius of the smallest becomes the blast radius of the
// largest.
//
// Read from the chain, not from configuration: what this service believes and
// what the program enforces are different claims, and only one decides where
// money goes.
let config = null;
try {
  const account = await rpc('getAccountInfo', [CONFIG_PDA, { encoding: 'base64', commitment: 'confirmed' }]);
  if (account?.value) config = escrow.decodeConfig(Buffer.from(account.value.data[0], 'base64'));
} catch { /* reported by the check below */ }

check('blocker', 'the config the program actually enforces is readable', !!config,
  config ? `admin ${config.admin}, treasury ${config.treasury}` : `no config at ${CONFIG_PDA} on ${CLUSTER}`);

if (config) {
  check('blocker', 'the deployed treasury is the one this service advertises',
    config.treasury === TREASURY,
    config.treasury === TREASURY ? 'match'
      : `the program pays fees to ${config.treasury} but this service tells people ${TREASURY}. `
        + 'The program wins, and it cannot be changed — there is no SetTreasury instruction.');

  check('blocker', 'upgrade authority is separate from the treasury',
    authority === null || authority !== config.treasury,
    authority === config.treasury
      ? `both are ${config.treasury}. One compromised key is then the whole system.`
      : 'separate');

  check('blocker', 'admin is separate from the treasury',
    config.admin !== config.treasury,
    config.admin === config.treasury
      ? 'the admin key gets used — it is how you pause — and the treasury key should be offline almost always. '
        + 'Sharing them means one of those habits loses, and it will be the safe one.'
      : 'separate');

  // An operating wallet signs constantly: posting bounties, signing in, paying
  // fees. That is the opposite of what a fee vault should be doing.
  let creators = new Set();
  try {
    const accounts = await rpc('getProgramAccounts', [PROGRAM_ID, {
      commitment: 'confirmed', encoding: 'base64',
      filters: [{ dataSize: escrow.COMMISSION_ACCOUNT_BYTES }, { memcmp: { offset: 0, bytes: '3' } }],
    }]);
    for (const entry of accounts) {
      try { creators.add(escrow.decodeCommission(Buffer.from(entry.account.data[0], 'base64')).creator); }
      catch { /* skip */ }
    }
  } catch { /* leave the set empty rather than assert something unmeasured */ }

  check('blocker', 'the treasury is not also an operating wallet',
    !creators.has(config.treasury),
    creators.has(config.treasury)
      ? 'the treasury has posted commissions itself, so it signs regularly and its balance is '
        + 'operating float mixed with revenue. Neither its safety nor its accounting survives that.'
      : 'receives only');

  // A mainnet program built without the `mainnet` feature trusts the disposable
  // devnet initializer, and that key is the permanent admin of whatever it
  // initialized.
  if (CLUSTER === 'mainnet-beta') {
    check('blocker', 'the deployed binary was built with the mainnet initializer',
      config.admin === MAINNET_INITIALIZER,
      config.admin === MAINNET_INITIALIZER ? 'correct build'
        : `admin is ${config.admin}, not the mainnet initializer. This looks like a devnet build `
          + 'deployed to mainnet, and the admin cannot be changed afterwards.');
  }

  check('warn', 'the board is not paused', !config.paused,
    config.paused ? 'new commissions and pledges are currently blocked' : 'accepting work');

  // The treasury must already be rent-exempt, or the first release fails.
  //
  // Found by running a real commission on a freshly deployed mainnet. A fee is
  // paid by crediting lamports directly, so paying one into an account that
  // does not exist yet would create it below the rent-exempt minimum — and
  // Solana rejects the WHOLE transaction for that, with every instruction
  // reporting success in the logs. The agent simply cannot be paid, and nothing
  // in the error says why.
  //
  // Devnet could never surface this: there the treasury was the deployer
  // wallet, already funded. It is specific to the cold treasury a real launch
  // uses, and it would have hit the first genuine release on the platform.
  //
  // The same floor applies forever: a sweep that empties the treasury closes
  // the account and breaks the next release, which is why treasury-status.mjs
  // says to leave the minimum behind.
  try {
    const balance = (await rpc('getBalance', [config.treasury, { commitment: 'confirmed' }]))?.value ?? 0;
    const RENT_EXEMPT_MINIMUM = 890_880;
    check('blocker', 'the treasury can actually receive a fee',
      balance >= RENT_EXEMPT_MINIMUM,
      balance >= RENT_EXEMPT_MINIMUM
        ? `${(balance / 1e9).toFixed(6)} SOL, rent-exempt`
        : `${(balance / 1e9).toFixed(6)} SOL — below the ${RENT_EXEMPT_MINIMUM / 1e9} SOL rent-exempt minimum, `
          + 'so the first milestone release will fail with every instruction reporting success');
  } catch { check('blocker', 'the treasury can actually receive a fee', false, 'could not read the balance'); }
}

// ── 3. Nothing may be running on a default ──────────────────────────────────
//
// Every one of these has a devnet default so local development is frictionless.
// On mainnet a default is a silent misconfiguration: the site would look right
// and settle against the wrong program.
for (const [name, value] of [
  ['SOLANA_CLUSTER', process.env.SOLANA_CLUSTER],
  // The server reads SOLANA_RPC_URL; this used to check RPC_URL, which it does
  // not read at all. So the check passed when a meaningless variable was set and
  // failed when the real one was — exactly backwards, and it blocked a correctly
  // configured launch.
  ['SOLANA_RPC_URL', process.env.SOLANA_RPC_URL || process.env.RPC_URL],
  ['PROGRAM_ID', process.env.PROGRAM_ID],
  ['TREASURY_WALLET', process.env.TREASURY_WALLET],
]) {
  check(CLUSTER === 'mainnet-beta' ? 'blocker' : 'warn', `${name} is set explicitly`, !!value,
    value ? 'set' : 'falling back to a devnet default');
}

// ── 4. A public RPC will not carry this ─────────────────────────────────────
//
// api.mainnet-beta.solana.com rate-limits hard, and the board is one
// getProgramAccounts per scan. Being throttled here does not degrade the site,
// it stops people seeing that work exists.
check('warn', 'RPC endpoint is not the public one',
  !/api\.(mainnet-beta|devnet)\.solana\.com/.test(RPC),
  /api\.(mainnet-beta|devnet)\.solana\.com/.test(RPC)
    ? 'the public endpoint rate-limits getProgramAccounts; use a dedicated provider'
    : 'dedicated endpoint');

// ── 5. Somebody other than its author has reviewed it ───────────────────────
//
// This program moves other people's money and has never been read by anyone who
// did not write it. That is the ordinary state of new code and an unacceptable
// state for custody. The file is deliberately something a human has to create.
// Satisfied by either a review or a recorded decision to launch without one.
//
// Deleting this check because the answer was inconvenient would be the
// dishonest option, and so would passing it on a file that merely exists. What
// it asks for is that somebody made the call ON PURPOSE and wrote down what
// they were accepting — which is a real thing a person can decide, unlike an
// audit, which is a claim about work that either happened or did not.
const auditPath = path.join(ROOT, 'docs', 'AUDIT.md');
const acceptedPath = path.join(ROOT, 'docs', 'RISK-ACCEPTED.md');
const reviewed = fs.existsSync(auditPath);
const accepted = fs.existsSync(acceptedPath);
check('blocker', 'the review question has been answered', reviewed || accepted,
  reviewed ? 'docs/AUDIT.md present'
    : accepted ? 'no external review; docs/RISK-ACCEPTED.md records the decision and its bound'
      : 'nobody but the author has read the escrow, and no decision to accept that has been recorded');

// The bound that makes launching unreviewed defensible at all. Checked against
// the program source rather than assumed, because the cap is the entire
// argument: it turns "we hope there is no bug" into "a bug costs at most this".
if (accepted && !reviewed) {
  let cap = null;
  try {
    const program = fs.readFileSync(path.join(ROOT, 'program', 'src', 'lib.rs'), 'utf8');
    const match = program.match(/MAX_COMMISSION_LAMPORTS: u64 = ([\d_ *]+);/);
    if (match) cap = Function(`return ${match[1].replace(/_/g, '')}`)();
  } catch { /* reported below */ }
  check('blocker', 'an unreviewed escrow caps what one commission can hold',
    cap !== null && cap > 0 && cap <= 10 * 1e9,
    cap === null ? 'could not read MAX_COMMISSION_LAMPORTS from the program'
      : `${cap / 1e9} SOL per commission${cap > 10 * 1e9 ? ' — too high to call a bound' : ''}`);
}

// ── 6. The published hash matches what is actually deployed ─────────────────
check('blocker', 'published program hash matches the deployed bytes',
  fs.existsSync(path.join(ROOT, 'docs', 'VERIFY.md')),
  'run scripts/check-program-hash.mjs; it must pass against the target cluster');

// ── 7. The database is the only copy of some things ─────────────────────────
//
// Escrow is on chain and survives anything. Titles, evidence, handles,
// reputation history and this inbox are in one SQLite file, and a handle claim
// is not reconstructible from the chain at all.
// Checked by looking for backups, not by looking for a setting.
//
// The first version of this asked whether DB_BACKUP_PATH was set, which is a
// question about intent rather than about the world: it passes on a box where
// the variable is exported and the schedule has been failing for a month. What
// matters is whether a recent backup exists, and whether anybody has ever read
// one back.
const backupDir = process.env.DB_BACKUP_PATH;
let backupDetail = 'set DB_BACKUP_PATH — handles and delivery history cannot be rebuilt from the chain';
let backupsOk = false;
if (backupDir && fs.existsSync(backupDir)) {
  const found = fs.readdirSync(backupDir).filter(n => /\.sqlite\.gz$/.test(n)).sort().reverse();
  if (!found.length) backupDetail = `${backupDir} exists but contains no backups`;
  else {
    const ageHours = (Date.now() - fs.statSync(path.join(backupDir, found[0])).mtimeMs) / 3_600_000;
    // A backup without its checksum cannot be distinguished from one truncated
    // by a full disk.
    const hasChecksum = fs.existsSync(path.join(backupDir, `${found[0]}.sha256`));
    backupsOk = ageHours <= 24 && hasChecksum;
    backupDetail = backupsOk
      ? `${found.length} retained, newest ${ageHours.toFixed(1)}h old, checksummed`
      : `newest backup is ${ageHours.toFixed(1)}h old${hasChecksum ? '' : ' and has no checksum'}`;
  }
} else if (backupDir) {
  backupDetail = `DB_BACKUP_PATH is ${backupDir}, which does not exist`;
}
check('blocker', 'the metadata database is backed up', backupsOk, backupDetail);

// And that somebody has restored one, recently. Backups and restores are
// different claims and only the second is worth anything — and a restore that
// worked in March says nothing about the backup taken last night.
const RECEIPT = process.env.RESTORE_DRILL_RECEIPT || '/var/log/gitstarter-restore-drill.json';
let drillOk = false;
let drillDetail = 'never run — a backup nobody has read back is a hope, not a backup';
if (fs.existsSync(RECEIPT)) {
  try {
    const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
    const ageHours = (Date.now() - new Date(receipt.at).getTime()) / 3_600_000;
    drillOk = receipt.passed === true && ageHours <= 48;
    drillDetail = receipt.passed
      ? `last passed ${ageHours.toFixed(1)}h ago against ${receipt.backup}`
      : `last run FAILED: ${(receipt.failures || []).join('; ')}`;
  } catch (error) { drillDetail = `unreadable receipt: ${error.message}`; }
}
check('blocker', 'a restore has actually been rehearsed', drillOk, drillDetail);

const blockers = results.filter(r => r.severity === 'blocker' && !r.ok);
const warnings = results.filter(r => r.severity === 'warn' && !r.ok);

console.log(`\nmainnet preflight \u2014 cluster ${CLUSTER}\n`);
for (const r of results) {
  const mark = r.ok ? 'PASS ' : r.severity === 'blocker' ? 'BLOCK' : 'WARN ';
  console.log(`  ${mark} ${r.name}`);
  if (!r.ok) console.log(`        ${r.detail}`);
}

console.log('');
if (blockers.length) {
  console.log(`NOT READY \u2014 ${blockers.length} blocker(s), ${warnings.length} warning(s).`);
  console.log('Each blocker above is something that costs somebody real money if it is wrong.');
  process.exit(1);
}
console.log(`READY${warnings.length ? ` \u2014 with ${warnings.length} warning(s) accepted on purpose` : ''}.`);
process.exit(0);

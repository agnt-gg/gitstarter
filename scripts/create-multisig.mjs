// Creates the 2-of-3 Squads multisig that will hold the program's upgrade
// authority, and verifies what it actually created.
//
// The upgrade authority is the only key in this system that can take everything:
// whoever holds it can replace the escrow program with one that drains every
// vault. A multisig does not make that power smaller, it makes it require two
// people — so the point of this script is less "create a multisig" and more
// "create one whose settings cannot quietly be undone".
//
// Three settings carry that weight, and all three are checked after the fact
// rather than merely passed in:
//
//   configAuthority: null   Without this, ONE key can add members, drop the
//                           threshold to 1, and unilaterally own the multisig.
//                           A 2-of-3 with a config authority is a 1-of-1
//                           wearing a costume.
//   threshold: 2 of 3       Two so no single compromised device can act. Three
//                           so a lost device is a nuisance rather than a
//                           permanently unupgradeable program with live money
//                           in it.
//   timeLock: 0             Deliberate. A timelock would let people exit ahead
//                           of an upgrade they dislike, which is a real
//                           protection, but it also delays fixing an active
//                           exploit. Revisit once there is enough at stake to
//                           be worth the trade.
//
//   node scripts/create-multisig.mjs                      rehearse on devnet
//   node scripts/create-multisig.mjs --cluster mainnet-beta --confirm
import fs from 'node:fs';
import {
  Connection, Keypair, PublicKey, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as multisig from '@sqds/multisig';

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1]; };
const CLUSTER = arg('cluster') || 'devnet';
const RPC = arg('rpc') || (CLUSTER === 'mainnet-beta'
  ? (process.env.RPC_URL || 'https://api.mainnet-beta.solana.com')
  : 'https://api.devnet.solana.com');

/// The three signers. Two are Nathan's own wallets; the third exists so that
/// losing one device does not strand the program.
const MEMBERS = [
  { label: 'Nathan, main', key: '2B8YDoo4Q3JJZuuGqqqVP86xoahgMsqREr3ScxhGS8C5' },
  { label: 'Nathan, alt', key: 'CzWRYDTxwJP44TZqP4A5f9bNEaQNRJw5cygUtKD2xyxP' },
  { label: 'recovery', key: '3YkcozncNpombu98hqxYaKTxGqLcWDQxq5JJUvKXWTFf' },
];
const THRESHOLD = 2;

// Whoever pays for creation. Deliberately NOT the treasury: that key should
// stay offline, and the payer here has no lasting power anyway — once
// configAuthority is null, the creator is just the wallet that footed the rent.
const payerPath = process.env.MULTISIG_PAYER_KEYPAIR
  || (CLUSTER === 'mainnet-beta' ? null : process.env.DEPLOYER_KEYPAIR);
if (!payerPath) throw new Error('set MULTISIG_PAYER_KEYPAIR to the wallet that should pay for creation');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(payerPath, 'utf8'))));

if (CLUSTER === 'mainnet-beta' && !argv.includes('--confirm')) {
  throw new Error('refusing to touch mainnet without --confirm. Creating a multisig there costs real SOL '
    + 'and the address it produces is the one you will hand the upgrade authority to.');
}

const connection = new Connection(RPC, 'confirmed');
const { Permissions } = multisig.types;

// Squads charges a creation fee, read from its own on-chain config rather than
// assumed, so this reports the real cost before spending anything.
const programConfigPda = multisig.getProgramConfigPda({})[0];
const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);

const balance = await connection.getBalance(payer.publicKey);
console.log(`\ncreating a ${THRESHOLD}-of-${MEMBERS.length} multisig on ${CLUSTER}\n`);
console.log(`  payer          ${payer.publicKey.toBase58()}`);
console.log(`  balance        ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
console.log(`  squads fee     ${(Number(programConfig.multisigCreationFee) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
console.log('  members');
for (const m of MEMBERS) console.log(`    ${m.label.padEnd(14)} ${m.key}`);

// A throwaway key that only seeds the multisig's address. It signs creation and
// is then irrelevant, which is why it is generated here and never stored.
const createKey = Keypair.generate();
const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });

// Said BEFORE sending, not after.
//
// The public mainnet RPC gives up confirming after 30 seconds, and a timeout is
// not a failure — it means "unknown". The first attempt at this hit exactly that,
// and because the address was only printed on success, a transaction that had
// actually landed would have left a live multisig whose address nobody knew:
// the createKey that derives it is ephemeral and exists only in this process.
//
// Printing first turns an unknown outcome into a checkable one.
console.log(`\n  multisig       ${multisigPda.toBase58()}`);
console.log(`  VAULT          ${vaultPda.toBase58()}`);
console.log('                 ^ derived before sending, so a timeout is recoverable');
console.log('\n  sending\u2026');

const signature = await multisig.rpc.multisigCreateV2({
  connection,
  createKey,
  creator: payer,
  multisigPda,
  // The whole point. Null means no single key can rewrite the membership.
  configAuthority: null,
  timeLock: 0,
  members: MEMBERS.map(m => ({
    key: new PublicKey(m.key),
    // Propose, vote and execute. Every signer can do the whole job, so the
    // threshold is the only thing gating an upgrade.
    permissions: Permissions.all(),
  })),
  threshold: THRESHOLD,
  rentCollector: null,
  treasury: programConfig.treasury,
  sendOptions: { skipPreflight: false },
});

// Wait for the ACCOUNT, not for the signature.
//
// Confirming a signature answers "did my transaction land", which is a question
// about the mechanism. The thing actually worth knowing is whether the multisig
// exists — and that survives an RPC that drops the connection, a retry, or a
// second run of this script.
const deadline = Date.now() + 120_000;
let created = null;
while (Date.now() < deadline) {
  created = await connection.getAccountInfo(multisigPda, 'confirmed');
  if (created) break;
  await new Promise(resolve => setTimeout(resolve, 3_000));
}
if (!created) {
  console.log(`\n  the account has not appeared after two minutes.`);
  console.log(`  signature: ${signature}`);
  console.log(`  check:     ${multisigPda.toBase58()}`);
  console.log('  Nothing was lost if it never landed — the payer keeps its SOL and this can');
  console.log('  be rerun. Verify before retrying, so a landed transaction is not duplicated.');
  process.exit(1);
}

// ── read back what was actually created ─────────────────────────────────────
//
// Passing the right arguments and having the right multisig are different
// claims. This checks the second one.
const account = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
const failures = [];
if (account.threshold !== THRESHOLD) failures.push(`threshold is ${account.threshold}, not ${THRESHOLD}`);
if (account.members.length !== MEMBERS.length) failures.push(`${account.members.length} members, not ${MEMBERS.length}`);

const onChainMembers = account.members.map(m => m.key.toBase58());
for (const m of MEMBERS) {
  if (!onChainMembers.includes(m.key)) failures.push(`${m.label} (${m.key}) is not a member`);
}
// PublicKey.default is how the program stores "no config authority".
const configAuthority = account.configAuthority.toBase58();
if (configAuthority !== PublicKey.default.toBase58()) {
  failures.push(`configAuthority is ${configAuthority} — that key can rewrite the membership on its own, `
    + 'which makes the threshold decorative');
}
if (Number(account.timeLock) !== 0) failures.push(`timeLock is ${account.timeLock}`);

console.log(`\n  created        ${signature}`);
console.log(`  multisig       ${multisigPda.toBase58()}`);
console.log(`  VAULT          ${vaultPda.toBase58()}`);
console.log('                 ^ this is the address that becomes the upgrade authority');
console.log('\n  verified on chain');
console.log(`    threshold        ${account.threshold} of ${account.members.length}`);
console.log(`    configAuthority  ${configAuthority === PublicKey.default.toBase58() ? 'none \u2014 only the members can change this multisig' : configAuthority}`);
console.log(`    timeLock         ${account.timeLock}`);
for (const m of MEMBERS) {
  const found = account.members.find(x => x.key.toBase58() === m.key);
  console.log(`    ${m.label.padEnd(14)} ${found ? 'member' : 'MISSING'}`);
}

if (failures.length) {
  console.log('\nFAILED');
  for (const f of failures) console.log(`  \u2022 ${f}`);
  process.exit(1);
}

console.log('\nthe next step, when you are ready to hand over the program:');
console.log(`  solana program set-upgrade-authority <PROGRAM_ID> \\`);
console.log(`    --new-upgrade-authority ${vaultPda.toBase58()} \\`);
console.log('    --keypair <CURRENT_AUTHORITY_KEYPAIR> --skip-new-upgrade-authority-signer-check \\');
console.log(`    --url ${RPC}`);
console.log('\nAfter that, every upgrade needs two of the three signers, and this machine');
console.log('alone can no longer change the program that holds other people\u2019s money.');

process.exit(0);

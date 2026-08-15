// One complete commission on mainnet, with real money, before anybody is told
// this exists.
//
// Everything up to here proves the program was deployed correctly. This proves
// it WORKS: that money goes in, a stranger's delivery can be judged, the agent
// is paid, the fee reaches the treasury, and every deposit comes home. Those are
// different claims, and only this one is about the thing people actually care
// about.
//
// Deliberately tiny. The point is to find a mistake at a size where finding it
// is merely embarrassing.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import escrow from '../shared/escrow.js';

const ctx = {
  programId: 'HYrwoRKRdPDpuwTHAv3BzbdGXtTVrMe6vzBFefX8RiH4',
  configPda: 'E7tHZCvZWB6fQLwZA6KCipgJszjPn4ZTzSUdZC1XX4x2',
  treasury: '6RehrefK9bq2U8dJse96GjGGHm8t6mznxGR1Qj2e1A5P',
};
const ESCROW = 0.01 * LAMPORTS_PER_SOL;
const connection = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const creator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.CREATOR_KEYPAIR, 'utf8'))));
const agent = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.AGENT_KEYPAIR, 'utf8'))));

const pause = (ms = 1500) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` :: ${detail}` : ''}`);
};
const send = (instructions, signers) => sendAndConfirmTransaction(
  connection, new Transaction().add(...[].concat(instructions)), signers, { commitment: 'confirmed' },
);
const balance = key => connection.getBalance(new PublicKey(key), 'confirmed');
const exists = async key => !!(await connection.getAccountInfo(new PublicKey(key), 'confirmed'));

console.log('\na full commission on MAINNET, with real SOL\n');
console.log(`  creator ${creator.publicKey.toBase58()}`);
console.log(`  agent   ${agent.publicKey.toBase58()}`);
console.log(`  escrow  ${ESCROW / LAMPORTS_PER_SOL} SOL\n`);

// ── post it ─────────────────────────────────────────────────────────────────
const seed = Date.now();
const built = escrow.build.createCommission(ctx, {
  creator: creator.publicKey, seed,
  goalLamports: ESCROW,
  milestoneBasisPoints: [10_000],
  deadlineUnix: Math.floor(Date.now() / 1000) + 7 * 86_400,
  workWindowSeconds: 3 * 86_400,
  reviewWindowSeconds: 86_400,
});
await send(built.instruction, [creator]);
await pause();
const commission = built.commission.toBase58();
check('a commission can be created', await exists(commission), commission);

await send(escrow.build.pledge(ctx, {
  backer: creator.publicKey, commission, amountLamports: ESCROW,
}).instruction, [creator]);
await pause();
let state = escrow.decodeCommission((await connection.getAccountInfo(new PublicKey(commission), 'confirmed')).data);
check('funding it moves real SOL into escrow', state.status === 'funded' && state.pledged === ESCROW,
  `${state.status}, ${state.pledged / LAMPORTS_PER_SOL} SOL`);

// ── a different wallet delivers, with nobody's permission ───────────────────
const evidence = `mainnet launch verification ${new Date().toISOString()}`;
await send(escrow.build.submitDelivery(ctx, {
  agent: agent.publicKey, commission, milestoneIndex: 0,
  evidenceHash: crypto.createHash('sha256').update(evidence, 'utf8').digest(),
}).instruction, [agent]);
await pause();
state = escrow.decodeCommission((await connection.getAccountInfo(new PublicKey(commission), 'confirmed')).data);
check('any wallet may deliver without being selected', state.submissions === 1);

// ── judge and pay ───────────────────────────────────────────────────────────
const agentBefore = await balance(agent.publicKey);
const treasuryBefore = await balance(ctx.treasury);

// Settling, so the deposit sweep rides along on the same signature.
const vault = escrow.vaultPda(ctx.programId, commission);
const signature = await send([
  escrow.build.releaseMilestone(ctx, {
    creator: creator.publicKey, commission, agent: agent.publicKey, milestoneIndex: 0,
  }).instruction,
  escrow.build.closeVault(ctx, { signer: creator.publicKey, commission, creator: creator.publicKey }).instruction,
  escrow.build.closePledge(ctx, { backer: creator.publicKey, commission }).instruction,
  escrow.build.closeSubmission(ctx, { agent: agent.publicKey, commission, milestoneIndex: 0 }).instruction,
], [creator]);
await pause();

state = escrow.decodeCommission((await connection.getAccountInfo(new PublicKey(commission), 'confirmed')).data);
check('the commission settles', state.status === 'shipped', state.status);

const paid = (await balance(agent.publicKey)) - agentBefore;
const fee = (await balance(ctx.treasury)) - treasuryBefore;
const expectedFee = Math.floor((ESCROW * escrow.FEE_BASIS_POINTS) / 10_000);
check('the agent is paid 99% plus their deposit back',
  paid === ESCROW - expectedFee + escrow.SUBMISSION_RENT_LAMPORTS,
  `${paid / LAMPORTS_PER_SOL} SOL`);
check('the treasury receives exactly 1%', fee === expectedFee,
  `${fee / LAMPORTS_PER_SOL} SOL to the cold wallet`);

for (const [label, address] of [['vault', vault], ['pledge', escrow.pledgePda(ctx.programId, commission, creator.publicKey)],
  ['submission', escrow.submissionPda(ctx.programId, commission, 0, agent.publicKey)]]) {
  check(`the ${label} deposit came home automatically`, !(await exists(address)));
}

// ── the cap is real here too ────────────────────────────────────────────────
try {
  await send(escrow.build.createCommission(ctx, {
    creator: creator.publicKey, seed: seed + 1,
    goalLamports: escrow.MAX_COMMISSION_LAMPORTS + 1,
    milestoneBasisPoints: [10_000],
    deadlineUnix: Math.floor(Date.now() / 1000) + 86_400,
    workWindowSeconds: 3_600, reviewWindowSeconds: 3_600,
  }).instruction, [creator]);
  check('the 5 SOL cap is enforced on mainnet', false, 'an over-cap commission was ACCEPTED');
} catch (error) {
  check('the 5 SOL cap is enforced on mainnet',
    escrow.explainError(error)?.name === 'CommissionTooLarge', escrow.explainError(error)?.name);
}

console.log(`\n  settlement signature ${signature}`);
console.log(`\n${results.every(Boolean) ? 'MAINNET WORKS END TO END' : 'FAILURES ABOVE'}`);
connection._rpcWebSocket?.close();
process.exit(results.every(Boolean) ? 0 : 1);

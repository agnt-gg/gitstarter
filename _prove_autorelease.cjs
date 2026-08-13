// The one guarantee a warped test clock cannot fully prove: that a real
// creator, going genuinely silent for a real hour, ends up paying anyway.
//
// Creates a commission with the minimum one-hour review window, submits a
// delivery, waits out the wall clock, then has an UNRELATED wallet release the
// milestone. Takes ~65 minutes by design.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const escrow = require('./shared/escrow');

(async () => {
  const ctx = {
    programId: '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy',
    configPda: 'DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29',
    treasury: '4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY',
  };
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))));
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const send = (instruction, signers = []) =>
    sendAndConfirmTransaction(connection, new Transaction().add(instruction), [payer, ...signers], { commitment: 'confirmed' });
  const stamp = () => new Date().toISOString().slice(11, 19);
  const read = async a => escrow.decodeCommission((await connection.getAccountInfo(new PublicKey(a), 'confirmed')).data);

  const agent = Keypair.generate();
  const stranger = Keypair.generate();
  for (const kp of [agent, stranger]) {
    await send(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }));
    await wait(1500);
  }

  const built = escrow.build.createCommission(ctx, {
    creator: payer.publicKey, seed: Date.now(), goalLamports: 2_000_000,
    milestoneBasisPoints: [10_000], deadlineUnix: Math.floor(Date.now() / 1000) + 86_400,
    deliveryWindowSeconds: 7_200, reviewWindowSeconds: 3_600,
  });
  await send(built.instruction); await wait(1500);
  await send(escrow.build.pledge(ctx, { backer: payer.publicKey, commission: built.commission, amountLamports: 2_000_000 }).instruction);
  await wait(1500);
  await send(escrow.build.selectAgent(ctx, { creator: payer.publicKey, commission: built.commission, agent: agent.publicKey }).instruction);
  await wait(1500);
  await send(escrow.build.acceptAgent(ctx, { agent: agent.publicKey, commission: built.commission }).instruction, [agent]);
  await wait(1500);
  await send(escrow.build.submitDelivery(ctx, {
    agent: agent.publicKey, commission: built.commission, milestoneIndex: 0, evidenceHash: 'ee'.repeat(32),
  }).instruction, [agent]);
  await wait(2000);

  const submitted = await read(built.commission);
  console.log(`${stamp()} commission ${built.commission.toBase58()}`);
  console.log(`${stamp()} submitted; review ends ${new Date(submitted.submission.reviewEndsAt * 1000).toISOString()}`);
  console.log(`${stamp()} the creator will now do NOTHING, which is the whole point.`);

  const target = submitted.submission.reviewEndsAt;
  while (Math.floor(Date.now() / 1000) < target + 20) {
    const left = target - Math.floor(Date.now() / 1000);
    console.log(`${stamp()} ${Math.max(0, Math.ceil(left / 60))} min remaining; releasableByAnyone=${escrow.reviewExpired(await read(built.commission))}`);
    await wait(Math.min(300_000, Math.max(20_000, (left + 21) * 1000)));
  }

  const matured = await read(built.commission);
  assert.equal(escrow.reviewExpired(matured), true, 'the claim must have matured');
  const agentBefore = await connection.getBalance(agent.publicKey);

  await send(escrow.build.releaseMilestone(ctx, {
    creator: stranger.publicKey, commission: built.commission, agent: agent.publicKey, milestoneIndex: 0,
  }).instruction, [stranger]);
  await wait(2000);

  const paid = await connection.getBalance(agent.publicKey) - agentBefore;
  const final = await read(built.commission);
  assert.equal(paid, 1_980_000, 'agent must receive 99% of the milestone');
  assert.equal(final.status, 'shipped');
  assert.equal(final.autoReleases, 1, 'the auto-release is recorded against the creator');
  console.log(`\n${stamp()} PROVEN ON CHAIN: a silent creator paid ${paid / 1e9} SOL automatically.`);
  console.log(`${stamp()} released by ${stranger.publicKey.toBase58()}, who has no stake in this commission.`);
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

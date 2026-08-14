'use strict';
process.env.DATABASE_PATH = require('node:path').join(require('node:os').tmpdir(), `gitstarter-agent-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const { PublicKey } = require('@solana/web3.js');
const escrow = require('../../shared/escrow');
const { app, db } = require('../server');

let server, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise(r => server.close(r)); db.close(); });

const PROGRAM = '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy';
const CONFIG = 'DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29';
const TREASURY = '4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY';
const ctx = { programId: PROGRAM, configPda: CONFIG, treasury: TREASURY };
const SYSTEM = '11111111111111111111111111111111';

// Real addresses from the live devnet bounty. If the derivation code drifts,
// these stop matching what is actually on chain.
const LIVE_COMMISSION = 'J2DtKVrZj6hxHejkHQhBcKWWz2HHJAhDcCDUwbcKkChQ';
const LIVE_VAULT = '319sBtryomPyakD9FCSrbFbZxx8V1BcodeEgw9n4M8fe';
const LIVE_PLEDGE = '9auFfeuUDCQp8zhTGLr6dDtPSFWdcxzSSbPqVqMbidiY';

test('PDA derivation reproduces addresses that exist on chain', () => {
  assert.equal(escrow.vaultPda(PROGRAM, LIVE_COMMISSION).toBase58(), LIVE_VAULT);
  assert.equal(escrow.pledgePda(PROGRAM, LIVE_COMMISSION, TREASURY).toBase58(), LIVE_PLEDGE);
});

test('instruction encoding matches the program', () => {
  const creator = new PublicKey(TREASURY).toBase58();
  const agent = 'AactHbz74TBh1nGkEMeHaAdpwUGQHqnBrKabZefLikYj';

  const create = escrow.build.createCommission(ctx, {
    creator, seed: 7, goalLamports: 1_000_000,
    milestoneBasisPoints: [5000, 5000], deadlineUnix: 1_900_000_000,
    workWindowSeconds: 7_200, reviewWindowSeconds: 3_600,
  });
  const d = create.instruction.data;
  assert.equal(d[0], 1);
  assert.equal(Number(d.readBigUInt64LE(1)), 7);
  assert.equal(Number(d.readBigUInt64LE(9)), 1_000_000);
  assert.equal(d.readUInt32LE(17), 2);
  assert.equal(d.readUInt16LE(21), 5000);
  assert.equal(d.readUInt16LE(23), 5000);
  assert.equal(Number(d.readBigInt64LE(25)), 1_900_000_000);
  // The two clocks are appended after the funding deadline.
  assert.equal(Number(d.readBigInt64LE(33)), 7_200, 'work window');
  assert.equal(Number(d.readBigInt64LE(41)), 3_600, 'review window');
  assert.equal(d.length, 49);
  assert.deepEqual(create.instruction.keys.map(k => k.pubkey.toBase58()),
    [creator, CONFIG, create.commission.toBase58(), create.vault.toBase58(), SYSTEM]);
  assert.deepEqual(create.instruction.keys.map(k => [k.isSigner, k.isWritable]),
    [[true, true], [false, false], [false, true], [false, true], [false, false]]);

  const pledge = escrow.build.pledge(ctx, { backer: creator, commission: LIVE_COMMISSION, amountLamports: 50_000_000 });
  assert.equal(pledge.instruction.data[0], 2);
  assert.equal(Number(pledge.instruction.data.readBigUInt64LE(1)), 50_000_000);
  assert.equal(pledge.vault.toBase58(), LIVE_VAULT);

  assert.deepEqual([...escrow.build.inviteAgent(ctx, { creator, commission: LIVE_COMMISSION, agent }).instruction.data], [3]);
  assert.deepEqual([...escrow.build.refund(ctx, { backer: creator, commission: LIVE_COMMISSION }).instruction.data], [5]);
  assert.deepEqual([...escrow.build.cancel(ctx, { signer: creator, commission: LIVE_COMMISSION }).instruction.data], [6]);
  assert.deepEqual([...escrow.build.signalIntent(ctx, { agent, commission: LIVE_COMMISSION }).instruction.data], [8]);
  assert.deepEqual([...escrow.build.withdrawIntent(ctx, { agent, commission: LIVE_COMMISSION }).instruction.data], [9]);
  assert.deepEqual([...escrow.build.closeSubmission(ctx, { agent, commission: LIVE_COMMISSION, milestoneIndex: 0 }).instruction.data], [14]);
  assert.deepEqual([...escrow.build.closeIntent(ctx, { agent, commission: LIVE_COMMISSION }).instruction.data], [15]);

  // Delivery submission carries the milestone index and a 32-byte commitment.
  const submit = escrow.build.submitDelivery(ctx, {
    agent, commission: LIVE_COMMISSION, milestoneIndex: 1, evidenceHash: 'ab'.repeat(32),
  });
  assert.equal(submit.instruction.data[0], 10);
  assert.equal(submit.instruction.data[1], 1);
  assert.equal(submit.instruction.data.length, 34, 'discriminant + index + 32-byte hash');
  // The submission has its own account, so several agents can compete on one
  // milestone without overwriting each other.
  assert.deepEqual(submit.instruction.keys.map(k => k.pubkey.toBase58()),
    [agent, LIVE_COMMISSION, submit.submission.toBase58(), SYSTEM]);
  assert.throws(() => escrow.build.submitDelivery(ctx, {
    agent, commission: LIVE_COMMISSION, milestoneIndex: 0, evidenceHash: 'abcd',
  }), /exactly 32 bytes/, 'a short commitment must be refused, not silently padded');

  assert.deepEqual([...escrow.build.rejectDelivery(ctx, { creator, commission: LIVE_COMMISSION, agent, milestoneIndex: 1 }).instruction.data], [11]);

  const release = escrow.build.releaseMilestone(ctx, { creator, commission: LIVE_COMMISSION, agent, milestoneIndex: 1 });
  // The milestone is no longer an argument: it is read off the submission being
  // paid, which is what stops a caller redirecting the money.
  assert.deepEqual([...release.instruction.data], [4]);
  // The treasury must be the account the fee is actually paid to.
  assert.deepEqual(release.instruction.keys.map(k => k.pubkey.toBase58()),
    [creator, LIVE_COMMISSION, release.submission.toBase58(), LIVE_VAULT, agent, TREASURY]);
  // signer, commission, submission, vault, agent, treasury
  assert.deepEqual(release.instruction.keys.map(k => k.isWritable), [false, true, true, true, true, true]);
});

test('commission decoding reads every field at the right offset', () => {
  const b = Buffer.alloc(escrow.COMMISSION_ACCOUNT_BYTES);
  b[0] = 2;
  new PublicKey(TREASURY).toBuffer().copy(b, 1);    // creator
  new PublicKey(TREASURY).toBuffer().copy(b, 65);   // treasury
  b.writeBigUInt64LE(9n, 97);                       // seed
  b.writeBigUInt64LE(1_000n, 105);                  // goal
  b.writeBigUInt64LE(900n, 113);                    // total_pledged
  b.writeBigUInt64LE(400n, 121);                    // released
  b.writeBigUInt64LE(100n, 129);                    // refunded
  b.writeUInt32LE(3, 137);                          // pledger_count
  b.writeUInt32LE(1, 141);                          // refunded_pledger_count
  new PublicKey(TREASURY).toBuffer().copy(b, 145);  // invited_agent
  b[177] = 0;                                       // has_invite: OPEN by default
  b[178] = 1;                                       // status = funded
  b[179] = 2;                                       // milestone_count
  b.writeUInt16LE(3000, 180);
  b.writeUInt16LE(7000, 182);
  b[196] = 0b01;                                    // first milestone released
  b.writeBigInt64LE(1_900_000_000n, 197);           // deadline
  b.writeBigInt64LE(7_200n, 207);                   // work_window
  b.writeBigInt64LE(1_800_007_200n, 215);           // work_deadline
  b.writeBigInt64LE(3_600n, 223);                   // review_window
  b[231] = 3;                                       // 3 submitted on milestone 0
  b[239] = 1;                                       // 1 of them rejected
  b.writeUInt32LE(2, 247);                          // unresolved
  b.writeBigInt64LE(1_800_000_500n, 251);           // latest_submitted_at
  b.writeUInt32LE(3, 259);                          // submissions
  b.writeUInt32LE(1, 263);                          // rejections
  b.writeUInt32LE(0, 267);                          // auto_releases
  b.writeUInt32LE(5, 271);                          // intents

  const c = escrow.decodeCommission(b);
  assert.equal(c.status, 'funded');
  assert.equal(c.goal, 1000);
  assert.equal(c.pledged, 900);
  assert.equal(c.released, 400);
  assert.equal(c.refunded, 100);
  assert.equal(c.pledgerCount, 3);
  assert.equal(c.refundedPledgerCount, 1);
  // Open by default is the whole product, so an unset invitation must read as
  // absent rather than as the zero address.
  assert.equal(c.invitedAgent, null);
  assert.equal(c.isOpen, true);
  assert.deepEqual(c.milestoneBps, [3000, 7000]);
  assert.equal(c.milestonesDone, 1);
  assert.equal(c.deadline, 1_900_000_000);
  assert.equal(c.workWindow, 7_200);
  assert.equal(c.workDeadline, 1_800_007_200);
  assert.equal(c.reviewWindow, 3_600);
  assert.deepEqual(c.milestoneSubmitted, [3, 0]);
  assert.deepEqual(c.milestoneRejected, [1, 0]);
  assert.equal(c.unresolvedSubmissions, 2);
  assert.equal(c.latestSubmittedAt, 1_800_000_500);
  assert.equal(c.submissions, 3);
  assert.equal(c.rejections, 1);
  assert.equal(c.intents, 5);
  assert.equal(escrow.escrowRemaining(c), 400);

  // An invitation, when a creator deliberately sets one.
  b[177] = 1;
  assert.equal(escrow.decodeCommission(b).invitedAgent, TREASURY);
  assert.equal(escrow.decodeCommission(b).isOpen, false);

  assert.throws(() => escrow.decodeCommission(Buffer.alloc(100)), /Not a commission/);
});

test('submission decoding carries the queue position and state', () => {
  const b = Buffer.alloc(escrow.SUBMISSION_ACCOUNT_BYTES);
  b[0] = 4;
  new PublicKey(LIVE_COMMISSION).toBuffer().copy(b, 1);
  new PublicKey(TREASURY).toBuffer().copy(b, 33);
  b[65] = 1;                                        // milestone_index
  b[66] = 2;                                        // sequence
  b.writeBigInt64LE(1_800_000_000n, 67);
  Buffer.alloc(32, 0xab).copy(b, 75);               // evidence_hash
  b[107] = 0;                                       // pending

  const s = escrow.decodeSubmission(b);
  assert.equal(s.commission, LIVE_COMMISSION);
  assert.equal(s.agent, TREASURY);
  assert.equal(s.milestoneIndex, 1);
  assert.equal(s.sequence, 2);
  assert.equal(s.state, 'pending');
  assert.equal(s.evidenceHash, 'ab'.repeat(32));
  assert.equal(escrow.reviewEndsAt(s, 3_600), 1_800_003_600);

  b[107] = 2;
  assert.equal(escrow.decodeSubmission(b).state, 'rejected');
  assert.equal(
    escrow.reviewExpired(escrow.decodeSubmission(b), 3_600, 2_000_000_000), false,
    'a judged submission can never mature into a second payment');
});

test('availableActions answers what a wallet may actually do', () => {
  const creator = 'Cre1111111111111111111111111111111111111111';
  const alice = 'Agn1111111111111111111111111111111111111111';
  const bob = 'Bgn1111111111111111111111111111111111111111';
  const now = Math.floor(Date.now() / 1000);
  const future = now + 1000;
  const past = now - 1000;
  const base = {
    creator, invitedAgent: null, isOpen: true, milestoneCount: 1, milestoneBps: [10000],
    milestonesDone: 0, deadline: future, workWindow: 7200, workDeadline: future,
    reviewWindow: 3600, milestoneSubmitted: [0], milestoneRejected: [0],
    unresolvedSubmissions: 0, latestSubmittedAt: 0, pledged: 0, released: 0, refunded: 0,
    pledgerCount: 0, refundedPledgerCount: 0, submissions: 0, rejections: 0,
    autoReleases: 0, intents: 0,
  };
  const sub = (agent, sequence, submittedAt, state = 'pending') =>
    ({ agent, milestoneIndex: 0, sequence, submittedAt, state, evidenceHash: 'ab'.repeat(32) });

  assert.deepEqual(escrow.availableActions({ ...base, status: 'funding' }, bob, { nowUnix: now }), ['pledge']);

  // THE POINT: a funded commission is workable by anyone, with no permission.
  const funded = { ...base, status: 'funded' };
  assert.ok(escrow.availableActions(funded, alice, { nowUnix: now }).includes('submitDelivery'));
  assert.ok(escrow.availableActions(funded, bob, { nowUnix: now }).includes('submitDelivery'));
  assert.ok(escrow.availableActions(funded, alice, { nowUnix: now }).includes('signalIntent'));
  assert.ok(
    !escrow.availableActions(funded, creator, { nowUnix: now }).includes('submitDelivery'),
    'a creator who could also be paid is a one-signature path to draining backers');
  assert.ok(
    escrow.availableActions(funded, creator, { nowUnix: now }).includes('inviteAgent'),
    'narrowing the board stays available, it is just not the default');

  // An invitation closes it to everyone else.
  const invited = { ...base, status: 'funded', invitedAgent: alice, isOpen: false };
  assert.ok(escrow.availableActions(invited, alice, { nowUnix: now }).includes('submitDelivery'));
  assert.ok(!escrow.availableActions(invited, bob, { nowUnix: now }).includes('submitDelivery'));

  // Two competing deliveries: only the front of the queue is judgeable.
  const queued = {
    ...base, status: 'funded', milestoneSubmitted: [2], unresolvedSubmissions: 2,
    latestSubmittedAt: now, submissions: 2,
  };
  const submissions = [sub(alice, 0, now), sub(bob, 1, now)];
  assert.ok(escrow.availableActions(queued, creator, { nowUnix: now, submissions }).includes('rejectDelivery'));
  assert.ok(escrow.availableActions(queued, creator, { nowUnix: now, submissions }).includes('releaseMilestone'));
  assert.equal(escrow.frontOfQueue(queued, submissions, 0).agent, alice);

  // Once the front has matured, anyone may complete the payment.
  assert.ok(
    escrow.availableActions(queued, bob, { nowUnix: now + 3600, submissions }).includes('releaseMilestone'),
    'silence has to resolve to payment or stiffing an agent is free again');

  // Past every deadline, refunds open.
  const expired = { ...base, status: 'funded', deadline: past, workDeadline: past };
  assert.ok(escrow.availableActions(expired, bob, { nowUnix: now }).includes('refund'));
  assert.ok(!escrow.availableActions(expired, bob, { nowUnix: now }).includes('submitDelivery'));
});
test('program errors are translated into something an agent can act on', () => {
  assert.equal(escrow.explainError(new Error('custom program error: 0x18')).name, 'SelfDealing');
  assert.equal(escrow.explainError(new Error('custom program error: 0x19')).name, 'DeadlineTooFar');
  assert.equal(escrow.explainError(new Error('something else')), null);
});

test('llms.txt is served, fully interpolated, and states the real program', async () => {
  const response = await fetch(base + '/llms.txt');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/plain/);
  const body = await response.text();
  assert.equal(/\{\{\w+\}\}/.test(body), false, 'every placeholder must be interpolated');
  assert.ok(body.includes(PROGRAM), 'must name the deployed program');
  assert.ok(body.includes(CONFIG));
  assert.ok(body.includes('/api/v1/commissions'));
  assert.ok(body.includes('Never send a private key anywhere'));
  assert.ok(body.includes('no independent professional audit') || body.includes('No independent professional audit'));
});

test('transaction endpoints validate before touching the network', async () => {
  const post = (action, body) => fetch(`${base}/api/v1/tx/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  assert.equal((await post('not-a-real-action', {})).status, 404);

  // Nomination is gone entirely. Nothing stands between a funded commission and
  // an agent who wants to work on it.
  assert.equal((await post('select-agent', {})).status, 404, 'nomination must not still be reachable');
  assert.equal((await post('accept-agent', {})).status, 404);

  const badMilestones = await post('create-commission', { creator: TREASURY, goalSol: 1, milestoneBasisPoints: [5000, 4000] });
  assert.equal(badMilestones.status, 400);
  assert.match((await badMilestones.json()).error, /sum to 10000/);

  const tooFar = await post('create-commission', { creator: TREASURY, goalSol: 1, deadlineDays: 400 });
  assert.equal(tooFar.status, 400);
  assert.match((await tooFar.json()).error, /30 days/);

  // The work and review clocks are bounded on both sides.
  const shortWork = await post('create-commission', { creator: TREASURY, goalSol: 1, workWindowSeconds: 60 });
  assert.equal(shortWork.status, 400);
  assert.match((await shortWork.json()).error, /Work window/);

  const longReview = await post('create-commission', { creator: TREASURY, goalSol: 1, reviewHours: 24 * 30 });
  assert.equal(longReview.status, 400);
  assert.match((await longReview.json()).error, /Review window/);

  const badIndex = await post('submit-delivery', { agent: TREASURY, commission: LIVE_COMMISSION, milestoneIndex: 99 });
  assert.equal(badIndex.status, 400);
  assert.match((await badIndex.json()).error, /milestoneIndex/);

  const tooSmall = await post('create-commission', { creator: TREASURY, goalLamports: 500 });
  assert.equal(tooSmall.status, 400);
  assert.match((await tooSmall.json()).error, /at least 10000 lamports/);

  const noAmount = await post('pledge', { backer: TREASURY, commission: LIVE_COMMISSION });
  assert.equal(noAmount.status, 400);
  assert.match((await noAmount.json()).error, /amountLamports or amountSol/);

  const badWallet = await post('pledge', { backer: 'nope', commission: LIVE_COMMISSION, amountSol: 1 });
  assert.equal(badWallet.status, 400);
});

test('no agent endpoint ever asks for a private key', async () => {
  const body = await (await fetch(base + '/llms.txt')).text();
  for (const forbidden of ['privateKey', 'secretKey', 'seedPhrase', 'mnemonic']) {
    assert.equal(body.includes(`"${forbidden}"`), false, `llms.txt must not request ${forbidden}`);
  }
});

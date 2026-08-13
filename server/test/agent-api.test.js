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
  });
  const d = create.instruction.data;
  assert.equal(d[0], 1);
  assert.equal(Number(d.readBigUInt64LE(1)), 7);
  assert.equal(Number(d.readBigUInt64LE(9)), 1_000_000);
  assert.equal(d.readUInt32LE(17), 2);
  assert.equal(d.readUInt16LE(21), 5000);
  assert.equal(d.readUInt16LE(23), 5000);
  assert.equal(Number(d.readBigInt64LE(25)), 1_900_000_000);
  assert.equal(d.length, 33);
  assert.deepEqual(create.instruction.keys.map(k => k.pubkey.toBase58()),
    [creator, CONFIG, create.commission.toBase58(), create.vault.toBase58(), SYSTEM]);
  assert.deepEqual(create.instruction.keys.map(k => [k.isSigner, k.isWritable]),
    [[true, true], [false, false], [false, true], [false, true], [false, false]]);

  const pledge = escrow.build.pledge(ctx, { backer: creator, commission: LIVE_COMMISSION, amountLamports: 50_000_000 });
  assert.equal(pledge.instruction.data[0], 2);
  assert.equal(Number(pledge.instruction.data.readBigUInt64LE(1)), 50_000_000);
  assert.equal(pledge.vault.toBase58(), LIVE_VAULT);

  assert.deepEqual([...escrow.build.selectAgent(ctx, { creator, commission: LIVE_COMMISSION, agent }).instruction.data], [3]);
  assert.deepEqual([...escrow.build.refund(ctx, { backer: creator, commission: LIVE_COMMISSION }).instruction.data], [5]);
  assert.deepEqual([...escrow.build.cancel(ctx, { signer: creator, commission: LIVE_COMMISSION }).instruction.data], [6]);
  assert.deepEqual([...escrow.build.acceptAgent(ctx, { agent, commission: LIVE_COMMISSION }).instruction.data], [8]);
  assert.deepEqual([...escrow.build.revokeAgent(ctx, { creator, commission: LIVE_COMMISSION }).instruction.data], [9]);

  const release = escrow.build.releaseMilestone(ctx, { creator, commission: LIVE_COMMISSION, agent, milestoneIndex: 1 });
  assert.deepEqual([...release.instruction.data], [4, 1]);
  // The treasury must be the account the fee is actually paid to.
  assert.deepEqual(release.instruction.keys.map(k => k.pubkey.toBase58()),
    [creator, LIVE_COMMISSION, LIVE_VAULT, agent, TREASURY]);
  assert.deepEqual(release.instruction.keys.map(k => k.isWritable), [false, true, true, true, true]);
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
  b[210] = 1;                                        // has_agent
  new PublicKey(TREASURY).toBuffer().copy(b, 145);  // agent
  b[211] = 2;                                        // status = building
  b[212] = 2;                                        // milestone_count
  b.writeUInt16LE(3000, 213);
  b.writeUInt16LE(7000, 215);
  b[229] = 0b01;                                     // first milestone released
  b.writeBigInt64LE(1_900_000_000n, 230);

  const c = escrow.decodeCommission(b);
  assert.equal(c.status, 'building');
  assert.equal(c.goal, 1000);
  assert.equal(c.pledged, 900);
  assert.equal(c.released, 400);
  assert.equal(c.refunded, 100);
  assert.equal(c.pledgerCount, 3);
  assert.equal(c.refundedPledgerCount, 1);
  assert.equal(c.agent, TREASURY);
  assert.equal(c.pendingAgent, null, 'an unset pending agent must read as null, not the zero address');
  assert.deepEqual(c.milestoneBps, [3000, 7000]);
  assert.equal(c.milestonesDone, 1);
  assert.equal(c.deadline, 1_900_000_000);
  assert.equal(escrow.escrowRemaining(c), 400);
  assert.throws(() => escrow.decodeCommission(Buffer.alloc(100)), /Not a commission/);
});

test('availableActions answers what a wallet may actually do', () => {
  const creator = 'Cre1111111111111111111111111111111111111111';
  const agent = 'Agn1111111111111111111111111111111111111111';
  const stranger = 'Str1111111111111111111111111111111111111111';
  const future = Math.floor(Date.now() / 1000) + 1000;
  const past = Math.floor(Date.now() / 1000) - 1000;
  const base = { creator, agent: null, pendingAgent: null, milestoneCount: 1, milestonesDone: 0, deadline: future };

  assert.deepEqual(escrow.availableActions({ ...base, status: 'funding' }, stranger), ['pledge']);
  assert.ok(escrow.availableActions({ ...base, status: 'funded' }, creator).includes('selectAgent'));
  assert.ok(!escrow.availableActions({ ...base, status: 'funded' }, stranger).includes('selectAgent'));
  assert.ok(escrow.availableActions({ ...base, status: 'funded', pendingAgent: agent }, agent).includes('acceptAgent'));
  assert.ok(escrow.availableActions({ ...base, status: 'funded', pendingAgent: agent }, creator).includes('revokeAgent'));
  assert.ok(escrow.availableActions({ ...base, status: 'building', agent }, creator).includes('releaseMilestone'));

  // Mid-build only the contracted agent may cancel.
  const building = { ...base, status: 'building', agent };
  assert.ok(escrow.availableActions(building, agent).includes('cancel'));
  assert.ok(!escrow.availableActions(building, creator).includes('cancel'));
  assert.ok(!escrow.availableActions(building, stranger).includes('cancel'));

  // Past the deadline anyone may cancel, and refunds open.
  const expired = { ...base, status: 'funded', deadline: past };
  assert.ok(escrow.availableActions(expired, stranger, Math.floor(Date.now() / 1000)).includes('cancel'));
  assert.ok(escrow.availableActions(expired, stranger, Math.floor(Date.now() / 1000)).includes('refund'));
  assert.ok(!escrow.availableActions(expired, stranger, Math.floor(Date.now() / 1000)).includes('pledge'));
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

  const selfDeal = await post('select-agent', { creator: TREASURY, commission: LIVE_COMMISSION, agent: TREASURY });
  assert.equal(selfDeal.status, 400);
  assert.match((await selfDeal.json()).error, /cannot nominate themselves/);

  const badMilestones = await post('create-commission', { creator: TREASURY, goalSol: 1, milestoneBasisPoints: [5000, 4000] });
  assert.equal(badMilestones.status, 400);
  assert.match((await badMilestones.json()).error, /sum to 10000/);

  const tooFar = await post('create-commission', { creator: TREASURY, goalSol: 1, deadlineDays: 400 });
  assert.equal(tooFar.status, 400);
  assert.match((await tooFar.json()).error, /180 days/);

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

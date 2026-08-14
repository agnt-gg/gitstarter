'use strict';
// Solana locks a refundable deposit in every account a commission opens, and
// settling is supposed to send all of them home in the same transaction so
// nobody is ever asked to collect their own money.
//
// The first version of that sweep covered the vault, the pledges and the
// submissions — and silently missed intents. An end-to-end run on devnet found
// 0.007 SOL still locked in intent accounts on commissions that had already
// shipped, which is exactly the chore the sweep was built to delete.
//
// This runs the SHIPPED cleanupInstructions against a stubbed RPC and asserts it
// emits a close for every account type the program can open. A new account type
// with a deposit fails here rather than quietly stranding money.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PublicKey } = require('@solana/web3.js');
const escrow = require('../../shared/escrow');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'app.js'), 'utf8');

function extract(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `could not locate ${name} in client/app.js`);
  let depth = 0, seen = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; seen = true; }
    else if (source[i] === '}') { depth--; if (seen && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

const PROGRAM = '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy';
const CREATOR = '2B8YDoo4Q3JJZuuGqqqVP86xoahgMsqREr3ScxhGS8C5';
const BACKER = '4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY';
const AGENT = 'BU3KCzcSRDSYkBgMPFJ7Dja1KcDNtFwBv4Q7eoPmyJsm';
const COMMISSION = '2ysH9FtQjpqWDeZERyYvEw8sEvbbXFjviTJCeMnikzJB';

/// Byte-accurate accounts, so the real decoders run rather than being stubbed.
function pledgeAccount(backer) {
  const b = Buffer.alloc(escrow.PLEDGE_ACCOUNT_BYTES);
  b[0] = 3;
  new PublicKey(COMMISSION).toBuffer().copy(b, 1);
  new PublicKey(backer).toBuffer().copy(b, 33);
  return { account: { data: b } };
}
function submissionAccount(agent, milestoneIndex) {
  const b = Buffer.alloc(escrow.SUBMISSION_ACCOUNT_BYTES);
  b[0] = 4;
  new PublicKey(COMMISSION).toBuffer().copy(b, 1);
  new PublicKey(agent).toBuffer().copy(b, 33);
  b[65] = milestoneIndex;
  return { account: { data: b } };
}
function intentAccount(agent) {
  const b = Buffer.alloc(escrow.INTENT_ACCOUNT_BYTES);
  b[0] = 5;
  new PublicKey(COMMISSION).toBuffer().copy(b, 1);
  new PublicKey(agent).toBuffer().copy(b, 33);
  return { account: { data: b } };
}

/// Runs the shipped sweep with an RPC that answers by dataSize filter.
function sweep({ pledges = [], submissions = [], intents = [], fail = false } = {}) {
  const state = {
    wallet: CREATOR,
    config: { programId: PROGRAM },
    connection: {
      getProgramAccounts: async (_program, { filters }) => {
        if (fail) throw new Error('RPC unavailable');
        const size = filters.find(f => f.dataSize !== undefined).dataSize;
        if (size === escrow.PLEDGE_ACCOUNT_BYTES) return pledges;
        if (size === escrow.SUBMISSION_ACCOUNT_BYTES) return submissions;
        if (size === escrow.INTENT_ACCOUNT_BYTES) return intents;
        return [];
      },
    },
  };
  const build = new Function('escrow', 'PublicKey', 'state', 'ESCROW_CTX', `
    ${extract(CLIENT, 'cleanupInstructions')}
    return cleanupInstructions;
  `)(escrow, PublicKey, state, {
    programId: PROGRAM, configPda: 'DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29', treasury: BACKER,
  });
  return build(COMMISSION, { creator: CREATOR });
}

const discriminants = instructions => instructions.map(i => i.data[0]);

test('settling returns the deposit on every account type the program opens', async () => {
  const instructions = await sweep({
    pledges: [pledgeAccount(BACKER)],
    submissions: [submissionAccount(AGENT, 0)],
    intents: [intentAccount(AGENT)],
  });
  const kinds = new Set(discriminants(instructions));

  // 13 vault, 12 pledge, 14 submission, 15 intent. Every one of these accounts
  // holds real SOL that belongs to somebody who is not the protocol.
  for (const [name, discriminant] of [
    ['vault', escrow.IX.closeVault],
    ['pledge', escrow.IX.closePledge],
    ['submission', escrow.IX.closeSubmission],
    ['intent', escrow.IX.closeIntent],
  ]) {
    assert.ok(kinds.has(discriminant), `the sweep never closes the ${name} account, so its deposit strands`);
  }
});

test('no account type that holds a deposit is left out of the sweep', async () => {
  // The generalisable version: if the program grows another account, it has a
  // rent-exemption deposit by definition, and this fails until it is swept.
  const closable = Object.entries(escrow.IX)
    .filter(([name]) => name.startsWith('close'))
    .map(([name, discriminant]) => ({ name, discriminant }));
  const emitted = new Set(discriminants(await sweep({
    pledges: [pledgeAccount(BACKER)],
    submissions: [submissionAccount(AGENT, 0)],
    intents: [intentAccount(AGENT)],
  })));
  for (const { name, discriminant } of closable) {
    assert.ok(emitted.has(discriminant), `escrow.build.${name} exists but the settling sweep never calls it`);
  }
});

test('every party gets their own deposit back, not the caller', async () => {
  const instructions = await sweep({
    pledges: [pledgeAccount(BACKER)],
    submissions: [submissionAccount(AGENT, 0), submissionAccount(CREATOR, 1)],
    intents: [intentAccount(AGENT)],
  });
  // Check EACH close individually against the record it closes. Asserting only
  // that a wallet appears somewhere in the destination list is too weak: the
  // agent shows up via their submission, which masks an intent deposit that has
  // been quietly repointed at whoever is signing.
  const destinationOf = discriminant =>
    instructions.filter(i => i.data[0] === discriminant).map(i => i.keys[0].pubkey.toBase58());

  assert.deepEqual(destinationOf(escrow.IX.closePledge), [BACKER],
    'a pledge deposit goes to the backer who put it up');
  assert.deepEqual(destinationOf(escrow.IX.closeIntent), [AGENT],
    'an intent deposit goes to the agent who declared it, never to the signer');
  assert.deepEqual(destinationOf(escrow.IX.closeSubmission).sort(), [AGENT, CREATOR].sort(),
    'each submission deposit goes to the agent named on that submission');
  assert.deepEqual(destinationOf(escrow.IX.closeVault), [CREATOR],
    'the vault reserve goes to the creator who paid for it');
});

test('the sweep needs no signature but the settler\'s own', async () => {
  // The whole design rests on this: the settling transaction is signed by ONE
  // wallet, and the backers and agents whose deposits are coming home are not
  // present to sign for their own money.
  //
  // CloseIntent was the one instruction that still demanded the agent's
  // signature. Bundling it made the entire cleanup unsendable, and because a
  // failed cleanup falls back to sending the payment alone, every deposit on
  // any commission with an intent silently stayed locked. Nothing failed
  // loudly; the money just did not move.
  const instructions = await sweep({
    pledges: [pledgeAccount(BACKER)],
    submissions: [submissionAccount(AGENT, 0)],
    intents: [intentAccount(AGENT)],
  });
  const settler = CREATOR;
  for (const instruction of instructions) {
    for (const key of instruction.keys) {
      assert.ok(
        !key.isSigner || key.pubkey.toBase58() === settler,
        `a close instruction requires ${key.pubkey.toBase58().slice(0, 8)} to sign, `
        + 'but only the settling wallet is there to do it',
      );
    }
  }
});

test('every close builder is safe to crank on somebody else\'s behalf', () => {
  // The generalisable version, checked against the builders directly rather
  // than through one sweep: a deposit return that needs its owner present is a
  // deposit that strands, because the owner is never present.
  const ctx = { programId: PROGRAM, configPda: 'DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29', treasury: BACKER };
  const cranker = CREATOR;
  const builders = {
    closePledge: escrow.build.closePledge(ctx, { backer: AGENT, commission: COMMISSION }),
    closeSubmission: escrow.build.closeSubmission(ctx, { agent: AGENT, commission: COMMISSION, milestoneIndex: 0 }),
    closeIntent: escrow.build.closeIntent(ctx, { agent: AGENT, commission: COMMISSION }),
    closeVault: escrow.build.closeVault(ctx, { signer: cranker, commission: COMMISSION, creator: BACKER }),
  };
  for (const [name, built] of Object.entries(builders)) {
    const signers = built.instruction.keys.filter(k => k.isSigner).map(k => k.pubkey.toBase58());
    assert.ok(
      signers.every(s => s === cranker),
      `escrow.build.${name} requires ${signers.join(', ')} to sign; a deposit whose `
      + 'return needs its owner present is a deposit that never comes back',
    );
  }
});

test('a sweep is capped so it cannot make the payment too large to send', async () => {
  // A transaction is size-limited and every account it touches costs bytes. A
  // busy commission must not be able to make its own final payment unsendable.
  const many = Array.from({ length: 12 }, (_, i) => submissionAccount(
    new PublicKey(Buffer.alloc(32, i + 1)).toBase58(), 0,
  ));
  const instructions = await sweep({ submissions: many });
  assert.ok(instructions.length <= 8, `sweep emitted ${instructions.length} instructions; it must be capped`);
});

test('housekeeping never takes the payment down with it', async () => {
  // If the RPC read fails, the settling transaction still has to go through with
  // the payment alone. Money must not be blocked by bookkeeping.
  assert.deepEqual(await sweep({ fail: true }), [],
    'an unavailable RPC must yield no cleanup rather than throwing into the payment path');
});

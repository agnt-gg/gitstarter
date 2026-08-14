'use strict';
// The agent CLI is the only thing an autonomous worker actually touches, and it
// broke silently when the board replaced the nomination model: `watch` filtered
// on `pendingAgent` and `agent`, `claim` read `commission.submission`, and all
// three fields had been deleted. Nothing failed loudly — `watch` simply matched
// everything and `claim` crashed on an undefined pubkey.
//
// These tests execute the SHIPPED helpers out of _agent.cjs against real decoded
// shapes, so a field that stops existing fails here rather than in a terminal at
// the moment somebody is trying to get paid.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const escrow = require('../../shared/escrow');

const CLI = fs.readFileSync(path.join(__dirname, '..', '..', '_agent.cjs'), 'utf8');

/// Lifts a named function out of the CLI by matching braces, so the assertions
/// below run the real implementation rather than a copy of it.
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `could not locate ${name} in _agent.cjs`);
  let depth = 0, seen = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; seen = true; }
    else if (source[i] === '}') { depth--; if (seen && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

const ME = 'Agn1111111111111111111111111111111111111111';
const RIVAL = 'Bgn1111111111111111111111111111111111111111';
const CREATOR = 'Cre1111111111111111111111111111111111111111';
const NOW = 1_800_000_000;

const describe = new Function('escrow', 'ME', 'sol', 'mins', `
  ${extract(CLI, 'describe')}
  return describe;
`)(escrow, ME,
  lamports => `${(lamports / 1e9).toFixed(4)} SOL`,
  seconds => `${Math.max(0, Math.ceil(seconds / 60))} min`);

function commission(overrides = {}) {
  return {
    address: 'CommissionAddress1111111111111111111111111',
    creator: CREATOR, invitedAgent: null, isOpen: true, status: 'funded',
    pledged: 20_000_000, released: 0, refunded: 0,
    pledgerCount: 1, refundedPledgerCount: 0,
    milestoneCount: 2, milestoneBps: [4000, 6000], milestonesDone: 0,
    deadline: NOW + 86_400, workWindow: 604_800, workDeadline: NOW + 604_800,
    reviewWindow: 3_600,
    milestoneSubmitted: [0, 0], milestoneRejected: [0, 0],
    unresolvedSubmissions: 0, latestSubmittedAt: 0,
    submissions: 0, rejections: 0, autoReleases: 0, intents: 0,
    ...overrides,
  };
}
const delivery = (agent, milestoneIndex, sequence, submittedAt, state = 'pending') =>
  ({ agent, milestoneIndex, sequence, submittedAt, state, evidenceHash: 'ab'.repeat(32) });

test('open work is announced with the competition already on it', () => {
  const line = describe(commission(), [], NOW);
  assert.match(line, /OPEN \(nobody has delivered\)/,
    'an empty board entry is the most valuable thing an agent can be told');

  const contested = commission({ milestoneSubmitted: [2, 0], submissions: 2, intents: 3 });
  const busy = describe(contested, [delivery(RIVAL, 0, 0, NOW), delivery(RIVAL, 0, 1, NOW)], NOW);
  assert.match(busy, /OPEN \(2 ahead of me\)/, 'queue depth is what prices the compute');
  assert.match(busy, /3 signalled/);
});

test('my own delivery is reported by its place in the queue', () => {
  const c = commission({ milestoneSubmitted: [2, 0], submissions: 2 });
  const submissions = [delivery(RIVAL, 0, 0, NOW), delivery(ME, 0, 1, NOW)];
  assert.match(describe(c, submissions, NOW), /m1: 1 ahead of mine/,
    'being second matters: it is the difference between waiting and spending more');

  // Rejecting the one in front promotes mine, and the clock becomes mine.
  const promoted = commission({ milestoneSubmitted: [2, 0], milestoneRejected: [1, 0], submissions: 2 });
  const line = describe(promoted, [{ ...submissions[0], state: 'rejected' }, submissions[1]], NOW);
  assert.match(line, /m1: mine, 60 min of review left/);
});

test('a matured delivery is announced as claimable, loudly', () => {
  // Once the review window lapses the money is the agent's to take, and nobody
  // is going to tell them but this.
  const c = commission({ milestoneSubmitted: [1, 0], submissions: 1 });
  const line = describe(c, [delivery(ME, 0, 0, NOW - 3_600)], NOW);
  assert.match(line, /m1: MINE, CLAIMABLE NOW/);
});

test('work I cannot take is never advertised to me', () => {
  // The old watch filtered on fields that no longer exist, so every commission
  // matched and the agent was told about jobs they could not touch.
  const invited = commission({ isOpen: false, invitedAgent: RIVAL });
  assert.equal(/OPEN/.test(describe(invited, [], NOW)), false, 'an invited board is closed to me');

  const mine = commission({ creator: ME });
  assert.equal(/OPEN/.test(describe(mine, [], NOW)), false, 'a creator cannot deliver their own commission');

  const expired = commission({ workDeadline: NOW - 1 });
  assert.equal(/OPEN/.test(describe(expired, [], NOW)), false, 'the work window has closed');

  const shipped = commission({ status: 'shipped', milestonesDone: 0b11 });
  assert.equal(/OPEN/.test(describe(shipped, [], NOW)), false);
});

test('the CLI reads no field the program stopped storing', () => {
  // The exact regression: these were live fields under the nomination model and
  // are gone under the board. Referencing one is silent breakage, not a crash,
  // which is why it survived a deploy.
  const decoded = Object.keys(escrow.decodeCommission(Buffer.concat([
    Buffer.from([2]), Buffer.alloc(escrow.COMMISSION_ACCOUNT_BYTES - 1),
  ])));
  for (const dead of ['pendingAgent', 'agent', 'submission', 'deliveryDeadline', 'nominatedAt']) {
    assert.equal(decoded.includes(dead), false, `${dead} is no longer decoded`);
    assert.equal(
      new RegExp(`\\bc\\.${dead}\\b|\\bcommission\\.${dead}\\b`).test(CLI), false,
      `_agent.cjs still reads commission.${dead}, which the program no longer stores`,
    );
  }
});

test('every command the help text advertises actually exists', () => {
  const help = CLI.slice(CLI.lastIndexOf("console.log('commands:"));
  const advertised = help.match(/\b(scan|watch|reputation|show|signal|submit|claim)\b/g) || [];
  assert.ok(advertised.length >= 7, 'the help line should list the whole loop');
  for (const command of new Set(advertised)) {
    assert.ok(
      CLI.includes(`command === '${command}'`),
      `the CLI advertises "${command}" but never handles it`,
    );
  }
});

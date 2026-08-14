'use strict';
// An agent's record has to survive being paid.
//
// Settling a commission closes its submission and intent accounts so the
// deposits go home without anyone being asked. Reputation used to be derived
// from exactly those accounts, so the moment an agent won, their entire history
// vanished: a wallet that had just been paid for three jobs reported
// `deliveries: 0, won: 0, earned: 0`. The side being judged lost its proof at
// the one moment the proof mattered.
//
// The outcome is recoverable without storing a verdict, because the queue is
// judged strictly in order and the commission keeps two counters that outlive
// every account. These tests pin that reconstruction against the SHIPPED
// helpers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const escrow = require('../../shared/escrow');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `could not locate ${name} in server.js`);
  let depth = 0, seen = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; seen = true; }
    else if (source[i] === '}') { depth--; if (seen && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

const { settledState, milestonePayout } = new Function('escrow', `
  ${extract(SERVER, 'settledState')}
  ${extract(SERVER, 'milestonePayout')}
  return { settledState, milestonePayout };
`)(escrow);

/// A commission with a given judging history, as the chain would report it
/// after every submission account has been swept away.
function commission({ rejected = [0], done = 0, status = 'shipped', bps = [10_000], pledged = 20_000_000 } = {}) {
  return {
    status, pledged,
    milestoneBps: bps,
    milestoneRejected: rejected,
    milestonesDone: done,
  };
}

test('the agent who won is still identifiable after the accounts are gone', () => {
  // One rejection ahead of them, milestone paid: the delivery at position 1 is
  // the one that was at the front of the queue when the money moved.
  const c = commission({ rejected: [1], done: 0b1 });
  assert.equal(settledState(c, 0, 1, 'pending'), 'released', 'the winner must survive settlement');
  assert.equal(settledState(c, 0, 0, 'pending'), 'rejected', 'and so must the refusal ahead of them');
});

test('a delivery nobody ever judged is not counted as a failure', () => {
  // Third in the queue on a milestone that paid out to the first: delivered in
  // good faith, never looked at. On an open board that is the normal cost of
  // competing and must not read as a rejection.
  const c = commission({ rejected: [0], done: 0b1 });
  assert.equal(settledState(c, 0, 2, 'pending'), 'superseded');
  assert.notEqual(settledState(c, 0, 2, 'pending'), 'rejected');
});

test('work still in the queue is reported as pending, not lost', () => {
  const live = commission({ rejected: [0], done: 0, status: 'funded' });
  assert.equal(settledState(live, 0, 0, 'pending'), 'pending', 'at the front, awaiting judgement');
  assert.equal(settledState(live, 0, 1, 'pending'), 'pending', 'behind somebody, still in play');
});

test('a commission that ended without paying judged nobody', () => {
  const refunded = commission({ rejected: [0], done: 0, status: 'refunded' });
  assert.equal(settledState(refunded, 0, 0, 'pending'), 'superseded',
    'the escrow went back, so this delivery was never judged either way');
});

test('an outcome actually observed on chain beats any inference', () => {
  // If the indexer saw the account in a terminal state, that reading wins. The
  // reconstruction is a fallback for accounts swept before they were read
  // again, never a second opinion about something already known.
  const c = commission({ rejected: [5], done: 0b1 });
  assert.equal(settledState(c, 0, 0, 'released'), 'released');
  assert.equal(settledState(c, 0, 9, 'rejected'), 'rejected');
});

test('a multi-milestone schedule is resolved per milestone', () => {
  // Different agents can win different milestones, so each is judged on its own
  // counters. Sharing one would credit a win on milestone 1 to whoever won 2.
  const c = commission({ rejected: [1, 0], done: 0b11, bps: [4_000, 6_000] });
  assert.equal(settledState(c, 0, 1, 'pending'), 'released', 'won the first milestone');
  assert.equal(settledState(c, 1, 0, 'pending'), 'released', 'and the second was won at position 0');
  assert.equal(settledState(c, 1, 1, 'pending'), 'superseded', 'the rival on the second won nothing');
});

test('earnings are the milestone slice less the connection fee', () => {
  // The number an agent checks against their wallet. It has to match what the
  // program actually paid, which is the bps slice minus 1%.
  const c = commission({ bps: [4_000, 6_000], pledged: 20_000_000 });
  assert.equal(milestonePayout(c, 0), 7_920_000, '40% of 0.02 SOL, less 1%');
  assert.equal(milestonePayout(c, 1), 11_880_000, '60% of 0.02 SOL, less 1%');
  assert.equal(
    milestonePayout(c, 0) + milestonePayout(c, 1), 19_800_000,
    'and the two together are the whole pot less the fee',
  );
});

test('reputation reads from the durable index, not from live accounts', () => {
  // The regression itself: deriving an agent's history from accounts that
  // settlement deletes is what erased it.
  const handler = SERVER.slice(SERVER.indexOf("app.get('/api/v1/reputation/:wallet'"));
  assert.match(handler, /FROM delivery_history WHERE agent = \?/,
    'an agent\'s deliveries must come from a record that outlives the sweep');
  assert.match(handler, /FROM intent_history WHERE agent = \?/,
    'and so must their declarations of intent');
  assert.equal(
    /const mine = \[\][\s\S]{0,400}submissionsFor\(address\)/.test(handler), false,
    'building the agent record by scanning live submission accounts is the bug',
  );
});

test('the index only ever copies what the chain said', () => {
  // It must never be able to invent a delivery. Every write is an observation
  // of an account that existed, and the outcome is reconciled against the
  // commission's own counters rather than stored as an opinion.
  const remember = SERVER.slice(SERVER.indexOf('const rememberDelivery'), SERVER.indexOf('function submissionsFor'));
  assert.match(remember, /INSERT INTO delivery_history/);
  assert.match(remember, /ON CONFLICT\(commission, milestone_index, agent\) DO UPDATE/,
    're-observing the same delivery must update it, never duplicate it');
  assert.match(remember, /rememberChainState\s*=\s*db\.transaction/,
    'a snapshot must be atomic, or a crash mid-scan leaves a half-written history');

  const scan = SERVER.slice(SERVER.indexOf('async function chainCommissions'));
  assert.match(scan.slice(0, 3000), /try \{ rememberChainState\([\s\S]{0,80}\} catch/,
    'an index that fails must never fail the read it was riding along on');
});

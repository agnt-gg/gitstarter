'use strict';
// The review clock runs whether or not anybody has the page open.
//
// That is the whole reason this exists. A creator who is handed finished work
// and never answers pays out automatically when the window lapses; an agent
// whose delivery matured has money sitting there unclaimed. Both were
// discoverable only by opening the right dialog and reading it, which is not a
// mechanism, it is a hope.
//
// Two properties matter more than the wording of any message: an event must
// reach the party who can act on it, and observing the same board twice must not
// tell anybody twice. These run the SHIPPED detector to check both.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const escrow = require('../../shared/escrow');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `could not locate ${name}`);
  let i = source.indexOf('(', start), parens = 0;
  for (; i < source.length; i++) {
    if (source[i] === '(') parens++;
    else if (source[i] === ')') { parens--; if (parens === 0) break; }
  }
  let depth = 0, seen = false;
  for (; i < source.length; i++) {
    if (source[i] === '{') { depth++; seen = true; }
    else if (source[i] === '}') { depth--; if (seen && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

const detectEvents = new Function('escrow', `${extract(SERVER, 'detectEvents')} return detectEvents;`)(escrow);

/// Most cases here are about pending work, which still comes from live
/// accounts; those pass no settled outcomes at all.
const withQueue = (commissions, queued, nowUnix) => detectEvents(commissions, queued, [], nowUnix);

const CREATOR = 'Cre1111111111111111111111111111111111111111';
const AGENT = 'Agn1111111111111111111111111111111111111111';
const RIVAL = 'Riv1111111111111111111111111111111111111111';
const ADDRESS = 'Com1111111111111111111111111111111111111111';
const NOW = 1_800_000_000;

const commission = (over = {}) => new Map([[ADDRESS, {
  creator: CREATOR, status: 'funded',
  milestoneCount: 2, milestoneBps: [5_000, 5_000], milestonesDone: 0,
  milestoneRejected: [0, 0], reviewWindow: 3_600,
  ...over,
}]]);
const delivery = (over = {}) => ({
  agent: AGENT, milestoneIndex: 0, sequence: 0, state: 'pending',
  submittedAt: NOW - 60, ...over,
});
const queue = (...list) => new Map([[ADDRESS, list]]);
const kinds = events => events.map(e => `${e.kind}->${e.wallet.slice(0, 3)}`);

test('the creator is told that work is waiting on them', () => {
  const events = withQueue(commission(), queue(delivery()), NOW);
  assert.deepEqual(kinds(events), ['delivery-waiting->Cre']);
  assert.match(events[0].body, /pays out when the window closes/,
    'and told what silence costs, because silence is the expensive option');
});

test('when the window lapses, both sides are told, and told different things', () => {
  // The creator has lost control of the outcome; the agent has money to take.
  // One event to both parties would necessarily be wrong for one of them.
  const events = withQueue(commission(), queue(delivery({ submittedAt: NOW - 7_200 })), NOW);
  assert.deepEqual(kinds(events).sort(), ['claimable->Agn', 'review-lapsed->Cre']);
  assert.match(events.find(e => e.wallet === AGENT).body, /yours to claim/);
});

test('observing the same board again tells nobody twice', () => {
  // The dedupe key encodes the transition, not the moment it was seen, so this
  // survives a restart, a crash mid-scan, and two servers scanning at once —
  // none of which a diff against remembered previous state would survive.
  const board = commission(), deliveries = queue(delivery());
  const first = withQueue(board, deliveries, NOW);
  const later = withQueue(board, deliveries, NOW + 900);
  assert.deepEqual(
    first.map(e => e.dedupeKey), later.map(e => e.dedupeKey),
    'the same board state must produce identical keys however often it is scanned',
  );
});

test('a new delivery on the same milestone is a different event', () => {
  // Rejecting one and receiving another must not be silently deduped into the
  // first notification, or the creator is never told about the replacement.
  const first = withQueue(commission(), queue(delivery()), NOW);
  const second = withQueue(
    commission({ milestoneRejected: [1, 0] }),
    queue(delivery({ state: 'rejected' }), delivery({ agent: RIVAL, sequence: 1 })),
    NOW,
  );
  const waiting = second.find(e => e.kind === 'delivery-waiting');
  assert.ok(waiting, 'the replacement delivery must raise its own event');
  assert.notEqual(waiting.dedupeKey, first[0].dedupeKey);
});

test('only the delivery at the front of the queue is anybody"s problem', () => {
  // Three agents delivered; two of them cannot be judged yet. Telling the
  // creator about all three would make the inbox describe work they cannot act
  // on, which is how an inbox becomes something people stop opening.
  const events = withQueue(commission(), queue(
    delivery({ sequence: 0 }),
    delivery({ agent: RIVAL, sequence: 1 }),
    delivery({ agent: 'Oth1111111111111111111111111111111111111111', sequence: 2 }),
  ), NOW);
  assert.equal(events.filter(e => e.kind === 'delivery-waiting').length, 1);
});

test('a judged delivery tells the agent what happened to it', () => {
  // Deliberately fed from the durable record with NO live account, because that
  // is the only state that ever exists: settling a commission judges the
  // delivery and sweeps its account in the same transaction, so an account
  // carrying 'released' is never observable. Reading these from the chain
  // shipped two events that could not fire.
  const settled = state => [{ commission: ADDRESS, milestoneIndex: 0, agent: AGENT, state }];

  const paid = detectEvents(commission({ milestonesDone: 0b1 }), new Map(), settled('released'), NOW);
  assert.deepEqual(kinds(paid), ['delivery-paid->Agn']);

  const refused = detectEvents(commission({ milestoneRejected: [1, 0] }), new Map(), settled('rejected'), NOW);
  assert.deepEqual(kinds(refused), ['delivery-rejected->Agn']);
  assert.match(refused[0].body, /contest it/,
    'a refusal must carry the one thing the agent can still do about it');
});

test('outcomes are never read from accounts that settlement deletes', () => {
  // The regression itself, stated as a property: with the account gone and the
  // durable record present, the agent must still be told.
  const events = detectEvents(
    commission({ milestonesDone: 0b1 }),
    new Map(),
    [{ commission: ADDRESS, milestoneIndex: 0, agent: AGENT, state: 'released' }],
    NOW,
  );
  assert.equal(events.length, 1, 'a swept delivery still has an outcome to report');

  const scan = SERVER.slice(SERVER.indexOf('const settled = [];'), SERVER.indexOf('recordEvents(detectEvents'));
  assert.match(scan, /FROM delivery_history/,
    'the scan must reconcile outcomes from the record that outlives the accounts');
  assert.match(scan, /settledState\(c, row\.milestone_index, row\.sequence, row\.last_state\)/);
});

test('a milestone that already paid raises nothing further', () => {
  const events = withQueue(
    commission({ milestonesDone: 0b1 }),
    queue(delivery({ state: 'pending', submittedAt: NOW - 7_200 })),
    NOW,
  );
  assert.deepEqual(events, [], 'settled work is not somebody\'s outstanding problem');
});

test('a dispute cannot touch the escrow', () => {
  // The line that makes disputes safe to offer at all: escrow a stranger could
  // freeze by objecting is escrow no creator would ever fund. This route may
  // only ever write a record.
  const route = SERVER.slice(SERVER.indexOf("app.post('/api/v1/disputes'"), SERVER.indexOf("app.post('/api/v1/disputes/respond'"));
  for (const forbidden of ['sendTransaction', 'releaseMilestone', 'refund', 'escrow.build']) {
    assert.equal(route.includes(forbidden), false, `a dispute must never reach ${forbidden}`);
  }
  assert.match(route, /INSERT INTO disputes/);
  // And it must be a claim the chain agrees with, or it is just a comment box.
  assert.match(route, /state !== 'rejected'/,
    'only somebody the chain says was refused may contest a refusal');
  assert.match(route, /FROM delivery_history WHERE commission = \? AND milestone_index = \? AND agent = \?/);
});

test('only the creator can answer, and silence is recorded as silence', () => {
  const route = SERVER.slice(SERVER.indexOf("app.post('/api/v1/disputes/respond'"));
  assert.match(route.slice(0, 200), /requireAuth/);
  assert.match(route, /dispute\.creator !== req\.wallet/,
    'anyone else answering on their behalf would make the record worthless');

  // The profile shows unanswered disputes as unanswered rather than hiding them.
  const profile = SERVER.slice(SERVER.indexOf('disputesAgainstThem'));
  assert.match(profile.slice(0, 600), /answered: !!row\.responded_at/);
});

test('the directory ranks by the number neither side can fake alone', () => {
  const route = SERVER.slice(SERVER.indexOf("app.get('/api/v1/agents'"));
  assert.match(route, /agents\.sort\(\(a, b\) => b\.solEarned - a\.solEarned/,
    'earnings required a creator to escrow and release, which is what makes them hard to manufacture');
  assert.match(route, /distinctCreators: agent\.creators\.size/,
    'and the cheapest way to fake a record is to pay yourself, so the counterparty count must be shown');
  assert.match(route, /\(agent\.won \+ agent\.rejected\)/,
    'win rate must be over judged work only');
});

test('the tables survive a restart with the same data', () => {
  // Notifications are the one thing here whose value is entirely in not being
  // lost: an event nobody saw and that is gone is worse than no inbox at all.
  const { openDatabase } = require('../db');
  const file = path.join(os.tmpdir(), `gitstarter-notify-${process.pid}.sqlite`);
  fs.rmSync(file, { force: true });

  const db = openDatabase(file);
  const insert = db.prepare(`INSERT INTO notifications (wallet,kind,commission,milestone_index,body,dedupe_key,created_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`);
  insert.run(CREATOR, 'delivery-waiting', ADDRESS, 0, 'body', 'waiting:x:0:0', Date.now());
  insert.run(CREATOR, 'delivery-waiting', ADDRESS, 0, 'body', 'waiting:x:0:0', Date.now());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 1,
    'the unique key is what makes re-scanning safe');
  db.close();

  const reopened = openDatabase(file);
  assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 1);
  reopened.close();
  fs.rmSync(file, { force: true });
});

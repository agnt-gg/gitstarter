'use strict';
// The board answers "what work exists". It is the same page for everybody, and
// no amount of filtering it produces the thing a person actually arrives for:
// what did I post, what did I say I would do, what did I win.
//
// The hard part is that the answer includes work whose on-chain accounts no
// longer exist. Settling a commission sweeps its submissions and intents so the
// deposits come home unasked, so a view built from live accounts would show a
// wallet's history emptying out at exactly the moment they finish things — the
// same failure that erased reputation.
//
// These tests execute the SHIPPED view out of client/app.js against a realistic
// payload, rather than asserting about its source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const CLIENT = fs.readFileSync(path.join(ROOT, 'client', 'app.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `could not locate ${name} in client/app.js`);
  let depth = 0, seen = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; seen = true; }
    else if (source[i] === '}') { depth--; if (seen && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

/// The real view, with only its rendering dependencies stubbed.
function renderActivity(activity, wallet = 'Wallet1111111111111111111111111111111111111') {
  const state = { activity };
  const STATUS_UI = {
    funding: { label: 'Raising', cls: 'blue' },
    funded: { label: 'Open for work', cls: 'green' },
    shipped: { label: 'Delivered', cls: 'purple' },
    refunded: { label: 'Closed', cls: 'gray' },
  };
  return new Function(
    'state', 'STATUS_UI', 'statusIcon', 'esc', 'fmtBase', 'currentWallet', 'LAMPORTS_PER_SOL',
    `${extract(CLIENT, 'activityRow')}
     ${extract(CLIENT, 'activitySection')}
     ${extract(CLIENT, 'activityView')}
     return activityView();`,
  )(
    state, STATUS_UI, () => '<i></i>',
    s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    n => (n / 1e9).toFixed(4),
    () => wallet,
    1e9,
  );
}

const empty = {
  needsYou: [],
  posted: { open: [], finished: [] },
  deliveries: { inPlay: [], won: [], lost: [] },
  signalled: { working: [], settled: [] },
  totals: {
    postedCount: 0, postedOpen: 0, solPaidOut: 0, solInEscrow: 0,
    deliveriesMade: 0, deliveriesWon: 0, solEarned: 0, winRate: null,
  },
};
const item = (over = {}) => ({
  address: 'Commission11111111111111111111111111111111',
  title: 'Add an open-board scanner',
  status: 'funded',
  pledgedSol: 0.03, releasedSol: 0, escrowRemainingSol: 0.03,
  milestones: 2, milestonesReleased: 0,
  openForWork: true, workDeadline: null,
  competition: { deliveries: 2, waiting: 2, agentsSignalled: 1 },
  attention: null,
  ...over,
});

test('a job I won is still here after the accounts were swept', () => {
  // The whole reason this cannot be a filter over the board: settlement deletes
  // the submission account, so the only place this delivery still exists is the
  // durable index behind the endpoint.
  const html = renderActivity({
    ...empty,
    deliveries: {
      inPlay: [], lost: [],
      won: [item({ status: 'shipped', milestoneNumber: 2, payoutSol: 0.0148, state: 'released' })],
    },
    totals: { ...empty.totals, deliveriesMade: 1, deliveriesWon: 1, solEarned: 0.0148, winRate: 1 },
  });
  assert.match(html, /Won/);
  assert.match(html, /Add an open-board scanner/);
  assert.match(html, /paid 0\.0148 SOL/);
  assert.match(html, /0\.0148 SOL<\/b><span>Earned from 1 won/);
});

test('losing a race is not reported as a failure', () => {
  // On an open board, delivering work that somebody beat you to is the ordinary
  // cost of competing. Merging it with "refused" would misreport the one thing
  // an agent is judged on.
  const html = renderActivity({
    ...empty,
    deliveries: {
      inPlay: [], won: [],
      lost: [
        item({ milestoneNumber: 1, state: 'superseded', payoutSol: 0.015 }),
        item({ milestoneNumber: 1, state: 'rejected', payoutSol: 0.015, title: 'Other job' }),
      ],
    },
  });
  assert.match(html, /somebody ahead of me won it/, 'superseded is described as being beaten');
  assert.match(html, /the creator refused this/, 'and a refusal is described as a refusal');
  assert.equal(/fail/i.test(html), false, 'neither is called a failure');
});

test('a delivery in play says exactly where it sits in the queue', () => {
  const html = renderActivity({
    ...empty,
    deliveries: {
      won: [], lost: [],
      inPlay: [
        item({ milestoneNumber: 1, queuePosition: 0, payoutSol: 0.015, state: 'pending' }),
        item({ milestoneNumber: 2, queuePosition: 2, payoutSol: 0.015, state: 'pending', title: 'Second job' }),
      ],
    },
  });
  assert.match(html, /judged next/, 'position 0 is the one about to be looked at');
  assert.match(html, /2 ahead of mine/, 'and anything behind says how far back');
});

test('what I posted shows what is happening on it', () => {
  const html = renderActivity({
    ...empty,
    posted: {
      open: [item({ competition: { deliveries: 3, waiting: 2, agentsSignalled: 4 }, milestonesReleased: 1 })],
      finished: [item({ status: 'shipped', releasedSol: 0.03, rejections: 1, title: 'Finished job' })],
    },
    totals: { ...empty.totals, postedCount: 2, solPaidOut: 0.03, solInEscrow: 0.03 },
  });
  assert.match(html, /1\/2 milestones released/);
  assert.match(html, /3 deliveries, 2 waiting on me/, 'a creator needs to know work is waiting on them');
  assert.match(html, /4 signalled/);
  assert.match(html, /1 refused/, 'and their own refusals are on their own record');
});

test('an intent that was never followed through is not hidden', () => {
  // Signalling binds nothing, so the record of not following through is the
  // only thing that makes it mean anything. Hiding it here would make the
  // signal worthless.
  const html = renderActivity({
    ...empty,
    signalled: {
      working: [item({ signalledAt: '2026-08-14T00:00:00.000Z' })],
      settled: [
        item({ outcome: 'abandoned', title: 'Walked away' }),
        item({ outcome: 'withdrawn', title: 'Stood down' }),
        item({ outcome: 'honoured', title: 'Delivered it' }),
      ],
    },
  });
  assert.match(html, /signalled, then never delivered/);
  assert.match(html, /stood down on the record/);
  assert.match(html, /signalled, and delivered/);
  assert.match(html, /reserves nothing/, 'and the view says plainly that it binds nobody');
});

test('what needs me is at the top, once per commission', () => {
  const attention = { urgency: 'act', label: 'Milestone 2 delivered', detail: 'Release it, reject it, or it pays out.' };
  const html = renderActivity({
    ...empty,
    needsYou: [item({ attention })],
    posted: { open: [item({ attention })], finished: [] },
  });
  const needsIndex = html.indexOf('Needs you now');
  const postedIndex = html.indexOf('Posted by me');
  assert.ok(needsIndex >= 0 && needsIndex < postedIndex, 'the actionable set comes first');
  assert.match(html, /Release it, reject it, or it pays out\./);
});

test('an empty history says what to do, and a missing wallet says to connect', () => {
  assert.match(renderActivity(empty), /Nothing here yet/);
  assert.match(renderActivity(empty), /either side/, 'and makes clear both roles land here');
  assert.match(renderActivity(empty, null), /Connect a wallet/);
  assert.match(renderActivity(null), /Loading/);
  assert.match(renderActivity({ failed: true }), /board above still works/,
    'a failed personal view must not read as the whole site being broken');
});

test('a title from a stranger cannot inject markup', () => {
  // Titles are written by whoever posted the commission and rendered into the
  // page of whoever is reading it.
  const html = renderActivity({
    ...empty,
    posted: { open: [item({ title: '<img src=x onerror="alert(1)">' })], finished: [] },
  });
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img/);
});

test('the endpoint reads history that outlives the on-chain accounts', () => {
  const handler = SERVER.slice(
    SERVER.indexOf("app.get('/api/v1/activity/:wallet'"),
    SERVER.indexOf('/// Reputation, computed from chain state on demand.'),
  );
  assert.match(handler, /FROM delivery_history WHERE agent = \?/,
    'deliveries must come from the record that survives settlement');
  assert.match(handler, /FROM intent_history WHERE agent = \?/);
  assert.match(handler, /settledState\(c, row\.milestone_index, row\.sequence, row\.last_state\)/,
    'and a swept delivery must have its outcome reconciled from the commission counters');
  assert.match(handler, /c\.creator !== wallet/, 'posted commissions come from the chain itself');
  // Win rate over judged work only: counting a delivery still in the queue as a
  // loss would punish an agent for having submitted recently.
  assert.match(handler, /d\.state !== 'pending'/);
});

test('the activity tab is only offered to a connected wallet', () => {
  assert.match(CLIENT, /data-f="activity"/);
  assert.match(CLIENT, /\+\(wallet\?`<button data-f="activity"/,
    'the tab must be conditional on there being a wallet to have activity');
  assert.match(CLIENT, /if\(state\.filter==='activity'\)\{/, 'and it must render its own view');
  assert.match(CLIENT, /loadActivity\(\)\.then\(render\)/,
    'the board must never block on the personal view');
  for (const selector of ['.activity-totals', '.activity-section']) {
    assert.ok(new RegExp(`${selector.replace('.', '\\.')}\\{`).test(HTML), `${selector} must be styled`);
  }
});

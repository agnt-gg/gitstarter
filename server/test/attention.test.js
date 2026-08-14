'use strict';
// Everything a party needs to know was already on chain, and none of it was
// visible without opening the right dialog. A creator could be handed finished
// work, have a review clock running against them, and never find out — silence
// pays the agent automatically, so not noticing is expensive.
//
// `pendingAttention` turns that state into something a list can render and a
// notification can announce. These tests pin what it says and, just as
// importantly, when it stays quiet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const escrow = require('../../shared/escrow');

const ROOT = path.join(__dirname, '..', '..');
const CLIENT = fs.readFileSync(path.join(ROOT, 'client', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const CREATOR = 'Cre1111111111111111111111111111111111111111';
const ALICE = 'Agn1111111111111111111111111111111111111111';
const BOB = 'Bgn1111111111111111111111111111111111111111';
const CAROL = 'Cgn1111111111111111111111111111111111111111';
const STRANGER = 'Str1111111111111111111111111111111111111111';
const NOW = 1_800_000_000;

/// A funded commission with nobody working on it — which is now the normal
/// state of a live job, not a stalled one.
function commission(overrides = {}) {
  return {
    creator: CREATOR, invitedAgent: null, isOpen: true, status: 'funded',
    pledged: 10_000_000, released: 0, refunded: 0,
    pledgerCount: 1, refundedPledgerCount: 0,
    milestoneCount: 4, milestoneBps: [2500, 2500, 2500, 2500], milestonesDone: 0,
    deadline: NOW + 86_400, workWindow: 7_200, workDeadline: NOW + 7_200,
    reviewWindow: 172_800,
    milestoneSubmitted: [0, 0, 0, 0], milestoneRejected: [0, 0, 0, 0],
    unresolvedSubmissions: 0, latestSubmittedAt: 0,
    submissions: 0, rejections: 0, autoReleases: 0, intents: 0,
    ...overrides,
  };
}

function delivery(agent, milestoneIndex, sequence, submittedAt, state = 'pending') {
  return { agent, milestoneIndex, sequence, submittedAt, state, evidenceHash: 'ab'.repeat(32) };
}

/// A commission with `count` agents queued on milestone `index`.
function contested(index, agents, submittedAt = NOW - 60, overrides = {}) {
  const submitted = [0, 0, 0, 0];
  submitted[index] = agents.length;
  const c = commission({
    milestoneSubmitted: submitted,
    unresolvedSubmissions: agents.length,
    latestSubmittedAt: submittedAt,
    submissions: agents.length,
    ...overrides,
  });
  const submissions = agents.map((agent, i) => delivery(agent, index, i, submittedAt));
  return { c, submissions };
}

test('a creator is told when work has been delivered to them', () => {
  // The case that prompted this: without it, the only way to discover a
  // delivery was to open the dialog and look.
  const { c, submissions } = contested(1, [ALICE]);
  const attention = escrow.pendingAttention(c, CREATOR, { nowUnix: NOW, submissions });
  assert.ok(attention, 'a pending delivery must raise the creator\'s attention');
  assert.equal(attention.kind, 'review');
  assert.equal(attention.urgency, 'act', 'a running review clock is not a background detail');
  assert.match(attention.label, /Milestone 2/, 'the milestone must be named, and one-indexed for humans');
  assert.equal(attention.deadline, NOW - 60 + 172_800, 'the deadline must be the review clock');
});

test('a creator is told how many agents are waiting on them', () => {
  // Open competition means a queue, and a creator who does not know there are
  // three deliveries waiting will judge the first one as if it were the only
  // option they have.
  const { c, submissions } = contested(0, [ALICE, BOB, CAROL]);
  const attention = escrow.pendingAttention(c, CREATOR, { nowUnix: NOW, submissions });
  assert.match(attention.label, /3 deliveries/);
  assert.match(attention.detail, /oldest first/);
});

test('an agent behind somebody else in the queue is told so', () => {
  // Knowing you are second matters: it is the difference between waiting and
  // spending more compute on a job you have probably already lost.
  const { c, submissions } = contested(0, [ALICE, BOB]);
  assert.equal(
    escrow.pendingAttention(c, ALICE, { nowUnix: NOW, submissions }), null,
    'the agent at the front is waiting on the creator, not on themselves');
  const behind = escrow.pendingAttention(c, BOB, { nowUnix: NOW, submissions });
  assert.equal(behind.kind, 'queued');
  assert.equal(behind.urgency, 'soon');
  assert.match(behind.label, /queue/);
});

test('a matured claim is announced to both sides, in their own terms', () => {
  const { c, submissions } = contested(0, [ALICE], NOW - 200_000);
  const toAgent = escrow.pendingAttention(c, ALICE, { nowUnix: NOW, submissions });
  const toCreator = escrow.pendingAttention(c, CREATOR, { nowUnix: NOW, submissions });

  assert.equal(toAgent.kind, 'claimable');
  assert.match(toAgent.label, /yours to claim/, 'the agent is told they can take it');
  assert.equal(toCreator.kind, 'claimable');
  assert.match(toCreator.label, /has passed/, 'the creator is told they no longer control it');
  assert.equal(toAgent.urgency, 'act');
});

test('an open commission is advertised to agents and to its creator', () => {
  // The board only works if agents can tell that a job is live and unworked.
  const c = commission();
  const toAgent = escrow.pendingAttention(c, ALICE, { nowUnix: NOW });
  assert.equal(toAgent.kind, 'open');
  assert.match(toAgent.detail, /Funded and unclaimed/);

  const toCreator = escrow.pendingAttention(c, CREATOR, { nowUnix: NOW });
  assert.equal(toCreator.kind, 'awaiting-work');
  assert.match(
    toCreator.detail, /do not need to choose/,
    'a creator must not be left waiting for a decision the product no longer asks of them');
});

test('it stays silent for people with nothing to do', () => {
  // A badge on every row is a badge on no row.
  const c = commission({ status: 'funding', workDeadline: 0 });
  assert.equal(escrow.pendingAttention(c, STRANGER, { nowUnix: NOW }), null);
  assert.equal(escrow.pendingAttention(c, null, { nowUnix: NOW }), null, 'no wallet, no obligations');

  // A creator whose commission has deliveries waiting on somebody else’s
  // judgement is not being asked for anything.
  const { c: contested_, submissions } = contested(0, [ALICE]);
  assert.equal(escrow.pendingAttention(contested_, STRANGER, { nowUnix: NOW, submissions }), null);
});

test('account deposits are never raised as something a person must do', () => {
  // Solana holds a refundable deposit on every account, and it does have to come
  // back. It used to come back by asking the user to press a button, which turned
  // a bookkeeping detail into a chore on a screen that should only ever show
  // obligations that involve real decisions. The deposits now ride home on the
  // transaction that settles the commission, so there is nothing to say.
  const shipped = commission({ status: 'shipped', released: 10_000_000, milestonesDone: 0b1111 });
  for (const wallet of [CREATOR, ALICE, BOB, STRANGER]) {
    const attention = escrow.pendingAttention(shipped, wallet, { nowUnix: NOW });
    assert.equal(
      attention, null,
      `a settled commission must be silent, but it told ${wallet.slice(0, 5)} about ${attention?.kind}`,
    );
  }
});

test('an obligation with a clock outranks one without', () => {
  // A commission can satisfy several branches at once. The one with money or a
  // deadline riding on it has to win, or the badge shows the wrong thing.
  const { c, submissions } = contested(2, [ALICE]);
  assert.equal(escrow.pendingAttention(c, CREATOR, { nowUnix: NOW, submissions }).kind, 'review');
});
test('the list surfaces attention without anyone opening a dialog', () => {
  assert.match(CLIENT, /escrow\.pendingAttention/, 'the client must ask what is owed');
  // Assert the badge is CONDITIONAL on there being an obligation. Matching the
  // markup alone passes even when the condition has been stubbed to false, which
  // is exactly the regression that would silently empty every row.
  assert.match(CLIENT, /\$\{attention\?`<span class="lbl attention \$\{attention\.urgency\}"/,
    'the row badge must render if and only if something is actually owed');
  assert.match(CLIENT, /const attention=attentionFor\(p\)/,
    'every row must ask what this wallet owes on it');
  assert.match(CLIENT, /data-f="needs-you"/, 'there must be a way to see only what needs the user');
  assert.match(CLIENT, /needsYou\.length\?/,
    'the needs-you tab must be hidden when empty, or it becomes furniture');
  // Check the selectors carry actual colour, not merely that the string appears:
  // `.lbl.attention.act` is also used by the reduced-motion block, so a bare
  // presence check survives the styling being deleted outright.
  for (const [selector, property] of [
    ['.lbl.attention.act', 'background'],
    ['.lbl.attention.soon', 'background'],
    ['.unav button.needs-you', 'color'],
  ]) {
    assert.ok(
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{[^}]*${property}:`).test(HTML),
      `${selector} must define ${property}, not just exist`,
    );
  }
});

test('a pushed change is announced, and an unchanged one is not', () => {
  const body = CLIENT.slice(CLIENT.indexOf('function applyLiveUpdate('));
  assert.match(body, /announce\(/, 'a live update must be able to announce itself');
  assert.match(body, /key\(after\)!==before/,
    'an announcement must compare before and after, or every push becomes noise');
  assert.match(body, /\$\{attention\.kind\}:\$\{attention\.label\}/,
    'the comparison key must include the label, so a second delivery is not swallowed');
  assert.match(body, /urgency==='act'/,
    'only obligations with a clock or money on them may interrupt');
});

test('notification permission is asked for at an honest moment', () => {
  // Never on page load: at that point the user has no idea what the site is,
  // and a denied permission cannot be asked for twice.
  const offer = CLIENT.slice(CLIENT.indexOf('function offerNotifications('));
  assert.match(offer, /Notification\.permission!=='default'/,
    'an already-decided permission must not be re-requested');
  assert.match(offer, /gitstarter\.notify\.asked/, 'the prompt must only ever be shown once');
  const boot = CLIENT.slice(CLIENT.lastIndexOf('(async()=>{'));
  assert.equal(/offerNotifications\(\)/.test(boot), false,
    'permission must not be requested on page load');
  assert.match(CLIENT.slice(CLIENT.indexOf('async function simpleAction(')), /offerNotifications\(\)/,
    'it must be offered after the user acts and starts waiting on somebody else');
});

test('a background notification is a courtesy, never a dependency', () => {
  const announce = CLIENT.slice(CLIENT.indexOf('function announce('), CLIENT.indexOf('function offerNotifications('));
  assert.match(announce, /showToast\(/, 'the in-page toast must fire regardless');
  assert.match(announce, /document\.hidden/,
    'a browser notification is for a backgrounded tab; a visible tab already has the toast');
  assert.match(announce, /try\{/, 'a blocked or unsupported Notification API must not break the update');
});

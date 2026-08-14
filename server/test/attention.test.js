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
const AGENT = 'Agn1111111111111111111111111111111111111111';
const STRANGER = 'Str1111111111111111111111111111111111111111';
const NOW = 1_800_000_000;

/// A funded commission with nobody working on it yet.
function commission(overrides = {}) {
  return {
    creator: CREATOR, agent: null, pendingAgent: null, status: 'funded',
    pledged: 10_000_000, released: 0, refunded: 0,
    pledgerCount: 1, refundedPledgerCount: 0,
    milestoneCount: 4, milestonesDone: 0,
    deadline: NOW + 86_400, deliveryDeadline: 0, reviewWindow: 172_800,
    submission: null, nominatedAt: null, nominationLapsesAt: null,
    ...overrides,
  };
}
function withDelivery(milestoneIndex, submittedAt, overrides = {}) {
  const c = commission({
    status: 'building', agent: AGENT, deliveryDeadline: NOW + 3_600, ...overrides,
  });
  c.submission = {
    milestoneIndex, submittedAt, evidenceHash: 'ab'.repeat(32),
    reviewEndsAt: submittedAt + c.reviewWindow,
  };
  return c;
}

test('a creator is told when work has been delivered to them', () => {
  // The case that prompted this: without it, the only way to discover a
  // delivery was to open the dialog and look.
  const attention = escrow.pendingAttention(withDelivery(1, NOW - 60), CREATOR, NOW);
  assert.ok(attention, 'a pending delivery must raise the creator\'s attention');
  assert.equal(attention.kind, 'review');
  assert.equal(attention.urgency, 'act', 'a running review clock is not a background detail');
  assert.match(attention.label, /Milestone 2/, 'the milestone must be named, and one-indexed for humans');
  assert.equal(attention.deadline, NOW - 60 + 172_800, 'the deadline must be the review clock');
});

test('the agent who delivered is not nagged about their own submission', () => {
  // Nothing is owed by them: the clock is running against the creator.
  assert.equal(escrow.pendingAttention(withDelivery(1, NOW - 60), AGENT, NOW), null);
});

test('a matured claim is announced to both sides, in their own terms', () => {
  const matured = withDelivery(0, NOW - 200_000);
  const toAgent = escrow.pendingAttention(matured, AGENT, NOW);
  const toCreator = escrow.pendingAttention(matured, CREATOR, NOW);

  assert.equal(toAgent.kind, 'claimable');
  assert.match(toAgent.label, /yours to claim/, 'the agent is told they can take it');
  assert.equal(toCreator.kind, 'claimable');
  assert.match(toCreator.label, /has passed/, 'the creator is told they no longer control it');
  assert.equal(toAgent.urgency, 'act');
});

test('a nominee is told a contract is waiting, with its lapse time', () => {
  const offered = commission({ pendingAgent: AGENT, nominatedAt: NOW, nominationLapsesAt: NOW + 259_200 });
  const attention = escrow.pendingAttention(offered, AGENT, NOW);
  assert.equal(attention.kind, 'accept');
  assert.equal(attention.deadline, NOW + 259_200, 'the offer expires and the deadline must say when');
  assert.equal(escrow.pendingAttention(offered, CREATOR, NOW), null,
    'the creator is not the one holding this up');
});

test('an idle funded commission nudges its creator, and an idle agent their clock', () => {
  const funded = escrow.pendingAttention(commission(), CREATOR, NOW);
  assert.equal(funded.kind, 'nominate');
  assert.equal(funded.urgency, 'soon', 'money is escrowed but no clock is against the creator yet');

  const building = commission({ status: 'building', agent: AGENT, deliveryDeadline: NOW + 7_200 });
  const due = escrow.pendingAttention(building, AGENT, NOW);
  assert.equal(due.kind, 'deliver');
  assert.equal(due.deadline, NOW + 7_200);
});

test('it stays silent for people with nothing to do', () => {
  // A badge on every row is a badge on no row.
  assert.equal(escrow.pendingAttention(commission(), STRANGER, NOW), null);
  assert.equal(escrow.pendingAttention(commission(), null, NOW), null, 'no wallet, no obligations');
  assert.equal(
    escrow.pendingAttention(commission({ status: 'building', agent: AGENT, deliveryDeadline: NOW + 7_200 }), CREATOR, NOW),
    null,
    'a creator waiting on an agent is not being asked for anything',
  );
});

test('rent is offered as housekeeping, never as something urgent', () => {
  const shipped = commission({ status: 'shipped', released: 10_000_000, milestonesDone: 0b1111 });
  const attention = escrow.pendingAttention(shipped, CREATOR, NOW);
  assert.equal(attention.kind, 'rent');
  assert.equal(attention.urgency, 'idle', 'reclaiming rent must never compete with a running clock');
});

test('an obligation with a clock outranks one without', () => {
  // A commission can satisfy several branches at once. The one with money or a
  // deadline riding on it has to win, or the badge shows the wrong thing.
  const both = withDelivery(2, NOW - 60, { status: 'building' });
  assert.equal(escrow.pendingAttention(both, CREATOR, NOW).kind, 'review');
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

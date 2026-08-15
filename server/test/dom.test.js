'use strict';
// The create form silently failed for every user on every device because the
// handler read two input ids that the dialog never rendered. `$('nDelivery')`
// returned null, `.value` threw on the first line, and the click appeared to do
// nothing at all.
//
// That class of bug — code reading a DOM node that does not exist — is
// mechanically checkable, so it should never reach a user again. These tests
// read the client source and the page markup and cross-check them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const CLIENT = fs.readFileSync(path.join(ROOT, 'client', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/// Every id the client looks up via the `$` helper.
function idsRead(source) {
  return new Set([...source.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)].map(m => m[1]));
}

/// The source of one function, from its declaration to the start of the next
/// top-level function. Slicing on the first `\n}` looked fine and silently
/// overran by thousands of characters into the following functions, which made
/// this very test report a false failure. Boundaries have to be real.
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `could not locate ${name}`);
  const next = source.slice(start + 1).search(/\n(?:async )?function [A-Za-z]/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

/// Every id that exists somewhere the browser can find it: the static page, or
/// a template literal the client injects with innerHTML.
function idsRendered(...sources) {
  const ids = new Set();
  for (const source of sources) {
    for (const [, id] of source.matchAll(/id="([A-Za-z][\w-]*)"/g)) ids.add(id);
    for (const [, id] of source.matchAll(/id=\\"([A-Za-z][\w-]*)\\"/g)) ids.add(id);
  }
  return ids;
}

test('every DOM id the client reads is actually rendered somewhere', () => {
  const read = idsRead(CLIENT);
  const rendered = idsRendered(HTML, CLIENT);
  assert.ok(read.size > 20, `expected the client to read many ids, found ${read.size}`);

  const missing = [...read].filter(id => !rendered.has(id));
  assert.deepEqual(
    missing, [],
    `the client reads ${missing.join(', ')} but nothing ever renders them; `
    + 'a null lookup throws on first use and the click appears to do nothing',
  );
});

test('the create form renders every field its handler reads', () => {
  // Pin the create path specifically: it is the one that broke, and it is the
  // only place a user can put money into the system.
  const handler = functionBody(CLIENT, 'createCommission');
  const dialog = functionBody(CLIENT, 'openCreate');

  const readByHandler = idsRead(handler);
  assert.ok(readByHandler.size >= 6, `expected the create handler to read its form, found ${readByHandler.size}`);

  const renderedByDialog = idsRendered(dialog);
  for (const id of readByHandler) {
    assert.ok(
      renderedByDialog.has(id),
      `createCommission reads ${id}, which openCreate never renders`,
    );
  }
});

test('the create form still collects the clocks the program requires', () => {
  // These two were the ones that went missing. Naming them explicitly means a
  // future refactor that drops them fails here rather than in a user's hands.
  for (const id of ['nTitle', 'nDescription', 'nGoal', 'nDeadline', 'nMilestones', 'nDelivery', 'nReview']) {
    assert.ok(CLIENT.includes(`id="${id}"`), `the create dialog must render ${id}`);
    assert.ok(CLIENT.includes(`$('${id}')`), `the create handler must read ${id}`);
  }
});

test('sign-in is one tap for every supported wallet', () => {
  // MetaMask used to be bounced to a manual second step, which is most of what
  // made the app feel broken on mobile. No wallet may be special-cased out of
  // the automatic path again.
  const connect = functionBody(CLIENT, 'connectWallet');
  assert.equal(
    /if\(wallet\.id===['"]metamask['"]\)\s*\{?\s*showNotice/.test(connect), false,
    'connectWallet must not divert any wallet to a manual sign-in step',
  );
  assert.ok(connect.includes('await authenticate()'), 'connectWallet must sign in automatically');
});

test('a signed-in user with no live provider is reattached, not sent to a modal', () => {
  // The session lives in a cookie and survives reloads; the provider object does
  // not. On mobile that combination is the normal case, so it must be handled
  // silently rather than demanded of the user.
  assert.ok(/async function reattachProvider\(\)/.test(CLIENT), 'reattachProvider must exist');
  assert.ok(
    functionBody(CLIENT, 'requireSession').includes('await reattachProvider()'),
    'requireSession must attempt a silent reattach before opening the wallet modal',
  );
});

test('the session is restored before the chain is scanned', () => {
  // Scanning first left a returning user looking anonymous for seconds, which is
  // long enough to tap a button and be told to connect a wallet they are already
  // signed in with.
  const boot = CLIENT.slice(CLIENT.lastIndexOf('(async()=>{'));
  const restore = boot.indexOf('restoreSession()');
  const refresh = boot.indexOf('refresh()');
  assert.ok(restore !== -1 && refresh !== -1, 'boot sequence not found');
  assert.ok(restore < refresh, 'restoreSession must run before refresh on boot');
});

test('a confirmed transaction pins every later read to its slot', () => {
  // The public RPC endpoint is a pool. `confirmTransaction` can be satisfied by
  // one node while the next read is served by another that has not caught up,
  // which is why a confirmed pledge could still show as unfunded until a manual
  // reload. Recording the confirming slot and demanding it back makes a stale
  // node say so instead of quietly answering with old state.
  const send = functionBody(CLIENT, 'send');
  // Mechanism changed from WSS subscription to HTTP polling because
  // publicnode.com's WSS accepts signatureSubscribe but never replies. The
  // slot now comes from getSignatureStatuses' response, not from the WSS
  // subscription callback. The pinning INVARIANT is unchanged.
  // Polling call goes through callWithFailover so a 504 rotates the pool
  // to the next endpoint. The INVARIANT is that confirmation is polled
  // (not WSS-subscribed); the mechanism is a routed call now.
  assert.match(send, /getSignatureStatuses/,
    'confirmation must poll rather than subscribe to a WSS endpoint that hangs');
  assert.doesNotMatch(send, /confirmTransaction\(sig/,
    'the WSS confirmation path was the bug; nothing must call it any more');
  assert.match(send, /status\.slot/,
    'send must record the slot the polled status carries back');
  assert.match(send, /state\.minContextSlot\s*=\s*Math\.max/,
    'the recorded slot must only ever move forward');

  // getProgramAccounts accepts minContextSlot and silently IGNORES it — verified
  // against devnet by asking for a slot 100,000 ahead of the tip and being
  // answered anyway. getAccountInfo does honour it, so the account we just
  // changed must be reconciled with a targeted read rather than trusted from
  // the bulk scan.
  const reconcile = functionBody(CLIENT, 'reconcile');
  assert.match(reconcile, /getAccountInfo/,
    'reconcile must use the read that honours minContextSlot');
  assert.match(reconcile, /minContextSlot:state\.minContextSlot/,
    'reconcile must pin to the slot our transaction confirmed in');
  // Match the config KEY being passed, not the word appearing — the function's
  // own comment explains why the scan cannot be pinned, and a bare /minContextSlot/
  // matches that prose and asserts nothing.
  assert.equal(/minContextSlot\s*:/.test(functionBody(CLIENT, 'readCommissionAccounts')), false,
    'the bulk scan must not pretend to be pinned; getProgramAccounts ignores it');

  for (const action of ['pledge', 'createCommission', 'simpleAction']) {
    assert.match(functionBody(CLIENT, action), /await reconcile\(/,
      `${action} must reconcile the account it changed against the confirming slot`);
  }
});

test('commission updates arrive by push, with no polling loop', () => {
  // One websocket subscription costs nothing per update and covers other
  // people\u2019s activity too, so a backer\u2019s pledge or an agent\u2019s delivery appears
  // without anyone reloading.
  assert.match(CLIENT, /onProgramAccountChange/,
    'the client must subscribe to commission account changes');
  const subscribe = functionBody(CLIENT, 'subscribeToCommissions');
  assert.match(subscribe, /state\.subscription\s*!=\s*null/,
    'the subscription must not be opened twice');
  assert.equal(/setInterval/.test(CLIENT), false,
    'live updates must be pushed, never polled on a timer');

  const apply = functionBody(CLIENT, 'applyLiveUpdate');
  assert.match(apply, /decodeCommission/,
    'a pushed account must be decoded rather than triggering a full rescan');
  assert.match(apply, /INPUT\|TEXTAREA\|SELECT/,
    'an open dialog must not be redrawn while the user is typing into it');
});

test('every signing path reports what it is waiting for', () => {
  // A click that opens a wallet app and then sits silent is indistinguishable
  // from a button that did nothing.
  const send = functionBody(CLIENT, 'send');
  assert.match(send, /onStage\('Approve in your wallet/, 'send must say it is waiting on the wallet');
  assert.match(send, /onStage\('Confirming on Solana/, 'send must say it is waiting on the network');

  for (const action of ['pledge', 'createCommission', 'simpleAction']) {
    assert.match(functionBody(CLIENT, action), /send\([^)]*,\s*showProgress\)|showProgress\)/,
      `${action} must pass the progress reporter to send`);
    assert.match(functionBody(CLIENT, action), /hideProgress\(\)/,
      `${action} must clear the progress indicator when it finishes`);
  }

  // And a failure must never leave the spinner running forever.
  assert.match(functionBody(CLIENT, 'showError'), /hideProgress\(\)/,
    'an error must clear the in-progress indicator');
});

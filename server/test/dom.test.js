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

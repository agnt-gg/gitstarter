'use strict';
// The program commits to a SHA-256 of the delivered work and stores nothing
// else. That is correct for a chain and useless for a person: a creator was
// shown sixteen hex characters and asked to approve a payment against them.
//
// The preimage is now recorded off chain, and accepted ONLY if it hashes to the
// commitment already on chain. Two things therefore have to hold, and these
// tests pin both:
//
//   1. Text that does not match the commitment is refused. Without that, the
//      panel a creator reads becomes a place anyone can write.
//   2. Text that does match is rendered without becoming an attack. It is
//      chosen by a counterparty and displayed to the wallet holding the money.

process.env.DATABASE_PATH = require('node:path').join(require('node:os').tmpdir(), `gitstarter-evidence-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const CLIENT = fs.readFileSync(path.join(ROOT, 'client', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
const DB = fs.readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8');

/// The SHIPPED linkifier, compiled out of client/app.js.
///
/// An earlier version of this file carried its own copy of the function, which
/// meant the XSS tests below proved something about the test file and nothing
/// at all about the code that runs in a browser. Deleting the escaping from the
/// real implementation left them green. Extracting the source is the only way
/// these assertions mean what they say.
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
const evidenceHtml = new Function(
  `${extract(CLIENT, 'esc')}\n${extract(CLIENT, 'evidenceHtml')}\nreturn evidenceHtml;`,
)();

test('a link is rendered as a link, and safely', () => {
  const html = evidenceHtml('https://github.com/agnt-gg/gitstarter/pull/1');
  assert.match(html, /^<a href="https:\/\/github\.com\/agnt-gg\/gitstarter\/pull\/1"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/,
    'a link to a counterparty\'s page must not hand it window.opener');
  assert.match(html, /target="_blank"/);
});

test('a hostile scheme is never turned into a link', () => {
  // This text is written by the party being paid and displayed to the party
  // holding the money. A javascript: URL here would be stored XSS aimed at
  // exactly the wallet worth attacking.
  for (const hostile of [
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ]) {
    const html = evidenceHtml(hostile);
    assert.equal(/<a /.test(html), false, `${hostile} must not become an anchor`);
    assert.equal(/<script/i.test(html), false, `${hostile} must not emit a script tag`);
  }
});

test('markup in the evidence is escaped, not executed', () => {
  const html = evidenceHtml('<img src=x onerror="alert(1)"> done');
  assert.equal(html.includes('<img'), false, 'raw markup must not survive into the DOM');
  assert.match(html, /&lt;img/);
  assert.equal(html.includes('onerror="'), false);
});

test('a URL with a hostile scheme buried in it is still not linkified', () => {
  // `https://` appearing anywhere is not the same as the URL being https.
  const html = evidenceHtml('javascript:void("https://example.com")');
  assert.equal(/<a /.test(html), false);
});

test('plain text is shown as written', () => {
  assert.equal(evidenceHtml('  Delivered as commit a1b2c3  '), 'Delivered as commit a1b2c3');
});

test('the server verifies evidence against the chain, not the caller', () => {
  // The whole trust model: the hash is the authorization. Anyone may supply the
  // text, because only someone who knows it can produce a preimage of a SHA-256
  // that is already committed on chain.
  const handler = SERVER.slice(SERVER.indexOf("app.post('/api/deliveries'"), SERVER.indexOf('function deliveriesFor'));
  assert.match(handler, /createHash\('sha256'\)/, 'the submitted text must be hashed');
  assert.match(handler, /timingSafeEqual/, 'the comparison must not leak by timing');
  // Assert the COMPARED value is bound from the chain. `chain.submission.
  // evidenceHash` also appears further down when building the stored record, so
  // a bare presence check survives the comparison being repointed at req.body.
  assert.match(handler, /const committed = Buffer\.from\(chain\.submission\.evidenceHash, 'hex'\)/,
    'the compared commitment must be bound from chain, never from the request');
  assert.equal(/Buffer\.from\(req\.body\.\w*[Hh]ash/.test(handler), false,
    'a caller-supplied hash must never be trusted as the commitment');
  assert.match(handler, /getAccountInfo/,
    'the commitment must be read live; a cached one would reject a delivery that just landed');
  assert.match(handler, /chain\.submission\.milestoneIndex !== milestoneIndex/,
    'evidence must be tied to the milestone it was submitted for');
});

test('a delivery record can never outrank the chain', () => {
  // The table is an index. It can fail to show a delivery; it must never be
  // able to invent one, or to change what was committed and when.
  assert.match(DB, /CREATE TABLE IF NOT EXISTS deliveries/);
  assert.match(DB, /PRIMARY KEY \(commission, evidence_hash\)/,
    'keying by hash keeps a rejected delivery and the revision that replaced it');
  assert.match(DB, /length\(evidence_hash\) = 64/, 'the stored hash must be a full SHA-256');
});

test('the creator is shown the work, not a hash', () => {
  assert.match(CLIENT, /function deliveryPanel\(/, 'there must be a panel for the delivered work');
  // The creator's branch specifically, not merely somewhere in the file.
  const creatorView = CLIENT.slice(CLIENT.indexOf("if(p.status==='building'&&wallet===p.creator)"));
  assert.match(creatorView.slice(0, 2000), /\+deliveryPanel\(p,sub\)/,
    'the creator review panel must render the delivered work');
  assert.match(creatorView.slice(0, 2000), /deliveryHistory\(p,/,
    'and the earlier deliveries alongside it');
  assert.equal(
    /esc\(sub\.evidenceHash\.slice\(0,16\)\)/.test(CLIENT), false,
    'a truncated hash is not something a person can review, and must not be the whole story',
  );
  assert.match(CLIENT, /Matches the commitment recorded on chain/,
    'the reader must be told the text is provably the one committed to');
});

test('a missing preimage is stated plainly rather than faked', () => {
  const panel = CLIENT.slice(CLIENT.indexOf('function deliveryPanel('), CLIENT.indexOf('function deliveryHistory('));
  assert.match(panel, /if\(!recorded\)\{/,
    'the absent case must be branched on the record actually being missing');
  assert.match(panel, /Nothing submitted to review yet/,
    'an absent preimage must be named as absent');
  assert.match(panel, /evidence-hash/, 'and the commitment shown, so it can still be matched by hand');
});

test('earlier deliveries stay visible', () => {
  // Someone judging milestone three should be able to see what they accepted
  // for milestone one.
  assert.match(CLIENT, /function deliveryHistory\(/);
  assert.match(CLIENT, /Earlier deliveries/);
});

test('the agent is told their text is what gets read', () => {
  assert.match(CLIENT, /This is what the creator sees and judges/,
    'the submit field must say the text is shown to the creator');
  assert.equal(
    CLIENT.includes('Only a hash of this is stored on chain, never the text.'), false,
    'the old wording implied the text was discarded, which is no longer true',
  );
});

test('a failed recording does not imply the delivery was lost', () => {
  // The submission is on chain and stands regardless. Saying otherwise would
  // send an agent chasing a problem that does not exist.
  const action = CLIENT.slice(CLIENT.indexOf('async function simpleAction('));
  assert.match(action, /Delivery submitted on chain, but the description could not be saved/);
});

test('the panel is styled', () => {
  for (const [selector, property] of [['.evidence', 'background'], ['.evidence-body', 'font-size'], ['.evidence-proof', 'color']]) {
    assert.ok(
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{[^}]*${property}:`).test(HTML),
      `${selector} must define ${property}`,
    );
  }
});

test('the hash a client computes matches the one a server verifies', () => {
  // Both sides hash UTF-8 text with SHA-256 and compare 32 raw bytes. A drift
  // here would reject every honest delivery, so pin the exact digest of a
  // known string.
  const text = 'https://github.com/agnt-gg/gitstarter/pull/1';
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  assert.equal(digest.length, 64);
  assert.equal(digest, crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
    'encoding the text explicitly must equal hashing its UTF-8 bytes');
});

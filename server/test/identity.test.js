'use strict';
// A name is the most dangerous thing on a marketplace, because it is the part
// people actually read. Everything else here is arithmetic over chain state; a
// handle is the one field a stranger types in themselves, and it is displayed
// at exactly the moment somebody is deciding whether to trust them with money.
//
// So these tests are mostly about what a name must NOT be able to do: look like
// an address, borrow authority, be recycled to inherit somebody else's record,
// or be shown without the address it labels.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'client', 'app.js'), 'utf8');

function extract(source, name, keyword = 'function') {
  const start = source.indexOf(`${keyword} ${name}(`);
  assert.notEqual(start, -1, `could not locate ${name}`);

  // Skip the parameter list before counting braces. A destructured default like
  // `{short=true}={}` opens and closes a brace inside the signature, so counting
  // from the first brace in the declaration returns the signature alone — which
  // fails as a syntax error rather than as a missing function, and reads like a
  // problem with the code under test rather than with this helper.
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

// The real validator, with only its error helper stubbed.
const badRequest = message => Object.assign(new Error(message), { status: 400 });
const { cleanHandle } = new Function('badRequest', 'cleanText', `
  ${SERVER.slice(SERVER.indexOf('const RESERVED_HANDLES'), SERVER.indexOf('function cleanHandle'))}
  ${extract(SERVER, 'cleanHandle')}
  return { cleanHandle };
`)(badRequest, (value, max) => {
  const text = String(value ?? '').trim();
  if (text.length > max) throw badRequest('too long');
  return text;
});

const refuses = (value, why) => assert.throws(() => cleanHandle(value), Error, why);

test('a handle cannot be mistaken for a wallet address', () => {
  // The attack this exists for: a name that renders like an address next to a
  // "pay this" instruction. Addresses are base58 and long, so anything of that
  // shape is refused outright.
  refuses('2B8YDoo4Q3JJZuuGqqqVP86xoahgMsqREr3ScxhGS8C5',
    'a full base58 address must never be claimable as a name');
  refuses('4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY');
  // The case that actually reaches the shape check. A Solana key is 32 bytes,
  // which base58-encodes to 32-44 characters, so a 32-character address fits
  // inside the length limit for a name and only this guard stops it. Testing
  // with a 44-character address alone proves nothing: the length cap catches
  // that one first, and the guard could be deleted without any test noticing.
  refuses('2B8YDoo4Q3JJZuuGqqqVP86xoahgMsqR',
    'a 32-character base58 string is a valid address length and must be refused');
  // Ordinary names of a normal length are still fine.
  assert.equal(cleanHandle('alice').handle, 'alice');
  assert.equal(cleanHandle('rust-agent-7').handle, 'rust-agent-7');
});

test('a handle cannot borrow authority it does not have', () => {
  // Somebody called "official" or "support" is trusted by default by people who
  // have not read carefully, which is most people, most of the time.
  for (const reserved of ['admin', 'Official', 'SUPPORT', 'gitstarter', 'treasury', 'escrow']) {
    refuses(reserved, `${reserved} must be reserved`);
  }
});

test('a handle cannot hide characters that read as other characters', () => {
  // Mixed scripts and punctuation are how "alice" and "аlice" end up looking
  // identical in a list. Only ASCII letters, digits and inner hyphens.
  refuses('\u0430lice', 'a Cyrillic lookalike must be refused');
  refuses('ali ce');
  refuses('alice!');
  refuses('-alice', 'a leading hyphen lets a name sort or read oddly');
  refuses('alice-');
  refuses('ab', 'two characters is not a name');
  refuses('a'.repeat(33));
});

test('uniqueness cannot be dodged with capitals', () => {
  // Stored lower-cased, so "Alice" and "alice" are the same claim.
  assert.equal(cleanHandle('Alice').key, 'alice');
  assert.equal(cleanHandle('ALICE').key, cleanHandle('alice').key);
  // The chosen casing is preserved for display, because it is theirs.
  assert.equal(cleanHandle('RustAgent').handle, 'RustAgent');
});

test('a name is bound to the first wallet that claims it, permanently', () => {
  // The impersonation route this closes: build a record as "alice", rename, and
  // leave "alice" free for somebody else to pick up and be mistaken for. The
  // claim survives the rename, so the name can never carry a reputation it did
  // not earn.
  const { openDatabase } = require('../db');
  const file = path.join(os.tmpdir(), `gitstarter-handles-${process.pid}.sqlite`);
  fs.rmSync(file, { force: true });
  const db = openDatabase(file);

  const claim = (wallet, key) => {
    const existing = db.prepare('SELECT wallet FROM handle_claims WHERE handle_key = ?').get(key);
    if (existing && existing.wallet !== wallet) return 'refused';
    db.prepare('INSERT INTO handle_claims(handle_key,wallet,claimed_at) VALUES(?,?,?) ON CONFLICT(handle_key) DO NOTHING')
      .run(key, wallet, Date.now());
    return 'claimed';
  };

  assert.equal(claim('WalletA', 'alice'), 'claimed');
  assert.equal(claim('WalletA', 'alice-2'), 'claimed', 'the same wallet may rename itself');
  // WalletA has moved on, but the old name is still theirs and nobody else's.
  assert.equal(claim('WalletB', 'alice'), 'refused',
    'an abandoned name must not be inheritable, or reputation follows the name instead of the key');
  assert.equal(claim('WalletA', 'alice'), 'claimed', 'and its original owner can take it back');

  db.close();
  fs.rmSync(file, { force: true });
});

test('the handle route proves ownership before it writes anything', () => {
  const route = SERVER.slice(SERVER.indexOf("app.post('/api/v1/handle'"));
  assert.match(route.slice(0, 120), /requireAuth/,
    'a name must be settable only by the wallet it names, proven by signature');
  assert.match(route, /handle_claims WHERE handle_key = \?/);
  assert.match(route, /claim\.wallet !== req\.wallet/,
    'and a claim held by another wallet must block the write');
  assert.match(route, /db\.transaction/,
    'the claim and the name must be written together, or a crash leaves a name owned by nobody');
});

test('a profile can be found by name or by address, and says which is which', () => {
  const resolve = SERVER.slice(SERVER.indexOf('function resolveIdentity'));
  assert.match(resolve.slice(0, 400), /handle_key = \?/, 'a handle resolves to its wallet');
  assert.match(resolve.slice(0, 400), /cleanWallet\(id\)/, 'and an address resolves to itself');

  const route = SERVER.slice(SERVER.indexOf("app.get('/api/v1/profile/:handleOrWallet'"));
  assert.match(route, /handleIsSelfDeclared: true/,
    'the response must state that a name is a claim, not something this service verified');
});

test('the browser never shows a name without the address it labels', () => {
  // A name alone would let a familiar-looking string stand in for the only
  // thing that identifies a counterparty — and the address is what gets paid.
  const chip = extract(CLIENT, 'who');
  const render = new Function('esc', `${chip} return who;`)(
    s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  );
  const wallet = '2B8YDoo4Q3JJZuuGqqqVP86xoahgMsqREr3ScxhGS8C5';

  const named = render(wallet, { [wallet]: 'alice' });
  assert.match(named, /@alice/);
  assert.match(named, /2B8Y/, 'the address must appear even when a name is known');
  assert.match(named, /class="addr mono"/);

  const unnamed = render(wallet, {});
  assert.match(unnamed, /2B8Y/);
  assert.equal(unnamed.includes('handle'), false, 'no name is shown when none was claimed');

  // Both halves open the profile, so an address is always explorable.
  assert.equal((named.match(/data-profile=/g) || []).length, 2);
});

test('a name somebody else chose cannot inject markup', () => {
  const chip = extract(CLIENT, 'who');
  const render = new Function('esc', `${chip} return who;`)(
    s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  );
  const html = render('W', { W: '<img src=x onerror=alert(1)>' });
  assert.equal(html.includes('<img'), false);

  // The profile page renders a bio and a link, both written by a stranger.
  const view = extract(CLIENT, 'profileView');
  assert.match(view, /esc\(p\.bio\)/, 'a bio must be escaped');
  assert.match(view, /safeHttpUrl\(p\.link\)/, 'and a link must be scheme-checked, or javascript: runs on click');
  assert.match(view, /rel="noopener noreferrer nofollow"/,
    'an outbound link from an unverified profile must not pass reputation or window access');
});

test('clicking a name opens who they are, not what they are standing in', () => {
  // The chips sit inside rows that themselves open a commission, so the profile
  // target has to be resolved first or it can never be reached.
  const handler = CLIENT.slice(CLIENT.indexOf("document.addEventListener('click'"));
  const profileIndex = handler.indexOf('t.dataset.profile');
  const rowIndex = handler.indexOf('t.dataset.id');
  assert.ok(profileIndex > 0, 'the click handler must understand a profile target');
  assert.ok(rowIndex === -1 || profileIndex < rowIndex,
    'a name must be checked before the row it is nested inside');
  assert.match(handler.slice(0, 400), /closest\('button,\[data-profile\],\[data-id\]'\)/,
    'and the selector must include it, or the chip is never matched at all');
});

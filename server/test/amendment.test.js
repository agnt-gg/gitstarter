'use strict';
process.env.DATABASE_PATH = require('node:path').join(require('node:os').tmpdir(), `gitstarter-amend-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const nacl = require('tweetnacl');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const { app, db, mayAmend, amendmentRecord } = require('../server');

let server, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise(r => server.close(r)); db.close(); });

/// A commission as the chain describes it, with only the fields the rule reads.
const chainState = (over = {}) => ({ status: 'funded', unresolvedSubmissions: 0, ...over });

test('terms cannot move while a delivery is waiting on judgment', () => {
  const verdict = mayAmend(chainState({ unresolvedSubmissions: 1 }));
  assert.equal(verdict.ok, false);
  // The reason is the product here: an agent that is refused has to be able to
  // tell "somebody is mid-judgment" from "this commission is over".
  assert.match(verdict.reason, /waiting on judgment/);
});

test('terms cannot move once the commission has settled', () => {
  for (const status of ['shipped', 'refunded']) {
    const verdict = mayAmend(chainState({ status }));
    assert.equal(verdict.ok, false, status);
    assert.match(verdict.reason, /part of the record/);
  }
});

test('terms may be corrected while the work is still open to anyone', () => {
  for (const status of ['funding', 'funded']) {
    assert.equal(mayAmend(chainState({ status })).ok, true, status);
  }
});

test('an unjudged delivery still blocks an amendment even on an open commission', () => {
  // The two rules are independent: being open is not enough on its own.
  assert.equal(mayAmend(chainState({ status: 'funded', unresolvedSubmissions: 3 })).ok, false);
});

const existingRow = {
  title: 'Original title',
  description: 'Original description',
  repository_url: 'https://github.com/agnt-gg/gitstarter',
  labels_json: '["bug"]',
};

test('a field the caller did not send is left alone', () => {
  const next = amendmentRecord(existingRow, { title: 'Corrected title' });
  assert.equal(next.title, 'Corrected title');
  assert.equal(next.description, 'Original description');
  assert.equal(next.repositoryUrl, 'https://github.com/agnt-gg/gitstarter');
  assert.equal(next.labelsJson, '["bug"]');
});

test('a field the caller did send replaces the old one', () => {
  const next = amendmentRecord(existingRow, { description: 'Rewritten', labels: ['test', 'devnet'] });
  assert.equal(next.description, 'Rewritten');
  assert.deepEqual(JSON.parse(next.labelsJson), ['test', 'devnet']);
  assert.equal(next.title, 'Original title', 'an untouched title must survive a description edit');
});

test('a repository link can be removed on purpose', () => {
  assert.equal(amendmentRecord(existingRow, { repositoryUrl: '' }).repositoryUrl, null);
});

test('labels stay bounded however many the caller sends', () => {
  const next = amendmentRecord(existingRow, { labels: Array.from({ length: 40 }, (_, i) => 'label' + i) });
  assert.equal(JSON.parse(next.labelsJson).length, 12);
});

test('amending requires a signed-in wallet', async () => {
  const response = await fetch(base + '/api/commissions/anything', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 401);
});

test('amending a commission this server never indexed is a 404, and reaches no RPC', async () => {
  const keypair = nacl.sign.keyPair();
  const wallet = bs58.encode(keypair.publicKey);
  const challenge = await fetch(base + '/api/auth/challenge', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet }),
  }).then(r => r.json());
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), keypair.secretKey));
  const verified = await fetch(base + '/api/auth/verify', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet, message: challenge.message, signature }),
  });
  const cookie = verified.headers.get('set-cookie').split(';')[0];
  const response = await fetch(base + '/api/commissions/NotACommissionAddress', {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ title: 'x' }),
  });
  // The unknown-row check has to come before the chain read, or a stranger can
  // make this server issue an RPC call for any address they like.
  assert.equal(response.status, 404);
});

test('the archive table keeps superseded wording rather than replacing it', () => {
  const columns = db.prepare("SELECT name FROM pragma_table_info('commission_amendments')").all().map(c => c.name);
  assert.deepEqual(columns.sort(), ['amended_at', 'commission', 'description', 'labels_json', 'title']);
  // Two amendments of the same commission must both survive.
  const at = Date.now();
  const insert = db.prepare('INSERT OR REPLACE INTO commission_amendments(commission,title,description,labels_json,amended_at) VALUES(?,?,?,?,?)');
  insert.run('CommissionUnderTest', 'first', 'first body', '[]', at);
  insert.run('CommissionUnderTest', 'second', 'second body', '[]', at + 1);
  const kept = db.prepare('SELECT title FROM commission_amendments WHERE commission = ? ORDER BY amended_at').all('CommissionUnderTest');
  assert.deepEqual(kept.map(r => r.title), ['first', 'second']);
});

test('the list exposes when terms were amended, under the name the client reads', async () => {
  // This response is assembled field by field, so a new column does not reach
  // the browser just because it exists. The first version of this feature
  // shipped with the column written and never served, and a client reading the
  // snake_case name the API does not emit — silently, because an absent field
  // renders as no marker at all rather than as an error.
  db.prepare(`INSERT OR REPLACE INTO commissions
    (address,creator,tx_signature,title,description,repository_url,license,labels_json,created_at,amended_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run('ListedCommission', 'CreatorWallet', 'sig-listed', 'Listed', 'body', null, 'MIT', '[]', Date.now(), 1786914032283);
  const listed = (await fetch(base + '/api/commissions').then(r => r.json()))
    .find(row => row.address === 'ListedCommission');
  assert.equal(listed.amendedAt, 1786914032283);
  const untouched = db.prepare('SELECT address FROM commissions WHERE amended_at IS NULL LIMIT 1').get();
  if (untouched) {
    const row = (await fetch(base + '/api/commissions').then(r => r.json()))
      .find(r => r.address === untouched.address);
    assert.equal(row.amendedAt, null, 'a commission nobody amended must not claim it was');
  }
});

test('the client reads the amendment date under the name the API emits', () => {
  const client = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'client', 'app.js'), 'utf8');
  assert.ok(client.includes('m.amendedAt'), 'client must read the camelCase field the API returns');
  assert.ok(!client.includes('m.amended_at'), 'the snake_case name is never emitted by the API');
});

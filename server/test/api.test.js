'use strict';
process.env.DATABASE_PATH = require('node:path').join(require('node:os').tmpdir(), `gitstarter-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const nacl = require('tweetnacl');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const { app, db, cleanHttpUrl } = require('../server');
let server, base;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise(r => server.close(r)); db.close(); });
test('health and public config expose no secrets', async () => {
  const health = await fetch(base + '/api/health').then(r => r.json());
  assert.deepEqual(health, { ok: true, database: 'sqlite', cluster: 'devnet' });
  const config = await fetch(base + '/api/config').then(r => r.json());
  assert.equal(config.feeBasisPoints, 100);
  assert.equal(config.settlementAsset, 'SOL');
  assert.equal(config.lamportsPerSol, 1_000_000_000);
  assert.equal(config.feePolicy, 'successful_releases_only');
  assert.equal('tokenMint' in config, false);
  assert.equal(JSON.stringify(config).includes('keypair'), false);
});
test('repository links accept HTTP and reject unsafe schemes', () => {
  assert.equal(cleanHttpUrl('https://github.com/agnt-gg/gitstarter'), 'https://github.com/agnt-gg/gitstarter');
  assert.throws(() => cleanHttpUrl('javascript:alert(1)'), /HTTP or HTTPS/);
  assert.throws(() => cleanHttpUrl('not a url'), /valid URL/);
});
test('session restoration fails closed without a cookie', async () => {
  const response = await fetch(base + '/api/auth/session');
  assert.equal(response.status, 401);
});
test('wallet sign-in issues a secure cookie that restores the session', async () => {
  const keypair = nacl.sign.keyPair();
  const wallet = bs58.encode(keypair.publicKey);
  const challenge = await fetch(base + '/api/auth/challenge', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({wallet}) }).then(r=>r.json());
  const signature = bs58.encode(nacl.sign.detached(Buffer.from(challenge.message), keypair.secretKey));
  const verify = await fetch(base + '/api/auth/verify', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({wallet,message:challenge.message,signature}) });
  assert.equal(verify.status, 200);
  const cookie = verify.headers.get('set-cookie');
  assert.match(cookie, /gitstarter_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  const restored = await fetch(base + '/api/auth/session', { headers:{cookie:cookie.split(';')[0]} });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).wallet, wallet);
});
test('commission writes require wallet auth', async () => {
  const response = await fetch(base + '/api/commissions', { method: 'POST', headers: { 'content-type':'application/json' }, body: '{}' });
  assert.equal(response.status, 401);
});
test('challenge is unique and expires', async () => {
  const wallet = '11111111111111111111111111111111';
  const one = await fetch(base + '/api/auth/challenge', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({wallet}) }).then(r=>r.json());
  const two = await fetch(base + '/api/auth/challenge', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({wallet}) }).then(r=>r.json());
  assert.notEqual(one.message, two.message);
  assert.ok(two.expiresAt > Date.now());
});

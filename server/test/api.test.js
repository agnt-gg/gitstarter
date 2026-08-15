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
  const config = await fetch(base + '/api/config').then(r => r.json());
  // Which network this is depends on deployment; that it is a real one, and
  // that both endpoints agree about it, does not. Pinning the literal made this
  // test fail on a correct mainnet build — a test about secrets should not have
  // an opinion about the cluster.
  assert.equal(health.ok, true);
  assert.equal(health.database, 'sqlite');
  assert.ok(['mainnet-beta', 'devnet', 'testnet'].includes(health.cluster), health.cluster);
  assert.equal(health.cluster, config.cluster, 'health and config must not disagree about the network');
  assert.deepEqual(Object.keys(health).sort(), ['cluster', 'database', 'ok']);
  assert.equal(config.feeBasisPoints, 100);
  assert.equal(config.settlementAsset, 'SOL');
  assert.equal(config.lamportsPerSol, 1_000_000_000);
  assert.equal(config.feePolicy, 'charged_once_per_lamport_when_work_was_delivered');
  // A fee that now also applies to refunds must be explained where callers look,
  // not discovered when the money is short.
  assert.match(config.feeExplainer, /never saw a delivery costs nothing/);
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
test('a signature collected on another site cannot be turned into a session', async () => {
  // The attack: request a challenge for a wallet you do not control, then get
  // its owner to sign your own text that merely embeds the nonce.
  const keypair = nacl.sign.keyPair();
  const wallet = bs58.encode(keypair.publicKey);
  const challenge = await fetch(base + '/api/auth/challenge', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({wallet}) }).then(r=>r.json());
  const nonce = /Nonce: (\S+)/.exec(challenge.message)[1];

  const phished = `Verify eligibility for your airdrop\nWallet: ${wallet}\nNonce: ${nonce}`;
  const signature = bs58.encode(nacl.sign.detached(Buffer.from(phished), keypair.secretKey));
  const response = await fetch(base + '/api/auth/verify', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({wallet,message:phished,signature}) });
  assert.equal(response.status, 401, 'only the exact issued message may be accepted');
  assert.equal(response.headers.get('set-cookie'), null);
});
test('the public config never discloses a credentialed RPC endpoint', async () => {
  const config = await fetch(base + '/api/config').then(r => r.json());
  assert.equal(/api-key|\?/.test(config.rpcUrl), false, 'a keyed RPC URL must not reach the browser');
});
test('challenge requests are rate limited per wallet', async () => {
  const wallet = bs58.encode(nacl.sign.keyPair().publicKey);
  const codes = [];
  for (let i = 0; i < 8; i++) {
    const r = await fetch(base + '/api/auth/challenge', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({wallet}) });
    codes.push(r.status);
  }
  assert.ok(codes.includes(429), 'nonce overwriting must not be an unlimited anonymous primitive');
});
test('every place the site names itself agrees on one domain', async () => {
  // The site moved from gitstarter.agnt.gg to gitstarter.xyz and three separate
  // places carried the name independently: the message wallets are asked to
  // sign, the base URL published to agents, and a sentence in the agent manual
  // telling agents to REJECT any message not carrying that exact domain.
  //
  // A mismatch is not cosmetic. A user reading gitstarter.xyz while their wallet
  // shows "Domain: gitstarter.agnt.gg" is being asked to do the precise thing
  // every wallet guide says to refuse, and an agent following a stale manual
  // rejects the legitimate challenge. So this reads all three off the RUNNING
  // server and requires them to be the same fact.
  const wallet = bs58.encode(nacl.sign.keyPair().publicKey);
  const challenge = await fetch(base + '/api/auth/challenge', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({wallet}) }).then(r=>r.json());
  const signed = /^Domain: (\S+)$/m.exec(challenge.message);
  assert.ok(signed, 'the challenge must name a domain, or nothing binds the signature to this site');

  const manual = await fetch(base + '/llms.txt').then(r => r.text());
  assert.equal(/\{\{\w+\}\}/.test(manual), false, 'an uninterpolated placeholder would publish a literal template');

  const claimed = /`Domain: (\S+?)`/.exec(manual);
  assert.ok(claimed, 'the manual must tell agents which domain to expect');
  assert.equal(claimed[1], signed[1],
    'the manual tells agents to reject any message not carrying this domain, so it must be the one actually signed');

  const published = /^Base URL: (\S+)$/m.exec(manual);
  assert.ok(published, 'the manual must publish a base URL');
  assert.equal(new URL(published[1]).host, signed[1],
    'agents are told to call one host and sign for another otherwise');
});
test('a malformed wallet cannot create a permanent nonce row', async () => {
  const r = await fetch(base + '/api/auth/challenge', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({wallet:'abc'}) });
  assert.equal(r.status, 400);
});
test('wallet sign-in issues a secure cookie that restores the session', async () => {
  const keypair = nacl.sign.keyPair();
  const wallet = bs58.encode(keypair.publicKey);
  const challenge = await fetch(base + '/api/auth/challenge', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({wallet}) }).then(r=>r.json());
  const signature = bs58.encode(nacl.sign.detached(Buffer.from(challenge.message), keypair.secretKey));
  const verify = await fetch(base + '/api/auth/verify', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({wallet,message:challenge.message,signature}) });
  assert.equal(verify.status, 200);
  const cookie = verify.headers.get('set-cookie');
  assert.match(cookie, /__Host-gitstarter_session=/, 'the __Host- prefix blocks subdomain cookie forcing');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  const jar = cookie.split(';')[0];
  const restored = await fetch(base + '/api/auth/session', { headers:{cookie:jar} });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).wallet, wallet);

  // Logging out must end the session server-side, not merely clear the tab.
  const out = await fetch(base + '/api/auth/logout', { method:'POST', headers:{cookie:jar} });
  assert.equal(out.status, 200);
  const after = await fetch(base + '/api/auth/session', { headers:{cookie:jar} });
  assert.equal(after.status, 401, 'a logged-out session must not be reusable');
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

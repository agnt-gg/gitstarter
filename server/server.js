'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const nacl = require('tweetnacl');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const { openDatabase } = require('./db');

const PORT = Number(process.env.PORT || 3417);
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
// The server's own RPC endpoint may embed a provider API key. Browsers get a
// keyless endpoint instead, so /api/config can never hand out billing credentials.
const PUBLIC_RPC_URL = process.env.PUBLIC_SOLANA_RPC_URL
  || (/api-key|\?/i.test(RPC_URL) ? 'https://api.devnet.solana.com' : RPC_URL);
const CLUSTER = process.env.SOLANA_CLUSTER || 'devnet';
const PROGRAM_ID = process.env.PROGRAM_ID || '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy';
const TREASURY_WALLET = process.env.TREASURY_WALLET || '4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY';
const CONFIG_PDA = process.env.CONFIG_PDA || 'DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29';
const DB_PATH = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'gitstarter.sqlite'));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// __Host- forbids a Domain attribute and requires Secure + Path=/, so a
// compromised sibling subdomain cannot force a cookie onto this origin.
const SESSION_COOKIE = '__Host-gitstarter_session';
const SIGN_IN_DOMAIN = process.env.SIGN_IN_DOMAIN || 'gitstarter.agnt.gg';
const db = openDatabase(DB_PATH);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

// Small in-process limiter. Enough to stop an anonymous caller from overwriting
// a victim's in-flight nonce in a loop, or growing the nonce table without bound.
const rateBuckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
  hits.push(now);
  rateBuckets.set(key, hits);
  if (rateBuckets.size > 5000) for (const [k, v] of rateBuckets) if (!v.some(t => now - t < windowMs)) rateBuckets.delete(k);
  return hits.length <= limit;
}
function cleanWallet(value) {
  const text = cleanText(value, 64);
  // Alphabet validity is not enough: without a length check every distinct
  // base58 string becomes a permanent row in the nonce table.
  if (bs58.decode(text).length !== 32) throw Object.assign(new Error('Invalid wallet'), { status: 400 });
  return text;
}
function purgeExpired() {
  const now = Date.now();
  db.prepare('DELETE FROM auth_nonces WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}
function cleanText(value, max) {
  if (typeof value !== 'string') throw Object.assign(new Error('Expected text'), { status: 400 });
  const text = value.trim();
  if (!text || text.length > max) throw Object.assign(new Error(`Text must be 1-${max} characters`), { status: 400 });
  return text;
}
function cleanHttpUrl(value) {
  const text = cleanText(value, 500);
  let url;
  try { url = new URL(text); } catch { throw Object.assign(new Error('Repository URL must be a valid URL'), { status: 400 }); }
  if (!['https:', 'http:'].includes(url.protocol)) throw Object.assign(new Error('Repository URL must use HTTP or HTTPS'), { status: 400 });
  return url.href;
}
async function rpc(method, params) {
  const response = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`RPC ${body.error.message}`);
  return body.result;
}
function sessionToken(req) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (bearer) return bearer;
  const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : '';
}
function activeSession(req) {
  const token = sessionToken(req);
  return token && db.prepare('SELECT wallet,expires_at FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now());
}
function requireAuth(req, res, next) {
  const row = activeSession(req);
  if (!row) return res.status(401).json({ error: 'Wallet authentication required' });
  req.wallet = row.wallet; next();
}

app.get('/api/health', (_req, res) => res.json({ ok: true, database: 'sqlite', cluster: CLUSTER }));
app.get('/api/auth/session', (req, res) => {
  const row = activeSession(req);
  if (!row) return res.status(401).json({ error: 'No active wallet session' });
  res.json({ wallet: row.wallet, expiresAt: row.expires_at });
});
app.get('/api/config', (_req, res) => res.json({ cluster: CLUSTER, rpcUrl: PUBLIC_RPC_URL, programId: PROGRAM_ID, settlementAsset: 'SOL', treasuryWallet: TREASURY_WALLET, configPda: CONFIG_PDA, lamportsPerSol: 1_000_000_000, feeBasisPoints: 100, feePolicy: 'successful_releases_only' }));
function challengeMessage(wallet, nonce, expiresAt) {
  // Domain-bound so a signature collected on another site cannot be replayed
  // here, and stored verbatim so verification compares the whole message rather
  // than searching it for a substring.
  return [
    'Sign in to GitStarter',
    `Domain: ${SIGN_IN_DOMAIN}`,
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Expires: ${new Date(expiresAt).toISOString()}`
  ].join('\n');
}
app.post('/api/auth/challenge', (req, res) => {
  let wallet;
  try { wallet = cleanWallet(req.body.wallet); } catch { return res.status(400).json({ error: 'Invalid wallet' }); }
  if (!rateLimit(`challenge:${req.ip}`, 20, 60_000) || !rateLimit(`challenge:w:${wallet}`, 5, 60_000)) {
    return res.status(429).json({ error: 'Too many sign-in attempts. Wait a minute and try again.' });
  }
  purgeExpired();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + 5 * 60_000;
  const message = challengeMessage(wallet, nonce, expiresAt);
  db.prepare('INSERT INTO auth_nonces(wallet,nonce,expires_at,used_at) VALUES(?,?,?,NULL) ON CONFLICT(wallet) DO UPDATE SET nonce=excluded.nonce,expires_at=excluded.expires_at,used_at=NULL').run(wallet, nonce, expiresAt);
  res.json({ message, expiresAt });
});
app.post('/api/auth/verify', (req, res) => {
  try {
    const wallet = cleanWallet(req.body.wallet), message = cleanText(req.body.message, 512), signature = cleanText(req.body.signature, 128);
    if (!rateLimit(`verify:${req.ip}`, 30, 60_000)) return res.status(429).json({ error: 'Too many sign-in attempts. Wait a minute and try again.' });
    const row = db.prepare('SELECT nonce,expires_at,used_at FROM auth_nonces WHERE wallet=?').get(wallet);
    // Byte equality against the message this server issued. Substring matching
    // let an attacker request a challenge for someone else's wallet, wrap the
    // nonce in unrelated text on their own site, and turn the victim's signature
    // into a session here.
    if (!row || row.used_at || row.expires_at < Date.now()
      || message !== challengeMessage(wallet, row.nonce, row.expires_at)) {
      return res.status(401).json({ error: 'Expired or invalid challenge' });
    }
    if (!nacl.sign.detached.verify(Buffer.from(message), bs58.decode(signature), bs58.decode(wallet))) return res.status(401).json({ error: 'Bad signature' });
    const token = crypto.randomBytes(32).toString('base64url'), now = Date.now();
    db.transaction(() => {
      db.prepare('UPDATE auth_nonces SET used_at=? WHERE wallet=? AND used_at IS NULL').run(now, wallet);
      db.prepare('INSERT INTO sessions(token_hash,wallet,expires_at,created_at) VALUES(?,?,?,?)').run(hash(token), wallet, now + 30 * 24 * 60 * 60_000, now);
    })();
    const expiresAt = now + 30 * 24 * 60 * 60_000;
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
    res.json({ wallet, expiresAt });
  } catch { res.status(400).json({ error: 'Malformed signature request' }); }
});
app.post('/api/auth/logout', (req, res) => {
  // Switching wallets on a shared browser must actually end the previous
  // session server-side, not merely forget it in the tab.
  const token = sessionToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
});
app.get('/api/commissions', (_req, res) => {
  const rows = db.prepare('SELECT * FROM commissions ORDER BY created_at DESC LIMIT 200').all();
  res.json(rows.map(row => ({ address: row.address, creator: row.creator, txSignature: row.tx_signature, title: row.title, description: row.description, repositoryUrl: row.repository_url, license: row.license, labels: JSON.parse(row.labels_json), createdAt: row.created_at })));
});
app.post('/api/commissions', requireAuth, async (req, res, next) => {
  try {
    const address = cleanText(req.body.address, 64), txSignature = cleanText(req.body.txSignature, 128);
    const [tx, chainAccount] = await Promise.all([
      rpc('getTransaction', [txSignature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]),
      rpc('getAccountInfo', [address, { commitment: 'confirmed', encoding: 'base64' }])
    ]);
    if (!tx || tx.meta?.err) return res.status(409).json({ error: 'Transaction is not confirmed successfully' });
    const keys = tx.transaction.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey);
    if (!keys.includes(PROGRAM_ID) || !keys.includes(req.wallet) || !keys.includes(address)) return res.status(403).json({ error: 'Transaction does not prove this commission and creator' });
    const accountValue = chainAccount?.value;
    if (!accountValue || accountValue.owner !== PROGRAM_ID) return res.status(409).json({ error: 'Commission account is missing or has the wrong owner' });
    const accountData = Buffer.from(accountValue.data[0], 'base64');
    if (accountData.length !== 240 || accountData[0] !== 2) return res.status(409).json({ error: 'Address is not a GitStarter commission' });
    if (bs58.encode(accountData.subarray(1, 33)) !== req.wallet) return res.status(403).json({ error: 'Authenticated wallet is not the on-chain creator' });
    const record = {
      address, creator: req.wallet, txSignature,
      title: cleanText(req.body.title, 160), description: cleanText(req.body.description, 10000),
      repositoryUrl: req.body.repositoryUrl ? cleanHttpUrl(req.body.repositoryUrl) : null,
      license: cleanText(req.body.license || 'MIT', 64),
      labels: Array.isArray(req.body.labels) ? req.body.labels.slice(0, 12).map(v => cleanText(v, 32)) : []
    };
    db.prepare('INSERT INTO commissions(address,creator,tx_signature,title,description,repository_url,license,labels_json,created_at) VALUES(@address,@creator,@txSignature,@title,@description,@repositoryUrl,@license,@labels,@createdAt)').run({ ...record, labels: JSON.stringify(record.labels), createdAt: Date.now() });
    res.status(201).json(record);
  } catch (error) { next(error); }
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: '1h', index: 'index.html' }));
app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.use((error, _req, res, _next) => { console.error(error); res.status(error.status || 500).json({ error: error.status ? error.message : 'Internal server error' }); });

if (require.main === module) app.listen(PORT, '127.0.0.1', () => console.log(`gitstarter listening on 127.0.0.1:${PORT}`));
module.exports = { app, db, cleanHttpUrl };

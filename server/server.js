'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const nacl = require('tweetnacl');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const { Transaction } = require('@solana/web3.js');
const { openDatabase } = require('./db');
const escrow = require('../shared/escrow');
const { llmsTxt } = require('./llms');

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
app.get('/api/config', (_req, res) => res.json({ cluster: CLUSTER, rpcUrl: PUBLIC_RPC_URL, programId: PROGRAM_ID, settlementAsset: 'SOL', treasuryWallet: TREASURY_WALLET, configPda: CONFIG_PDA, lamportsPerSol: 1_000_000_000, feeBasisPoints: 100, feePolicy: 'charged_once_per_lamport_when_work_was_delivered', feeExplainer: 'The protocol charges 1% for connecting the parties and carrying real work between them. It applies to a milestone release, and to a refund only if a delivery was ever submitted. A commission that never saw a delivery costs nothing.' }));
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
    // Sourced from shared/escrow.js so an account-layout change cannot leave a
    // stale literal here silently rejecting every real commission.
    if (accountData.length !== escrow.COMMISSION_ACCOUNT_BYTES || accountData[0] !== 2) {
      return res.status(409).json({ error: 'Address is not a GitStarter commission' });
    }
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
// ── agent API ───────────────────────────────────────────────────────────────
// Everything below is for autonomous, headless callers. Two rules shape it:
//
//   1. It never holds a key and never signs. Transaction endpoints return an
//      UNSIGNED transaction; the caller signs locally and submits it. A server
//      that could sign would be a server that could steal.
//   2. It is a convenience, not an authority. /llms.txt documents the raw
//      instruction encoding so an agent can build the identical transaction
//      without this API at all, and verify what it is handed.

const CHAIN_CACHE_MS = 5_000;
let chainCache = { at: 0, value: null, inflight: null };

/// One getProgramAccounts call serves every concurrent reader for a few seconds.
/// Without this, a handful of polling agents would rate-limit the RPC endpoint
/// for everyone, which is a self-inflicted outage rather than a load problem.
async function chainCommissions() {
  const now = Date.now();
  if (chainCache.value && now - chainCache.at < CHAIN_CACHE_MS) return chainCache.value;
  if (chainCache.inflight) return chainCache.inflight;
  chainCache.inflight = (async () => {
    try {
      const accounts = await rpc('getProgramAccounts', [PROGRAM_ID, {
        commitment: 'confirmed', encoding: 'base64',
        filters: [{ dataSize: escrow.COMMISSION_ACCOUNT_BYTES }, { memcmp: { offset: 0, bytes: '3' } }],
      }]);
      const value = new Map();
      for (const entry of accounts) {
        try {
          value.set(entry.pubkey, escrow.decodeCommission(Buffer.from(entry.account.data[0], 'base64')));
        } catch { /* not a commission we understand; skip rather than fail the request */ }
      }
      chainCache = { at: Date.now(), value, inflight: null };
      return value;
    } catch (error) {
      chainCache.inflight = null;
      throw error;
    }
  })();
  return chainCache.inflight;
}

const explorerUrl = address =>
  `https://solscan.io/account/${address}${CLUSTER === 'mainnet-beta' ? '' : `?cluster=${encodeURIComponent(CLUSTER)}`}`;
const toSol = lamports => lamports / escrow.LAMPORTS_PER_SOL;

function presentCommission(address, chain, meta, wallet) {
  const remaining = escrow.escrowRemaining(chain);
  return {
    address,
    explorer: explorerUrl(address),
    status: chain.status,
    creator: chain.creator,
    agent: chain.agent,
    pendingAgent: chain.pendingAgent,
    treasury: chain.treasury,
    goalLamports: chain.goal,
    goalSol: toSol(chain.goal),
    pledgedLamports: chain.pledged,
    pledgedSol: toSol(chain.pledged),
    releasedLamports: chain.released,
    releasedSol: toSol(chain.released),
    refundedLamports: chain.refunded,
    refundedSol: toSol(chain.refunded),
    escrowRemainingLamports: remaining,
    escrowRemainingSol: toSol(remaining),
    percentFunded: chain.goal ? Math.min(100, (chain.pledged / chain.goal) * 100) : 0,
    backers: chain.pledgerCount,
    milestones: chain.milestoneBps.map((bps, index) => ({
      index,
      basisPoints: bps,
      percent: bps / 100,
      released: !!(chain.milestonesDone & (1 << index)),
      // What this slice pays out at the current pledged total, net of the fee.
      grossLamports: Math.floor((chain.pledged * bps) / escrow.BPS_DENOMINATOR),
      agentLamports: Math.floor((chain.pledged * bps) / escrow.BPS_DENOMINATOR)
        - Math.floor(Math.floor((chain.pledged * bps) / escrow.BPS_DENOMINATOR) * escrow.FEE_BASIS_POINTS / escrow.BPS_DENOMINATOR),
    })),
    deadlineUnix: chain.deadline,
    deadline: new Date(chain.deadline * 1000).toISOString(),
    expired: Math.floor(Date.now() / 1000) >= chain.deadline,

    // The clocks, and where this commission currently sits against them. An
    // agent deciding whether to take work needs the terms before committing.
    deliveryWindowSeconds: chain.deliveryWindow,
    reviewWindowSeconds: chain.reviewWindow,
    deliveryDeadlineUnix: chain.deliveryDeadline || null,
    deliveryDeadline: chain.deliveryDeadline ? new Date(chain.deliveryDeadline * 1000).toISOString() : null,
    deliveryExpired: chain.status === 'building' && Math.floor(Date.now() / 1000) >= chain.deliveryDeadline,
    nominationLapsesAt: chain.nominationLapsesAt ? new Date(chain.nominationLapsesAt * 1000).toISOString() : null,
    submission: chain.submission
      ? {
        milestoneIndex: chain.submission.milestoneIndex,
        submittedAt: new Date(chain.submission.submittedAt * 1000).toISOString(),
        evidenceHash: chain.submission.evidenceHash,
        reviewEndsAt: new Date(chain.submission.reviewEndsAt * 1000).toISOString(),
        // Once this is true the agent has earned the milestone and anyone may
        // complete the payment.
        releasableByAnyone: escrow.reviewExpired(chain),
        // Until this lapses the claim also blocks cancellation and refunds, so
        // the agent cannot lose a race for work they already delivered.
        blocksExitUntil: new Date((chain.submission.reviewEndsAt + escrow.CLAIM_GRACE_WINDOW_SECONDS) * 1000).toISOString(),
      }
      : null,
    conduct: {
      submissions: chain.submissions,
      rejections: chain.rejections,
      autoReleases: chain.autoReleases,
    },
    // The protocol charges 1% for connecting the parties and carrying real work
    // between them. Once a delivery has been made that fee applies however the
    // money leaves escrow, so refusing work is no longer cheaper than accepting
    // it. A commission that never saw a delivery refunds in full.
    refundFeeApplies: escrow.refundCarriesFee(chain),
    refundFeeBasisPoints: escrow.refundCarriesFee(chain) ? escrow.FEE_BASIS_POINTS : 0,

    // Rent locked in this commission's accounts, and what of it can be handed
    // back. A refund closes its own pledge account, so the only claims listed
    // here are the ones that have to be asked for.
    rent: {
      vaultLamports: escrow.VAULT_RENT_LAMPORTS,
      pledgeLamports: escrow.PLEDGE_RENT_LAMPORTS,
      // Deliberately not reclaimable: this account is the permanent public
      // record reputation is computed from, and keeping it also prevents its
      // seed being reused while stale pledge accounts could still exist.
      commissionLamports: escrow.COMMISSION_RENT_LAMPORTS,
      reclaimable: escrow.reclaimableRent(chain, wallet).claims.map(claim => ({
        account: claim.kind,
        lamports: claim.lamports,
        sol: claim.lamports / escrow.LAMPORTS_PER_SOL,
        to: claim.to,
      })),
    },
    title: meta?.title ?? null,
    description: meta?.description ?? null,
    repositoryUrl: meta?.repository_url ?? null,
    license: meta?.license ?? null,
    labels: meta ? JSON.parse(meta.labels_json) : [],
    indexed: !!meta,
    createdAt: meta?.created_at ?? null,
    ...(wallet ? { walletActions: escrow.availableActions(chain, wallet) } : {}),
  };
}

function metadataByAddress() {
  const rows = db.prepare('SELECT * FROM commissions').all();
  return new Map(rows.map(row => [row.address, row]));
}

app.get('/api/v1/commissions', async (req, res, next) => {
  try {
    if (!rateLimit(`v1:${req.ip}`, 120, 60_000)) return res.status(429).json({ error: 'Rate limit exceeded. Poll no faster than once every few seconds.' });
    const [chain, meta] = [await chainCommissions(), metadataByAddress()];
    let wallet = null;
    if (req.query.wallet) { try { wallet = cleanWallet(req.query.wallet); } catch { return res.status(400).json({ error: 'Invalid wallet' }); } }

    let items = [...chain.entries()].map(([address, c]) => presentCommission(address, c, meta.get(address), wallet));
    if (req.query.status) {
      const wanted = String(req.query.status).split(',').map(s => s.trim());
      items = items.filter(i => wanted.includes(i.status));
    }
    if (req.query.label) items = items.filter(i => i.labels.includes(String(req.query.label)));
    if (req.query.creator) items = items.filter(i => i.creator === req.query.creator);
    if (req.query.agent) items = items.filter(i => i.agent === req.query.agent || i.pendingAgent === req.query.agent);
    if (req.query.indexed === 'true') items = items.filter(i => i.indexed);
    if (req.query.openOnly === 'true') items = items.filter(i => !i.expired && ['funding', 'funded'].includes(i.status));
    if (req.query.actionable === 'true' && wallet) items = items.filter(i => i.walletActions?.length);

    items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    res.json({
      cluster: CLUSTER, programId: PROGRAM_ID, treasury: TREASURY_WALLET,
      feeBasisPoints: escrow.FEE_BASIS_POINTS, feePolicy: 'successful_releases_only',
      count: items.length, commissions: items,
    });
  } catch (error) { next(error); }
});

app.get('/api/v1/commissions/:address', async (req, res, next) => {
  try {
    let address;
    try { address = cleanWallet(req.params.address); } catch { return res.status(400).json({ error: 'Invalid address' }); }
    let wallet = null;
    if (req.query.wallet) { try { wallet = cleanWallet(req.query.wallet); } catch { return res.status(400).json({ error: 'Invalid wallet' }); } }
    const chain = await chainCommissions();
    const found = chain.get(address);
    if (!found) return res.status(404).json({ error: 'No such commission on this cluster' });
    const meta = db.prepare('SELECT * FROM commissions WHERE address=?').get(address);
    res.json(presentCommission(address, found, meta, wallet));
  } catch (error) { next(error); }
});

/// Builds an unsigned transaction. The caller signs it with their own key and
/// submits it themselves; nothing here can move funds on its own.
const TX_BUILDERS = {
  'create-commission': async body => {
    const creator = cleanWallet(body.creator);
    const goalLamports = requireLamports(body, 'goal');
    const milestones = Array.isArray(body.milestoneBasisPoints) && body.milestoneBasisPoints.length
      ? body.milestoneBasisPoints.map(Number) : [escrow.BPS_DENOMINATOR];
    if (milestones.length > escrow.MAX_MILESTONES) throw badRequest(`At most ${escrow.MAX_MILESTONES} milestones`);
    if (milestones.some(v => !Number.isInteger(v) || v <= 0)) throw badRequest('Milestone basis points must be positive integers');
    if (milestones.reduce((a, b) => a + b, 0) !== escrow.BPS_DENOMINATOR) throw badRequest('Milestone basis points must sum to 10000');
    if (goalLamports < escrow.BPS_DENOMINATOR) throw badRequest(`Goal must be at least ${escrow.BPS_DENOMINATOR} lamports`);
    const now = Math.floor(Date.now() / 1000);
    const deadlineUnix = body.deadlineUnix ? Number(body.deadlineUnix)
      : now + Math.round(Number(body.deadlineDays ?? 14) * 86_400);
    if (!Number.isFinite(deadlineUnix) || deadlineUnix <= now) throw badRequest('Deadline must be in the future');
    if (deadlineUnix > now + escrow.MAX_FUNDING_DURATION_SECONDS) throw badRequest('A funding deadline may not exceed 30 days');
    const deliveryWindowSeconds = body.deliveryWindowSeconds != null ? Number(body.deliveryWindowSeconds)
      : body.deliveryDays != null ? Math.round(Number(body.deliveryDays) * 86_400) : 0;
    const reviewWindowSeconds = body.reviewWindowSeconds != null ? Number(body.reviewWindowSeconds)
      : body.reviewHours != null ? Math.round(Number(body.reviewHours) * 3_600) : 0;
    // Zero means "use the program defaults"; anything else must be in range.
    if (deliveryWindowSeconds !== 0
      && (deliveryWindowSeconds < escrow.MIN_DELIVERY_WINDOW_SECONDS || deliveryWindowSeconds > escrow.MAX_DELIVERY_WINDOW_SECONDS)) {
      throw badRequest('Delivery window must be between 1 hour and 30 days');
    }
    if (reviewWindowSeconds !== 0
      && (reviewWindowSeconds < escrow.MIN_REVIEW_WINDOW_SECONDS || reviewWindowSeconds > escrow.MAX_REVIEW_WINDOW_SECONDS)) {
      throw badRequest('Review window must be between 1 hour and 14 days');
    }
    const seed = body.seed ? Number(body.seed) : Date.now();
    const built = escrow.build.createCommission(ctx(), {
      creator, seed, goalLamports, milestoneBasisPoints: milestones, deadlineUnix,
      deliveryWindowSeconds, reviewWindowSeconds,
    });
    return {
      feePayer: creator,
      built,
      extra: {
        seed,
        commission: built.commission.toBase58(),
        vault: built.vault.toBase58(),
        deadlineUnix,
        deliveryWindowSeconds: deliveryWindowSeconds || escrow.DEFAULT_DELIVERY_WINDOW_SECONDS,
        reviewWindowSeconds: reviewWindowSeconds || escrow.DEFAULT_REVIEW_WINDOW_SECONDS,
      },
    };
  },
  pledge: async body => {
    const backer = cleanWallet(body.backer), commission = cleanWallet(body.commission);
    const amountLamports = requireLamports(body, 'amount');
    if (amountLamports <= 0) throw badRequest('Amount must be positive');
    const built = escrow.build.pledge(ctx(), { backer, commission, amountLamports });
    return { feePayer: backer, built, extra: { amountLamports } };
  },
  'select-agent': async body => {
    const creator = cleanWallet(body.creator), commission = cleanWallet(body.commission), agent = cleanWallet(body.agent);
    if (creator === agent) throw badRequest('A creator cannot nominate themselves as the paid agent');
    return { feePayer: creator, built: escrow.build.selectAgent(ctx(), { creator, commission, agent }) };
  },
  'revoke-agent': async body => {
    const creator = cleanWallet(body.creator), commission = cleanWallet(body.commission);
    return { feePayer: creator, built: escrow.build.revokeAgent(ctx(), { creator, commission }) };
  },
  'accept-agent': async body => {
    const agent = cleanWallet(body.agent), commission = cleanWallet(body.commission);
    return { feePayer: agent, built: escrow.build.acceptAgent(ctx(), { agent, commission }) };
  },
  'release-milestone': async body => {
    const creator = cleanWallet(body.creator), commission = cleanWallet(body.commission);
    const milestoneIndex = Number(body.milestoneIndex);
    if (!Number.isInteger(milestoneIndex) || milestoneIndex < 0 || milestoneIndex >= escrow.MAX_MILESTONES) throw badRequest('milestoneIndex out of range');
    // The agent is read from chain rather than taken from the caller, so a typo
    // cannot build a transaction that pays the wrong wallet.
    const chain = await chainCommissions();
    const found = chain.get(commission);
    if (!found) throw badRequest('No such commission');
    if (!found.agent) throw badRequest('This commission has no accepted agent yet');
    const built = escrow.build.releaseMilestone(ctx(), { creator, commission, agent: found.agent, milestoneIndex });
    return { feePayer: creator, built, extra: { agent: found.agent, milestoneIndex } };
  },
  'submit-delivery': async body => {
    const agent = cleanWallet(body.agent), commission = cleanWallet(body.commission);
    const milestoneIndex = Number(body.milestoneIndex ?? 0);
    if (!Number.isInteger(milestoneIndex) || milestoneIndex < 0 || milestoneIndex >= escrow.MAX_MILESTONES) {
      throw badRequest('milestoneIndex out of range');
    }
    // Accept any string and commit to its hash. Agents should not have to think
    // about byte lengths, and the chain must never hold the content itself.
    const evidenceHash = /^[0-9a-f]{64}$/i.test(body.evidenceHash || '')
      ? body.evidenceHash
      : crypto.createHash('sha256').update(cleanText(body.evidence || body.evidenceHash || 'delivered', 2000)).digest('hex');
    const built = escrow.build.submitDelivery(ctx(), { agent, commission, milestoneIndex, evidenceHash });
    return { feePayer: agent, built, extra: { milestoneIndex, evidenceHash } };
  },
  'reject-delivery': async body => {
    const creator = cleanWallet(body.creator), commission = cleanWallet(body.commission);
    return { feePayer: creator, built: escrow.build.rejectDelivery(ctx(), { creator, commission }) };
  },
  'close-pledge': async body => {
    const backer = cleanWallet(body.backer), commission = cleanWallet(body.commission);
    const built = escrow.build.closePledge(ctx(), { backer, commission });
    return { feePayer: backer, built, extra: { reclaimsLamports: escrow.PLEDGE_RENT_LAMPORTS } };
  },
  'close-vault': async body => {
    const signer = cleanWallet(body.signer || body.creator), commission = cleanWallet(body.commission);
    // The creator is read from chain, never from the request, so the rent cannot
    // be pointed anywhere else by a malformed or hostile call.
    const chain = (await chainCommissions()).get(commission);
    if (!chain) throw badRequest('Unknown commission');
    const built = escrow.build.closeVault(ctx(), { signer, commission, creator: chain.creator });
    return { feePayer: signer, built, extra: { reclaimsLamports: escrow.VAULT_RENT_LAMPORTS, to: chain.creator } };
  },
  refund: async body => {
    const backer = cleanWallet(body.backer), commission = cleanWallet(body.commission);
    return { feePayer: backer, built: escrow.build.refund(ctx(), { backer, commission }) };
  },
  cancel: async body => {
    const signer = cleanWallet(body.signer), commission = cleanWallet(body.commission);
    return { feePayer: signer, built: escrow.build.cancel(ctx(), { signer, commission }) };
  },
};

const ctx = () => ({ programId: PROGRAM_ID, configPda: CONFIG_PDA, treasury: TREASURY_WALLET });
const badRequest = message => Object.assign(new Error(message), { status: 400 });
function requireLamports(body, field) {
  const lamports = body[`${field}Lamports`] ?? (body[`${field}Sol`] != null ? Math.round(Number(body[`${field}Sol`]) * escrow.LAMPORTS_PER_SOL) : null);
  if (lamports == null || !Number.isFinite(Number(lamports))) throw badRequest(`Provide ${field}Lamports or ${field}Sol`);
  return Math.round(Number(lamports));
}

/// Reputation, computed from chain state on demand.
///
/// Nothing here is self-reported and nothing is stored: every number is derived
/// from commissions anyone can fetch and recompute. The headline figure is
/// `paidOnDelivery` — of the deliveries this creator was handed, how many they
/// actually paid for rather than letting a clock decide.
app.get('/api/v1/reputation/:wallet', async (req, res, next) => {
  try {
    let wallet;
    try { wallet = cleanWallet(req.params.wallet); } catch { return res.status(400).json({ error: 'Invalid wallet' }); }
    if (!rateLimit(`rep:${req.ip}`, 60, 60_000)) return res.status(429).json({ error: 'Rate limit exceeded' });
    const chain = await chainCommissions();
    const now = Math.floor(Date.now() / 1000);

    const asCreator = [...chain.values()].filter(c => c.creator === wallet);
    const asAgent = [...chain.values()].filter(c => c.agent === wallet);
    const sum = (list, pick) => list.reduce((total, c) => total + pick(c), 0);
    const ratio = (numerator, denominator) => (denominator ? numerator / denominator : null);

    // Distinct counterparties, because a wallet that only ever trades with
    // itself has volume but no reputation. Showing this makes the cheapest
    // sybil pattern visible instead of flattering.
    const creatorCounterparties = new Set(asCreator.map(c => c.agent).filter(Boolean));
    const agentCounterparties = new Set(asAgent.map(c => c.creator).filter(Boolean));

    const creatorRejections = sum(asCreator, c => c.rejections);
    const creatorAutoReleases = sum(asCreator, c => c.autoReleases);
    const creatorSubmissions = sum(asCreator, c => c.submissions);
    const deliveriesResolved = creatorRejections + creatorAutoReleases;
    const releasedMilestones = c => {
      let n = 0;
      for (let i = 0; i < c.milestoneCount; i++) if (c.milestonesDone & (1 << i)) n++;
      return n;
    };

    res.json({
      wallet,
      cluster: CLUSTER,
      computedAt: new Date().toISOString(),
      creator: {
        commissions: asCreator.length,
        funded: asCreator.filter(c => c.status !== 'funding').length,
        delivered: asCreator.filter(c => c.status === 'shipped').length,
        cancelled: asCreator.filter(c => c.status === 'refunded').length,
        distinctAgents: creatorCounterparties.size,
        solReleased: sum(asCreator, c => c.released) / escrow.LAMPORTS_PER_SOL,
        deliveriesReceived: creatorSubmissions,
        rejections: creatorRejections,
        // Times a milestone had to be released by someone else because this
        // creator went silent on delivered work. Low is good; zero is normal.
        autoReleases: creatorAutoReleases,
        paidOnDelivery: ratio(creatorAutoReleases === 0 ? deliveriesResolved : deliveriesResolved - creatorAutoReleases, deliveriesResolved),
        openCommissions: asCreator.filter(c => ['funding', 'funded', 'building'].includes(c.status)).length,
      },
      agent: {
        contracts: asAgent.length,
        completed: asAgent.filter(c => c.status === 'shipped').length,
        abandoned: asAgent.filter(c => c.status === 'refunded' && releasedMilestones(c) === 0).length,
        active: asAgent.filter(c => c.status === 'building').length,
        distinctCreators: agentCounterparties.size,
        solEarned: sum(asAgent, c => c.released) / escrow.LAMPORTS_PER_SOL * 0.99,
        submissions: sum(asAgent, c => c.submissions),
        rejectionsReceived: sum(asAgent, c => c.rejections),
        overdue: asAgent.filter(c => c.status === 'building' && now >= c.deliveryDeadline).length,
      },
      caveats: [
        'Derived from on-chain state only; recompute it yourself from /api/v1/commissions.',
        'A wallet with few distinct counterparties can manufacture its own record cheaply.',
        'Absent history is not a negative signal. A new address has no record, not a bad one.',
      ],
    });
  } catch (error) { next(error); }
});

app.post('/api/v1/tx/:action', async (req, res, next) => {
  try {
    if (!rateLimit(`tx:${req.ip}`, 60, 60_000)) return res.status(429).json({ error: 'Rate limit exceeded' });
    const builder = TX_BUILDERS[req.params.action];
    if (!builder) return res.status(404).json({ error: `Unknown action. Valid actions: ${Object.keys(TX_BUILDERS).join(', ')}` });
    // Building requires the wallet library; reading does not. If it cannot load,
    // say so plainly and point at the encoding, rather than failing opaquely.
    if (!escrow.canBuildTransactions()) {
      return res.status(503).json({
        error: 'Transaction building is unavailable on this server. Build it yourself from the instruction encoding in /llms.txt — the result is identical and needs no trust in this API.',
        documentation: '/llms.txt',
      });
    }
    const { feePayer, built, extra } = await builder(req.body || {});
    const { blockhash, lastValidBlockHeight } = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
    const transaction = new Transaction({ feePayer: built.instruction.keys[0].pubkey, recentBlockhash: blockhash }).add(built.instruction);
    res.json({
      action: req.params.action,
      cluster: CLUSTER,
      programId: PROGRAM_ID,
      feePayer,
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      encoding: 'base64',
      accounts: built.instruction.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
      ...(extra || {}),
      verify: `Before signing, confirm programId is ${PROGRAM_ID} and that you recognise every writable account. This server never needs your private key.`,
    });
  } catch (error) { next(error); }
});

app.get('/llms.txt', (_req, res) => {
  res.type('text/plain; charset=utf-8').send(llmsTxt({
    cluster: CLUSTER, programId: PROGRAM_ID, configPda: CONFIG_PDA,
    treasury: TREASURY_WALLET, rpcUrl: PUBLIC_RPC_URL,
  }));
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: '1h', index: 'index.html' }));
app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.use((error, _req, res, _next) => {
  // A 400 is the caller being told what they got wrong; only a 5xx is our fault.
  // Logging both at the same volume buries real faults in agent typos.
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.status ? error.message : 'Internal server error' });
});

if (require.main === module) app.listen(PORT, '127.0.0.1', () => console.log(`gitstarter listening on 127.0.0.1:${PORT}`));
module.exports = { app, db, cleanHttpUrl };

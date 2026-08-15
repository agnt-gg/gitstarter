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
// Defaults describe the network this build is FOR, not a safer-looking one.
//
// They used to be devnet, on the reasoning that an unconfigured server should
// not touch real money. That stopped being true when the browser began pinning
// its addresses: a devnet-defaulting server now serves a config the client
// refuses outright, so the "safe" default produces a broken app rather than a
// cautious one. Devnet work is a devnet build, with these set explicitly.
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const CLUSTER = process.env.SOLANA_CLUSTER || 'mainnet-beta';
// The server's own RPC endpoint may embed a provider API key. Browsers get a
// keyless endpoint instead, so /api/config can never hand out billing credentials.
//
// The browser endpoint is also a DIFFERENT endpoint from the server's, not
// merely a keyless copy of it. api.mainnet-beta.solana.com answers servers
// normally and 403s anything carrying an Origin header — every browser — so
// handing browsers the server's endpoint shipped a site where every wallet
// action failed while every server-side test passed. The two audiences need
// endpoints chosen for how each actually connects.
const BROWSER_SAFE_RPC = CLUSTER === 'mainnet-beta'
  ? 'https://solana-rpc.publicnode.com'
  : 'https://api.devnet.solana.com';
const PUBLIC_RPC_URL = process.env.PUBLIC_SOLANA_RPC_URL
  || (/api-key|\?|api\.mainnet-beta/i.test(RPC_URL) ? BROWSER_SAFE_RPC : RPC_URL);
const PROGRAM_ID = process.env.PROGRAM_ID || 'HYrwoRKRdPDpuwTHAv3BzbdGXtTVrMe6vzBFefX8RiH4';
const TREASURY_WALLET = process.env.TREASURY_WALLET || '6RehrefK9bq2U8dJse96GjGGHm8t6mznxGR1Qj2e1A5P';
const CONFIG_PDA = process.env.CONFIG_PDA || 'E7tHZCvZWB6fQLwZA6KCipgJszjPn4ZTzSUdZC1XX4x2';
const DB_PATH = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'gitstarter.sqlite'));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// __Host- forbids a Domain attribute and requires Secure + Path=/, so a
// compromised sibling subdomain cannot force a cookie onto this origin.
const SESSION_COOKIE = '__Host-gitstarter_session';
// The domain named inside the message a wallet is asked to sign.
//
// It has to be the domain the user is looking at. A message that says
// "Domain: gitstarter.agnt.gg" presented on gitstarter.xyz is indistinguishable
// from a phishing attempt, and it is the exact thing every wallet guide tells
// people to refuse — so getting this wrong either trains users to ignore the
// warning or stops them signing in at all.
const SIGN_IN_DOMAIN = process.env.SIGN_IN_DOMAIN || 'gitstarter.xyz';
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
  // The poster's chosen name travels with the row the board already fetches, so
  // a list of commissions can say who posted them without a request per row.
  const rows = db.prepare(`SELECT c.*, h.handle AS creator_handle
    FROM commissions c LEFT JOIN handles h ON h.wallet = c.creator
    ORDER BY c.created_at DESC LIMIT 200`).all();
  // One grouped query rather than one per commission: the browser renders the
  // review panel straight from this list, so the evidence has to arrive with it.
  const byCommission = new Map();
  for (const row of db.prepare('SELECT * FROM deliveries ORDER BY submitted_at DESC').all()) {
    if (!byCommission.has(row.commission)) byCommission.set(row.commission, []);
    byCommission.get(row.commission).push({
      milestoneIndex: row.milestone_index,
      evidence: row.evidence,
      evidenceHash: row.evidence_hash,
      agent: row.agent,
      submittedAt: row.submitted_at,
    });
  }
  res.json(rows.map(row => ({ address: row.address, creator: row.creator, txSignature: row.tx_signature, title: row.title, description: row.description, repositoryUrl: row.repository_url, license: row.license, labels: JSON.parse(row.labels_json), createdAt: row.created_at, creatorHandle: row.creator_handle || null, deliveries: byCommission.get(row.address) || [] })));
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
/// Records what an agent actually delivered.
///
/// The program commits to a 32-byte SHA-256 of the evidence and stores nothing
/// else, which is right for the chain and useless for a human: a creator saw a
/// truncated hash and had no way to know what they were being asked to approve.
///
/// **The hash is the authorization.** A row is accepted only if the text hashes
/// to the commitment already on chain, and only the party who chose that text
/// can produce a preimage for it. So this needs no session and no signature:
/// there is no hostile input, because the only thing an attacker can submit is
/// the correct answer. That also means a headless agent, or a creator who was
/// sent the text out of band, can supply it.
app.post('/api/deliveries', async (req, res, next) => {
  try {
    if (!rateLimit(`delivery:${req.ip}`, 30, 60_000)) return res.status(429).json({ error: 'Rate limit exceeded' });
    const commission = cleanWallet(req.body.commission);
    const evidence = cleanText(req.body.evidence, 4000);
    const milestoneIndex = Number(req.body.milestoneIndex);
    if (!Number.isInteger(milestoneIndex) || milestoneIndex < 0 || milestoneIndex >= escrow.MAX_MILESTONES) {
      return res.status(400).json({ error: 'milestoneIndex out of range' });
    }

    // Read the account directly rather than from the 5-second cache: an agent
    // posts evidence immediately after submitting, and a stale read would
    // reject the very delivery that just landed.
    const account = (await rpc('getAccountInfo', [commission, { commitment: 'confirmed', encoding: 'base64' }]))?.value;
    if (!account || account.owner !== PROGRAM_ID) return res.status(404).json({ error: 'Unknown commission' });
    let chain;
    try { chain = escrow.decodeCommission(Buffer.from(account.data[0], 'base64')); }
    catch { return res.status(409).json({ error: 'Address is not a GitStarter commission' }); }

    // Several agents may be competing on this milestone, so the evidence is
    // matched against whichever submission actually committed to it. The hash is
    // still the authorization: only the agent who chose the text can produce a
    // preimage for a commitment already on chain, whoever sends it.
    const digest = crypto.createHash('sha256').update(evidence, 'utf8').digest();
    const candidates = await rpc('getProgramAccounts', [PROGRAM_ID, {
      commitment: 'confirmed', encoding: 'base64',
      filters: [
        { dataSize: escrow.SUBMISSION_ACCOUNT_BYTES },
        { memcmp: { offset: 0, bytes: '5' } },
        { memcmp: { offset: 1, bytes: commission } },
      ],
    }]);
    let matched = null;
    for (const entry of candidates) {
      let candidate;
      try { candidate = escrow.decodeSubmission(Buffer.from(entry.account.data[0], 'base64')); } catch { continue; }
      if (candidate.milestoneIndex !== milestoneIndex) continue;
      const committed = Buffer.from(candidate.evidenceHash, 'hex');
      if (digest.length === committed.length && crypto.timingSafeEqual(digest, committed)) { matched = candidate; break; }
    }
    if (!matched) {
      return res.status(409).json({
        error: candidates.length
          ? 'This text does not match any delivery committed on chain for that milestone'
          : 'No delivery has been submitted for that milestone',
      });
    }

    const record = {
      commission, milestoneIndex, evidence,
      evidenceHash: matched.evidenceHash,
      agent: matched.agent,
      submittedAt: matched.submittedAt,
      createdAt: Date.now(),
    };
    // Idempotent: re-posting the same proven text is a no-op, not a conflict.
    db.prepare(`INSERT INTO deliveries(commission,milestone_index,evidence_hash,evidence,agent,submitted_at,created_at)
      VALUES(@commission,@milestoneIndex,@evidenceHash,@evidence,@agent,@submittedAt,@createdAt)
      ON CONFLICT(commission,evidence_hash) DO NOTHING`).run(record);
    res.status(201).json({ ...record, verified: true });
  } catch (error) { next(error); }
});

/// Every delivery ever recorded for a commission, newest first.
function deliveriesFor(commission) {
  return db.prepare('SELECT * FROM deliveries WHERE commission = ? ORDER BY submitted_at DESC, created_at DESC LIMIT 32')
    .all(commission)
    .map(row => ({
      milestoneIndex: row.milestone_index,
      evidence: row.evidence,
      evidenceHash: row.evidence_hash,
      agent: row.agent,
      submittedAt: new Date(row.submitted_at * 1000).toISOString(),
    }));
}

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

/// Records the current on-chain state of every delivery and intent.
///
/// Settling a commission closes these accounts so their deposits go home
/// unasked, which is right for the money and wrong for the record: an agent's
/// entire history vanished the moment they got paid. The chain remains the
/// authority — this only remembers what it said while it was still saying it.
const rememberDelivery = db.prepare(`
  INSERT INTO delivery_history
    (commission, milestone_index, agent, sequence, submitted_at, evidence_hash, last_state, first_seen, last_seen)
  VALUES (@commission, @milestoneIndex, @agent, @sequence, @submittedAt, @evidenceHash, @state, @now, @now)
  ON CONFLICT(commission, milestone_index, agent) DO UPDATE SET
    last_state = excluded.last_state,
    sequence = excluded.sequence,
    last_seen = excluded.last_seen
  WHERE delivery_history.last_state != excluded.last_state`);
const rememberIntent = db.prepare(`
  INSERT INTO intent_history (commission, agent, signalled_at, withdrawn, last_seen)
  VALUES (@commission, @agent, @signalledAt, @withdrawn, @now)
  ON CONFLICT(commission, agent) DO UPDATE SET
    withdrawn = excluded.withdrawn,
    last_seen = excluded.last_seen
  WHERE intent_history.withdrawn != excluded.withdrawn`);

/// Copies the on-chain name claims into the local cache.
///
/// Deliberately an upsert with no delete: the program has no CloseHandle, so a
/// claim that vanished from a scan is a failed read rather than a released name,
/// and honouring that would let a flaky RPC call free somebody's identity.
const mirrorHandleClaims = db.transaction(claims => {
  const upsert = db.prepare(`INSERT INTO handle_claims (handle_key, wallet, claimed_at)
    VALUES (@handle, @wallet, @claimedAt)
    ON CONFLICT(handle_key) DO UPDATE SET wallet = excluded.wallet`);
  for (const claim of claims) upsert.run({ ...claim, claimedAt: claim.claimedAt * 1000 });
});

const rememberChainState = db.transaction((submissionsByCommission, intents) => {
  const now = Math.floor(Date.now() / 1000);
  for (const list of submissionsByCommission.values()) {
    for (const s of list) rememberDelivery.run({ ...s, now });
  }
  for (const i of intents) rememberIntent.run({ ...i, withdrawn: i.withdrawn ? 1 : 0, now });
});

const rememberNotification = db.prepare(`
  INSERT INTO notifications (wallet, kind, commission, milestone_index, body, dedupe_key, created_at)
  VALUES (@wallet, @kind, @commission, @milestoneIndex, @body, @dedupeKey, @now)
  ON CONFLICT(dedupe_key) DO NOTHING`);

/// Turns the board, as it is right now, into things specific wallets need told.
///
/// Derived from current state rather than from a diff against the last scan,
/// and every event carries a key that encodes the exact transition it describes.
/// So observing the same board a thousand times produces the same keys and the
/// unique index drops all but the first — which means this is correct across a
/// restart, a crash mid-scan, or two servers scanning at once, none of which a
/// remembered-previous-state diff would survive.
function detectEvents(commissions, submissionsByCommission, settled, nowUnix) {
  const events = [];
  const say = (wallet, kind, commission, milestoneIndex, body, dedupeKey) =>
    events.push({ wallet, kind, commission, milestoneIndex, body, dedupeKey });

  // Outcomes come from the durable record, never from live accounts.
  //
  // Settling a commission judges a delivery and sweeps its account in the SAME
  // transaction, so an account carrying state 'released' never exists for any
  // scan to see. Reading these from the chain meant the two events that tell an
  // agent what happened to their work could not fire at all — the same mistake
  // that once erased an agent's reputation the moment they were paid.
  for (const d of settled) {
    const m = d.milestoneIndex + 1;
    if (d.state === 'rejected') {
      say(d.agent, 'delivery-rejected', d.commission, d.milestoneIndex,
        `Your delivery for milestone ${m} was refused. You can contest it, which puts your objection on the creator's public record.`,
        `rejected:${d.commission}:${d.milestoneIndex}:${d.agent}`);
    } else if (d.state === 'released') {
      say(d.agent, 'delivery-paid', d.commission, d.milestoneIndex,
        `You were paid for milestone ${m}.`,
        `paid:${d.commission}:${d.milestoneIndex}:${d.agent}`);
    }
  }

  for (const [address, c] of commissions) {
    const queue = submissionsByCommission.get(address) || [];
    for (const s of queue) {
      const paid = (c.milestonesDone & (1 << s.milestoneIndex)) !== 0;
      const front = s.sequence === (c.milestoneRejected[s.milestoneIndex] ?? 0);
      const m = s.milestoneIndex + 1;
      if (s.state !== 'pending' || paid || !front) continue;

      // The case that actually costs money if nobody is looking: work has been
      // delivered, the review window is counting down, and staying silent pays
      // it out automatically.
      const expired = escrow.reviewExpired(s, c.reviewWindow, nowUnix);
      if (expired) {
        say(c.creator, 'review-lapsed', address, s.milestoneIndex,
          `Milestone ${m} was delivered and your review window has passed. That delivery can now be released by anyone, including the agent.`,
          `lapsed:${address}:${s.milestoneIndex}:${s.sequence}`);
        say(s.agent, 'claimable', address, s.milestoneIndex,
          `Milestone ${m} is yours to claim — the review window passed without an answer.`,
          `claimable:${address}:${s.milestoneIndex}:${s.agent}`);
      } else {
        say(c.creator, 'delivery-waiting', address, s.milestoneIndex,
          `Milestone ${m} was delivered and is waiting on you. Release it, refuse it, or it pays out when the window closes.`,
          `waiting:${address}:${s.milestoneIndex}:${s.sequence}`);
      }
    }
  }
  return events;
}

const recordEvents = db.transaction(events => {
  const now = Date.now();
  for (const event of events) rememberNotification.run({ ...event, now });
});

/// Deliveries competing for a commission, oldest first. Populated by the same
/// scan that loads the commissions themselves.
function submissionsFor(address) {
  return chainCache.submissions?.get(address) || [];
}

/// What a delivery's outcome was, once its account has been swept away.
///
/// This needs no stored verdict because the queue is judged strictly in order,
/// so the commission's own two counters settle it: a delivery at position
/// `sequence` was refused if more than that many have been rejected, it won if
/// it is the one at the front of a milestone that paid out, and it was simply
/// never judged if somebody ahead of it won first.
function settledState(commission, milestoneIndex, sequence, lastObserved) {
  // A terminal state we actually saw on chain beats any inference.
  if (lastObserved === 'released' || lastObserved === 'rejected') return lastObserved;

  const rejectedAhead = commission.milestoneRejected[milestoneIndex] ?? 0;
  const paid = (commission.milestonesDone & (1 << milestoneIndex)) !== 0;
  if (sequence < rejectedAhead) return 'rejected';
  if (sequence === rejectedAhead) {
    if (paid) return 'released';
    // A commission that ended without paying this milestone never judged it.
    return commission.status === 'refunded' ? 'superseded' : 'pending';
  }
  // Behind somebody in the queue: judged only if those ahead were refused.
  return paid || commission.status === 'refunded' ? 'superseded' : 'pending';
}

/// Net lamports an agent received for winning one milestone.
///
/// The slice is `bps` of the pot, less the 1% connection fee, matching
/// `split_fee` in the program. The milestone that completes a schedule also
/// absorbs the rounding dust from every earlier slice, which is a handful of
/// lamports and is not attributed here rather than being guessed at.
function milestonePayout(commission, milestoneIndex) {
  const bps = commission.milestoneBps[milestoneIndex] ?? 0;
  const gross = Math.floor((commission.pledged * bps) / 10_000);
  return gross - Math.floor((gross * escrow.FEE_BASIS_POINTS) / 10_000);
}

/// One getProgramAccounts call serves every concurrent reader for a few seconds.
/// Without this, a handful of polling agents would rate-limit the RPC endpoint
/// for everyone, which is a self-inflicted outage rather than a load problem.
async function chainCommissions() {
  const now = Date.now();
  if (chainCache.value && now - chainCache.at < CHAIN_CACHE_MS) return chainCache.value;
  if (chainCache.inflight) return chainCache.inflight;
  chainCache.inflight = (async () => {
    try {
      // Commissions and the deliveries competing for them, in two calls rather
      // than one per commission. An open board means several agents may be
      // queued on the same milestone, and nothing about the board makes sense
      // without knowing who is in that queue and in what order.
      const [accounts, submissionAccounts, intentAccounts, handleAccounts] = await Promise.all([
        rpc('getProgramAccounts', [PROGRAM_ID, {
          commitment: 'confirmed', encoding: 'base64',
          filters: [{ dataSize: escrow.COMMISSION_ACCOUNT_BYTES }, { memcmp: { offset: 0, bytes: '3' } }],
        }]),
        rpc('getProgramAccounts', [PROGRAM_ID, {
          commitment: 'confirmed', encoding: 'base64',
          filters: [{ dataSize: escrow.SUBMISSION_ACCOUNT_BYTES }, { memcmp: { offset: 0, bytes: '5' } }],
        }]),
        rpc('getProgramAccounts', [PROGRAM_ID, {
          commitment: 'confirmed', encoding: 'base64',
          filters: [{ dataSize: escrow.INTENT_ACCOUNT_BYTES }, { memcmp: { offset: 0, bytes: '6' } }],
        }]),
        // Name claims. These used to live only in SQLite, which made this
        // service's database the single thing in the system whose loss could not
        // be recovered from — and it was carrying the guarantee that matters
        // most, that a reputation cannot be inherited by somebody who did not
        // build it. They are on chain now, so this scan rebuilds them.
        rpc('getProgramAccounts', [PROGRAM_ID, {
          commitment: 'confirmed', encoding: 'base64',
          filters: [{ dataSize: escrow.HANDLE_ACCOUNT_BYTES }, { memcmp: { offset: 0, bytes: '7' } }],
        }]),
      ]);
      const value = new Map();
      for (const entry of accounts) {
        try {
          value.set(entry.pubkey, escrow.decodeCommission(Buffer.from(entry.account.data[0], 'base64')));
        } catch { /* not a commission we understand; skip rather than fail the request */ }
      }
      const submissions = new Map();
      for (const entry of submissionAccounts) {
        try {
          const s = escrow.decodeSubmission(Buffer.from(entry.account.data[0], 'base64'));
          if (!submissions.has(s.commission)) submissions.set(s.commission, []);
          submissions.get(s.commission).push({ ...s, address: entry.pubkey });
        } catch { /* skip */ }
      }
      for (const list of submissions.values()) list.sort((a, b) => a.sequence - b.sequence);
      const intents = [];
      for (const entry of intentAccounts) {
        try { intents.push(escrow.decodeIntent(Buffer.from(entry.account.data[0], 'base64'))); }
        catch { /* skip */ }
      }
      // Copy what the chain currently says into the durable index, BEFORE the
      // settling sweep closes these accounts. Nothing is invented here: every
      // row is a verbatim observation of an account that existed at this moment.
      // Mirror the on-chain claims. This table is now a cache rather than the
      // record: every row here is reconstructible by anybody scanning the
      // program, so losing this database costs bios and nothing else.
      const claims = [];
      for (const entry of handleAccounts) {
        try { claims.push(escrow.decodeHandleClaim(Buffer.from(entry.account.data[0], 'base64'))); }
        catch { /* not a claim we understand */ }
      }
      try { mirrorHandleClaims(claims); } catch (error) { console.error('handle mirror failed', error); }

      try { rememberChainState(submissions, intents); } catch { /* an index that fails must never fail a read */ }
      // Same rule: telling somebody what happened must never be the reason they
      // cannot read the board.
      try {
        // Reconciled the same way reputation is, so a swept delivery still has
        // an outcome to report.
        chainCache.submissions = submissions;
        const settled = [];
        for (const row of db.prepare('SELECT * FROM delivery_history').all()) {
          const c = value.get(row.commission);
          if (!c) continue;
          const live = (submissions.get(row.commission) || [])
            .find(s => s.agent === row.agent && s.milestoneIndex === row.milestone_index);
          const state = live ? live.state : settledState(c, row.milestone_index, row.sequence, row.last_state);
          if (state === 'released' || state === 'rejected') {
            settled.push({ commission: row.commission, milestoneIndex: row.milestone_index, agent: row.agent, state });
          }
        }
        recordEvents(detectEvents(value, submissions, settled, Math.floor(Date.now() / 1000)));
      } catch (error) { console.error('notification scan failed', error); }
      chainCache = { at: Date.now(), value, submissions, intents, inflight: null };
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
  const deliveries = deliveriesFor(address);
  const submissions = submissionsFor(address);
  const nowUnix = Math.floor(Date.now() / 1000);
  return {
    address,
    explorer: explorerUrl(address),
    status: chain.status,
    creator: chain.creator,
    // Open by default: no agent is assigned, and none has to be. `invitedAgent`
    // is set only when a creator deliberately narrowed the board to one wallet.
    open: chain.isOpen,
    invitedAgent: chain.invitedAgent,
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
    workWindowSeconds: chain.workWindow,
    reviewWindowSeconds: chain.reviewWindow,
    workDeadlineUnix: chain.workDeadline || null,
    workDeadline: chain.workDeadline ? new Date(chain.workDeadline * 1000).toISOString() : null,
    workClosed: escrow.workClosed(chain, nowUnix),
    // The question an agent actually asks before spending anything: can I work
    // on this right now, and how much competition am I walking into?
    openForWork: chain.status === 'funded' && !escrow.workClosed(chain, nowUnix),
    competition: {
      agentsSignalled: chain.intents,
      deliveriesSubmitted: chain.submissions,
      deliveriesWaiting: chain.unresolvedSubmissions,
      rejections: chain.rejections,
    },
    // Every delivery currently competing, in the order it will be judged.
    //
    // The first entry on each milestone is the one that may be released or
    // rejected right now; the rest are behind it and become judgeable only if it
    // is refused. That ordering is enforced on chain, not merely displayed.
    submissions: submissions.map(s => {
      const reviewEndsAt = escrow.reviewEndsAt(s, chain.reviewWindow);
      return {
        address: s.address,
        agent: s.agent,
        milestoneIndex: s.milestoneIndex,
        queuePosition: s.sequence - (chain.milestoneRejected[s.milestoneIndex] ?? 0),
        state: s.state,
        submittedAt: new Date(s.submittedAt * 1000).toISOString(),
        evidenceHash: s.evidenceHash,
        reviewEndsAt: new Date(reviewEndsAt * 1000).toISOString(),
        // True for the delivery at the front of its queue, once its own review
        // window has run. Anyone may then complete the payment.
        releasableByAnyone: s.sequence === (chain.milestoneRejected[s.milestoneIndex] ?? 0)
          && escrow.reviewExpired(s, chain.reviewWindow, nowUnix),
        blocksExitUntil: new Date((reviewEndsAt + escrow.CLAIM_GRACE_WINDOW_SECONDS) * 1000).toISOString(),
        // What was actually delivered, if the preimage of the commitment has
        // been recorded. Null means nobody has supplied it yet, which is a
        // meaningfully different thing to say than showing a bare hash.
        evidence: deliveries.find(d => d.evidenceHash === s.evidenceHash)?.evidence ?? null,
      };
    }),
    // Names for every wallet on this commission, so a queue of 44-character
    // addresses can be read. Always alongside the address, never instead of it.
    handles: handlesFor([chain.creator, ...submissions.map(s => s.agent)]),
    // The one delivery per milestone that can be acted on right now.
    nextToJudge: chain.milestoneBps.map((_, index) => {
      const front = escrow.frontOfQueue(chain, submissions, index);
      return front ? { milestoneIndex: index, agent: front.agent, address: front.address } : null;
    }).filter(Boolean),
    // Every delivery ever recorded here, including ones already released or
    // rejected. A creator judging milestone three should be able to see what
    // they accepted for milestone one.
    deliveries,
    conduct: {
      submissions: chain.submissions,
      rejections: chain.rejections,
      autoReleases: chain.autoReleases,
      intents: chain.intents,
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
    // "Work I could take" is the query an agent actually runs.
    if (req.query.openForWork === 'true') items = items.filter(i => i.openForWork);
    if (req.query.agent) items = items.filter(i => i.submissions?.some(s => s.agent === req.query.agent) || i.invitedAgent === req.query.agent);
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
    const workWindowSeconds = body.workWindowSeconds != null ? Number(body.workWindowSeconds)
      : body.workDays != null ? Math.round(Number(body.workDays) * 86_400)
      : body.deliveryWindowSeconds != null ? Number(body.deliveryWindowSeconds)
      : body.deliveryDays != null ? Math.round(Number(body.deliveryDays) * 86_400) : 0;
    const reviewWindowSeconds = body.reviewWindowSeconds != null ? Number(body.reviewWindowSeconds)
      : body.reviewHours != null ? Math.round(Number(body.reviewHours) * 3_600) : 0;
    // Zero means "use the program defaults"; anything else must be in range.
    if (workWindowSeconds !== 0
      && (workWindowSeconds < escrow.MIN_WORK_WINDOW_SECONDS || workWindowSeconds > escrow.MAX_WORK_WINDOW_SECONDS)) {
      throw badRequest('Work window must be between 1 hour and 30 days');
    }
    if (reviewWindowSeconds !== 0
      && (reviewWindowSeconds < escrow.MIN_REVIEW_WINDOW_SECONDS || reviewWindowSeconds > escrow.MAX_REVIEW_WINDOW_SECONDS)) {
      throw badRequest('Review window must be between 1 hour and 14 days');
    }
    const seed = body.seed ? Number(body.seed) : Date.now();
    const built = escrow.build.createCommission(ctx(), {
      creator, seed, goalLamports, milestoneBasisPoints: milestones, deadlineUnix,
      workWindowSeconds, reviewWindowSeconds,
    });
    return {
      feePayer: creator,
      built,
      extra: {
        seed,
        commission: built.commission.toBase58(),
        vault: built.vault.toBase58(),
        deadlineUnix,
        workWindowSeconds: workWindowSeconds || escrow.DEFAULT_WORK_WINDOW_SECONDS,
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
  // OPTIONAL, and not the normal path: narrow a commission to one agent. Pass
  // the creator's own address to clear it and reopen the board.
  'invite-agent': async body => {
    const creator = cleanWallet(body.creator), commission = cleanWallet(body.commission), agent = cleanWallet(body.agent);
    return { feePayer: creator, built: escrow.build.inviteAgent(ctx(), { creator, commission, agent }) };
  },
  // Non-binding. Reserves nothing, blocks nobody, confers no priority.
  'signal-intent': async body => {
    const agent = cleanWallet(body.agent), commission = cleanWallet(body.commission);
    return { feePayer: agent, built: escrow.build.signalIntent(ctx(), { agent, commission }) };
  },
  'withdraw-intent': async body => {
    const agent = cleanWallet(body.agent), commission = cleanWallet(body.commission);
    return { feePayer: agent, built: escrow.build.withdrawIntent(ctx(), { agent, commission }) };
  },
  'close-submission': async body => {
    const agent = cleanWallet(body.agent), commission = cleanWallet(body.commission);
    const milestoneIndex = Number(body.milestoneIndex ?? 0);
    const built = escrow.build.closeSubmission(ctx(), { agent, commission, milestoneIndex });
    return { feePayer: agent, built, extra: { reclaimsLamports: escrow.SUBMISSION_RENT_LAMPORTS } };
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

// ── identity ────────────────────────────────────────────────────────────
//
// A wallet is the identity of record and a handle is only ever a label on it.
// Nothing here is accepted where an address is expected, and every view that
// shows a handle shows the address with it, so a name can never be the thing
// somebody pays.

/// Names that would let a stranger borrow authority they do not have.
const RESERVED_HANDLES = new Set([
  'gitstarter', 'admin', 'administrator', 'official', 'support', 'help', 'staff',
  'team', 'moderator', 'mod', 'system', 'root', 'security', 'treasury', 'escrow',
  'agnt', 'solana', 'api', 'www', 'null', 'undefined', 'anonymous', 'me', 'you',
]);

function cleanHandle(value) {
  const handle = cleanText(value, 32);
  // Deliberately narrow: no spaces, no punctuation, no mixed scripts. A name
  // that can contain a Cyrillic "a" is a name that can impersonate.
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{1,30}[a-zA-Z0-9])$/.test(handle)) {
    throw badRequest('A handle is 3 to 32 characters, letters, numbers and hyphens, starting and ending with a letter or number');
  }
  const key = handle.toLowerCase();
  if (RESERVED_HANDLES.has(key)) throw badRequest('That handle is reserved');
  // A name that looks like an address is a name designed to be mistaken for one.
  if (/^[1-9A-HJ-NP-Za-km-z]{32,}$/.test(handle)) throw badRequest('A handle may not look like a wallet address');
  return { handle, key };
}

/// The wallet behind a handle, or the address itself if that is what was given.
function resolveIdentity(id) {
  const row = db.prepare('SELECT wallet FROM handles WHERE handle_key = ?').get(String(id || '').replace(/^@/, '').toLowerCase());
  if (row) return row.wallet;
  return cleanWallet(id);
}

/// Handles for a set of wallets, so a list can show names without N queries.
function handlesFor(wallets) {
  const unique = [...new Set(wallets.filter(Boolean))];
  if (!unique.length) return {};
  const rows = db.prepare(`SELECT wallet, handle FROM handles WHERE wallet IN (${unique.map(() => '?').join(',')})`).all(...unique);
  return Object.fromEntries(rows.map(row => [row.wallet, row.handle]));
}

/// Claim or update the name on the signed-in wallet.
app.post('/api/v1/handle', requireAuth, async (req, res, next) => {
  try {
    const { handle, key } = cleanHandle(req.body.handle);
    const bio = req.body.bio == null ? '' : cleanText(req.body.bio, 280);
    const link = req.body.link ? cleanHttpUrl(req.body.link) : '';

    // The chain decides who holds a name; this only records what it says.
    //
    // The claim itself is a PDA derived from the name, so uniqueness is address
    // derivation rather than a constraint in this table — two wallets can no
    // more share a name than they can share an account. Read directly rather
    // than from the few-second cache, because a wallet posts here immediately
    // after claiming and a stale read would reject the claim that just landed.
    const claimPda = escrow.handlePda(PROGRAM_ID, key).toBase58();
    const account = (await rpc('getAccountInfo', [claimPda, { commitment: 'confirmed', encoding: 'base64' }]))?.value;
    if (!account) {
      return res.status(409).json({
        error: 'That name has not been claimed on chain yet. Send the ClaimHandle transaction first — '
          + 'the claim is what makes the name yours, and this only records the bio beside it.',
        claimAccount: claimPda,
      });
    }
    let onChain;
    try { onChain = escrow.decodeHandleClaim(Buffer.from(account.data[0], 'base64')); }
    catch { return res.status(409).json({ error: 'That address is not a name claim' }); }
    if (onChain.wallet !== req.wallet) {
      return res.status(409).json({ error: 'That name belongs to another wallet' });
    }

    const now = Date.now();
    db.transaction(() => {
      db.prepare('INSERT INTO handle_claims(handle_key,wallet,claimed_at) VALUES(?,?,?) ON CONFLICT(handle_key) DO NOTHING')
        .run(key, req.wallet, onChain.claimedAt * 1000);
      db.prepare(`INSERT INTO handles(wallet,handle,handle_key,bio,link,created_at,updated_at)
        VALUES(@wallet,@handle,@key,@bio,@link,@now,@now)
        ON CONFLICT(wallet) DO UPDATE SET
          handle=excluded.handle, handle_key=excluded.handle_key,
          bio=excluded.bio, link=excluded.link, updated_at=excluded.updated_at`)
        .run({ wallet: req.wallet, handle, key, bio, link, now });
    })();
    res.json({ wallet: req.wallet, handle, bio, link });
  } catch (error) { next(error); }
});

// ── what happened while you were away ─────────────────────────────────

/// Everything this wallet has been told, newest first.
app.get('/api/v1/notifications', requireAuth, (req, res, next) => {
  try {
    const rows = db.prepare('SELECT * FROM notifications WHERE wallet = ? ORDER BY id DESC LIMIT 100').all(req.wallet);
    const titles = db.prepare('SELECT address, title FROM commissions').all();
    const byAddress = new Map(titles.map(row => [row.address, row.title]));
    res.json({
      unread: rows.filter(row => !row.read_at).length,
      notifications: rows.map(row => ({
        id: row.id,
        kind: row.kind,
        commission: row.commission,
        title: byAddress.get(row.commission) || null,
        milestoneIndex: row.milestone_index,
        body: row.body,
        read: !!row.read_at,
        // Whether this one costs money if ignored. The point of an inbox is to
        // separate those from the rest, not to list everything equally.
        actionable: ['delivery-waiting', 'review-lapsed', 'claimable', 'dispute-opened'].includes(row.kind),
        createdAt: new Date(row.created_at).toISOString(),
      })),
    });
  } catch (error) { next(error); }
});

app.post('/api/v1/notifications/read', requireAuth, (req, res, next) => {
  try {
    db.prepare('UPDATE notifications SET read_at = ? WHERE wallet = ? AND read_at IS NULL')
      .run(Date.now(), req.wallet);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ── contesting a refusal ──────────────────────────────────────────────
//
// A rejection on chain is final and one-sided, and it should be: escrow that a
// stranger can freeze by objecting is escrow no creator would ever fund.
//
// So this does not touch the money. It makes the refusal ANSWERABLE. The
// agent's objection is attached to the creator's public record, where the next
// agent deciding whether to spend compute on their bounty will read it, and the
// creator's reply — or their silence — sits next to it.

/// Contest a rejection. Only the agent who was refused, and only if they were.
app.post('/api/v1/disputes', requireAuth, async (req, res, next) => {
  try {
    const commission = cleanWallet(req.body.commission);
    const milestoneIndex = Number(req.body.milestoneIndex);
    const reason = cleanText(req.body.reason, 2000);
    if (!reason) return res.status(400).json({ error: 'Say what you disagree with' });
    if (!Number.isInteger(milestoneIndex) || milestoneIndex < 0 || milestoneIndex >= escrow.MAX_MILESTONES) {
      return res.status(400).json({ error: 'milestoneIndex out of range' });
    }

    const chain = await chainCommissions();
    const c = chain.get(commission);
    if (!c) return res.status(404).json({ error: 'Unknown commission' });

    // The claim has to be true. A dispute is only meaningful because it can only
    // be filed by somebody the chain agrees was actually refused.
    const row = db.prepare('SELECT * FROM delivery_history WHERE commission = ? AND milestone_index = ? AND agent = ?')
      .get(commission, milestoneIndex, req.wallet);
    if (!row) return res.status(404).json({ error: 'No delivery of yours on that milestone' });
    const live = submissionsFor(commission).find(s => s.agent === req.wallet && s.milestoneIndex === milestoneIndex);
    const state = live ? live.state : settledState(c, milestoneIndex, row.sequence, row.last_state);
    if (state !== 'rejected') {
      return res.status(409).json({ error: 'That delivery was not refused, so there is nothing to contest' });
    }

    const now = Date.now();
    db.prepare(`INSERT INTO disputes (commission, milestone_index, agent, creator, reason, created_at)
      VALUES (@commission, @milestoneIndex, @agent, @creator, @reason, @now)
      ON CONFLICT(commission, milestone_index, agent) DO UPDATE SET reason = excluded.reason`)
      .run({ commission, milestoneIndex, agent: req.wallet, creator: c.creator, reason, now });

    rememberNotification.run({
      wallet: c.creator, kind: 'dispute-opened', commission, milestoneIndex,
      body: `Your refusal on milestone ${milestoneIndex + 1} was contested. Your answer, or your silence, is shown on your profile.`,
      dedupeKey: `dispute:${commission}:${milestoneIndex}:${req.wallet}`, now,
    });
    res.status(201).json({ ok: true });
  } catch (error) { next(error); }
});

/// The creator's answer. Only the creator, and only once there is a dispute.
app.post('/api/v1/disputes/respond', requireAuth, (req, res, next) => {
  try {
    const commission = cleanWallet(req.body.commission);
    const milestoneIndex = Number(req.body.milestoneIndex);
    const agent = cleanWallet(req.body.agent);
    const response = cleanText(req.body.response, 2000);
    if (!response) return res.status(400).json({ error: 'Write your answer' });

    const dispute = db.prepare('SELECT * FROM disputes WHERE commission = ? AND milestone_index = ? AND agent = ?')
      .get(commission, milestoneIndex, agent);
    if (!dispute) return res.status(404).json({ error: 'No such dispute' });
    if (dispute.creator !== req.wallet) return res.status(403).json({ error: 'Only the creator can answer this' });

    const now = Date.now();
    db.prepare('UPDATE disputes SET response = ?, responded_at = ? WHERE commission = ? AND milestone_index = ? AND agent = ?')
      .run(response, now, commission, milestoneIndex, agent);
    rememberNotification.run({
      wallet: agent, kind: 'dispute-answered', commission, milestoneIndex,
      body: `The creator answered your objection on milestone ${milestoneIndex + 1}.`,
      dedupeKey: `disputed-answer:${commission}:${milestoneIndex}:${agent}:${now}`, now,
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ── finding somebody ─────────────────────────────────────────────────

/// Everyone who has ever delivered, with the record they built doing it.
///
/// A board with no directory is a board where you can look somebody up but
/// never find them, so the only agents who get work are the ones who happened to
/// be seen. Ranked by what they earned, because that is the number neither side
/// can inflate on their own: it took a creator's escrow and a creator's release.
app.get('/api/v1/agents', async (req, res, next) => {
  try {
    if (!rateLimit(`agents:${req.ip}`, 60, 60_000)) return res.status(429).json({ error: 'Rate limit exceeded' });
    const chain = await chainCommissions();
    const search = String(req.query.q || '').trim().toLowerCase().slice(0, 32);

    const byAgent = new Map();
    for (const row of db.prepare('SELECT * FROM delivery_history').all()) {
      const c = chain.get(row.commission);
      if (!c) continue;
      const live = submissionsFor(row.commission)
        .find(s => s.agent === row.agent && s.milestoneIndex === row.milestone_index);
      const state = live ? live.state : settledState(c, row.milestone_index, row.sequence, row.last_state);
      if (!byAgent.has(row.agent)) {
        byAgent.set(row.agent, {
          wallet: row.agent, delivered: 0, won: 0, rejected: 0, pending: 0,
          solEarned: 0, creators: new Set(), lastSeen: 0,
        });
      }
      const agent = byAgent.get(row.agent);
      agent.delivered++;
      agent.creators.add(c.creator);
      agent.lastSeen = Math.max(agent.lastSeen, row.submitted_at);
      if (state === 'released') { agent.won++; agent.solEarned += toSol(milestonePayout(c, row.milestone_index)); }
      else if (state === 'rejected') agent.rejected++;
      else if (state === 'pending') agent.pending++;
    }

    const handles = handlesFor([...byAgent.keys()]);
    const bios = new Map(db.prepare('SELECT wallet, bio FROM handles').all().map(row => [row.wallet, row.bio]));
    let agents = [...byAgent.values()].map(agent => ({
      wallet: agent.wallet,
      handle: handles[agent.wallet] || null,
      bio: bios.get(agent.wallet) || '',
      delivered: agent.delivered,
      won: agent.won,
      rejected: agent.rejected,
      pending: agent.pending,
      distinctCreators: agent.creators.size,
      solEarned: Number(agent.solEarned.toFixed(9)),
      // Judged work only, so an agent is not marked down for having submitted
      // something nobody has looked at yet.
      winRate: (agent.won + agent.rejected) ? agent.won / (agent.won + agent.rejected) : null,
      lastDeliveredAt: new Date(agent.lastSeen * 1000).toISOString(),
    }));

    if (search) {
      agents = agents.filter(agent =>
        (agent.handle || '').toLowerCase().includes(search)
        || agent.wallet.toLowerCase().startsWith(search)
        || agent.bio.toLowerCase().includes(search));
    }
    agents.sort((a, b) => b.solEarned - a.solEarned || b.won - a.won);

    res.json({
      agents: agents.slice(0, 100),
      // Stated so a thin directory is not mistaken for a thorough one.
      caveats: [
        'Ranked by SOL earned, which requires a creator to have escrowed and released it.',
        'A wallet with few distinct counterparties can manufacture its own record cheaply. Check distinctCreators.',
        'Absent history is not a negative signal. A new address has no record, not a bad one.',
      ],
    });
  } catch (error) { next(error); }
});

/// A public profile, by handle or by address.
///
/// Everything here is either signed by the wallet itself or derived from chain
/// state anyone can recompute. There is no self-reported achievement in it,
/// which is the only reason a stranger should believe any of it.
app.get('/api/v1/profile/:handleOrWallet', async (req, res, next) => {
  try {
    let wallet;
    try { wallet = resolveIdentity(req.params.handleOrWallet); }
    catch { return res.status(404).json({ error: 'No such handle or wallet' }); }
    if (!rateLimit(`profile:${req.ip}`, 60, 60_000)) return res.status(429).json({ error: 'Rate limit exceeded' });

    const chain = await chainCommissions();
    const nowUnix = Math.floor(Date.now() / 1000);
    const identity = db.prepare('SELECT * FROM handles WHERE wallet = ?').get(wallet);
    const meta = new Map(db.prepare('SELECT * FROM commissions').all().map(row => [row.address, row]));

    // Work this wallet delivered, kept after settlement swept the accounts.
    const delivered = [];
    for (const row of db.prepare('SELECT * FROM delivery_history WHERE agent = ? ORDER BY submitted_at DESC LIMIT 50').all(wallet)) {
      const c = chain.get(row.commission);
      if (!c) continue;
      const live = submissionsFor(row.commission)
        .find(s => s.agent === wallet && s.milestoneIndex === row.milestone_index);
      delivered.push({
        commission: row.commission,
        title: meta.get(row.commission)?.title || null,
        milestoneNumber: row.milestone_index + 1,
        state: live ? live.state : settledState(c, row.milestone_index, row.sequence, row.last_state),
        payoutSol: toSol(milestonePayout(c, row.milestone_index)),
        submittedAt: new Date(row.submitted_at * 1000).toISOString(),
      });
    }

    const posted = [...chain.entries()]
      .filter(([, c]) => c.creator === wallet)
      .map(([address, c]) => ({
        commission: address,
        title: meta.get(address)?.title || null,
        status: c.status,
        pledgedSol: toSol(c.pledged),
        releasedSol: toSol(c.released),
        deliveries: c.submissions,
        rejections: c.rejections,
        openForWork: c.status === 'funded' && !escrow.workClosed(c, nowUnix),
      }));

    res.json({
      wallet,
      handle: identity?.handle || null,
      bio: identity?.bio || '',
      link: identity?.link || '',
      namedSince: identity ? new Date(identity.created_at).toISOString() : null,
      explorer: explorerUrl(wallet),
      // Stated plainly so nobody reads a name as an endorsement: it is a label
      // the wallet set on itself, not something this service verified.
      handleIsSelfDeclared: true,
      delivered,
      posted,
      // Refusals this wallet handed out that the agent disagreed with, and
      // whether they answered. On a board between strangers, a creator who
      // takes delivery and refuses should carry that where it is read.
      disputesAgainstThem: db.prepare('SELECT * FROM disputes WHERE creator = ? ORDER BY created_at DESC LIMIT 20')
        .all(wallet).map(row => ({
          commission: row.commission,
          title: meta.get(row.commission)?.title || null,
          milestoneNumber: row.milestone_index + 1,
          agent: row.agent,
          reason: row.reason,
          response: row.response || null,
          answered: !!row.responded_at,
          createdAt: new Date(row.created_at).toISOString(),
        })),
      disputesTheyRaised: db.prepare('SELECT * FROM disputes WHERE agent = ? ORDER BY created_at DESC LIMIT 20')
        .all(wallet).map(row => ({
          commission: row.commission,
          title: meta.get(row.commission)?.title || null,
          milestoneNumber: row.milestone_index + 1,
          reason: row.reason,
          response: row.response || null,
          answered: !!row.responded_at,
          createdAt: new Date(row.created_at).toISOString(),
        })),
      firstSeen: [
        ...delivered.map(d => d.submittedAt),
        ...posted.map(p => meta.get(p.commission)?.created_at).filter(Boolean).map(ms => new Date(ms).toISOString()),
      ].sort()[0] || null,
    });
  } catch (error) { next(error); }
});

/// Everything one wallet is involved in, on both sides, past and present.
///
/// The board answers "what work exists". This answers "what am I part of",
/// which is a different question and the one a person actually opens the site
/// with: what did I post, what did I say I would do, what did I win.
///
/// It has to include work whose accounts are gone. Settling a commission sweeps
/// its submissions and intents so the deposits come home unasked, so anything
/// derived only from live accounts would show a wallet's history emptying out
/// exactly as they finish things. The durable index carries it instead, and the
/// outcome is reconciled against the commission's own surviving counters.
app.get('/api/v1/activity/:wallet', async (req, res, next) => {
  try {
    let wallet;
    try { wallet = cleanWallet(req.params.wallet); } catch { return res.status(400).json({ error: 'Invalid wallet' }); }
    if (!rateLimit(`activity:${req.ip}`, 60, 60_000)) return res.status(429).json({ error: 'Rate limit exceeded' });

    const chain = await chainCommissions();
    const nowUnix = Math.floor(Date.now() / 1000);
    const meta = new Map(db.prepare('SELECT * FROM commissions').all().map(row => [row.address, row]));

    /// A commission as it appears in a list of things I am part of: enough to
    /// decide whether to open it, and nothing more.
    const summarise = (address, c) => ({
      address,
      title: meta.get(address)?.title || null,
      status: c.status,
      pledgedSol: toSol(c.pledged),
      releasedSol: toSol(c.released),
      escrowRemainingSol: toSol(escrow.escrowRemaining(c)),
      milestones: c.milestoneCount,
      milestonesReleased: c.milestoneBps.reduce((n, _, i) => n + ((c.milestonesDone & (1 << i)) ? 1 : 0), 0),
      openForWork: c.status === 'funded' && !escrow.workClosed(c, nowUnix),
      workDeadline: c.workDeadline ? new Date(c.workDeadline * 1000).toISOString() : null,
      competition: { deliveries: c.submissions, waiting: c.unresolvedSubmissions, agentsSignalled: c.intents },
      attention: escrow.pendingAttention(c, wallet, { nowUnix, submissions: submissionsFor(address) }),
    });

    // ── what I posted ──────────────────────────────────────────────────────
    const posted = [];
    for (const [address, c] of chain) {
      if (c.creator !== wallet) continue;
      posted.push({ ...summarise(address, c), rejections: c.rejections, autoReleases: c.autoReleases });
    }

    // ── what I delivered, including deliveries the sweep has since closed ──
    const deliveries = [];
    for (const row of db.prepare('SELECT * FROM delivery_history WHERE agent = ? ORDER BY submitted_at DESC').all(wallet)) {
      const c = chain.get(row.commission);
      if (!c) continue; // a commission from a layout this build cannot read
      const live = submissionsFor(row.commission)
        .find(s => s.agent === wallet && s.milestoneIndex === row.milestone_index);
      const state = live ? live.state : settledState(c, row.milestone_index, row.sequence, row.last_state);
      deliveries.push({
        ...summarise(row.commission, c),
        milestoneIndex: row.milestone_index,
        milestoneNumber: row.milestone_index + 1,
        queuePosition: Math.max(0, row.sequence - (c.milestoneRejected[row.milestone_index] ?? 0)),
        state,
        // What this delivery is worth, or was worth. An agent deciding whether
        // to keep competing needs the number either way.
        payoutSol: toSol(milestonePayout(c, row.milestone_index)),
        submittedAt: new Date(row.submitted_at * 1000).toISOString(),
        evidence: deliveriesFor(row.commission).find(d => d.evidenceHash === row.evidence_hash)?.evidence ?? null,
      });
    }

    // ── what I said I would work on ────────────────────────────────────────
    //
    // Signalling binds nothing, so the only thing that makes it mean anything is
    // that not following through is visible. That distinction is the whole
    // point, so it is reported rather than flattened into one list.
    const signalled = [];
    for (const row of db.prepare('SELECT * FROM intent_history WHERE agent = ? ORDER BY signalled_at DESC').all(wallet)) {
      const c = chain.get(row.commission);
      if (!c) continue;
      const delivered = deliveries.some(d => d.address === row.commission);
      const over = ['shipped', 'refunded'].includes(c.status) || escrow.workClosed(c, nowUnix);
      signalled.push({
        ...summarise(row.commission, c),
        signalledAt: new Date(row.signalled_at * 1000).toISOString(),
        // honoured: I delivered. withdrawn: I stood down on the record.
        // abandoned: I went quiet and the window closed. working: still open.
        outcome: delivered ? 'honoured' : row.withdrawn ? 'withdrawn' : over ? 'abandoned' : 'working',
      });
    }

    const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
    const won = deliveries.filter(d => d.state === 'released');
    const finishedPosted = posted.filter(p => ['shipped', 'refunded'].includes(p.status));

    res.json({
      wallet,
      cluster: CLUSTER,
      computedAt: new Date().toISOString(),
      // Anything with a clock or money riding on it, either side, first.
      needsYou: [...posted, ...deliveries]
        .filter(item => item.attention && item.attention.urgency === 'act')
        // One entry per commission: several deliveries on one job is still one
        // thing to go and look at.
        .filter((item, index, list) => list.findIndex(other => other.address === item.address) === index),
      posted: {
        open: posted.filter(p => !['shipped', 'refunded'].includes(p.status)),
        finished: finishedPosted,
      },
      deliveries: {
        inPlay: deliveries.filter(d => d.state === 'pending'),
        won,
        // Delivered and not paid. Kept apart from won, and NOT called failed:
        // on an open board being beaten to a milestone is the ordinary cost of
        // competing, and it is not the same thing as being refused.
        lost: deliveries.filter(d => ['rejected', 'superseded'].includes(d.state)),
      },
      signalled: {
        working: signalled.filter(s => s.outcome === 'working'),
        settled: signalled.filter(s => s.outcome !== 'working'),
      },
      handles: handlesFor([wallet]),
      totals: {
        postedCount: posted.length,
        postedOpen: posted.length - finishedPosted.length,
        solPaidOut: sum(posted, p => p.releasedSol),
        solInEscrow: sum(posted, p => p.escrowRemainingSol),
        deliveriesMade: deliveries.length,
        deliveriesWon: won.length,
        solEarned: sum(won, d => d.payoutSol),
        // Judged deliveries only. Counting work still in the queue as a loss
        // would punish an agent for having submitted recently.
        winRate: (() => {
          const judged = deliveries.filter(d => d.state !== 'pending').length;
          return judged ? won.length / judged : null;
        })(),
      },
    });
  } catch (error) { next(error); }
});

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

    const commissions = [...chain.entries()];
    const asCreator = commissions.filter(([, c]) => c.creator === wallet).map(([, c]) => c);

    // An agent no longer "holds" a commission, so their record is derived from
    // the deliveries they actually made. That is a better measure anyway: it
    // counts work, not appointments.
    //
    // It has to come from the durable index rather than from live accounts,
    // because settling a commission closes them. Reading only what is still on
    // chain meant a wallet that had just won three jobs and been paid reported
    // zero deliveries and zero earnings — the record was erased at the exact
    // moment it was worth something.
    const mine = [];
    for (const row of db.prepare('SELECT * FROM delivery_history WHERE agent = ?').all(wallet)) {
      const c = chain.get(row.commission);
      if (!c) continue; // a commission from a layout this build cannot read
      const live = submissionsFor(row.commission).find(s => s.agent === wallet && s.milestoneIndex === row.milestone_index);
      mine.push({
        commission: c,
        address: row.commission,
        milestoneIndex: row.milestone_index,
        // A live account is the most current truth. Once it is gone, the
        // outcome is still exactly determined by the commission's own
        // counters: the queue is judged in order, so a delivery at position
        // `sequence` was rejected if the milestone has rejected more than that,
        // won if it is the one at the front of a released milestone, and simply
        // never judged if somebody ahead of it won.
        state: live ? live.state : settledState(c, row.milestone_index, row.sequence, row.last_state),
      });
    }
    // Intents are swept on settlement too, so the same reasoning applies.
    const myIntents = db.prepare('SELECT * FROM intent_history WHERE agent = ?').all(wallet)
      .filter(row => chain.has(row.commission))
      .map(row => ({ commission: row.commission, withdrawn: !!row.withdrawn }));

    const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
    const ratio = (numerator, denominator) => (denominator ? numerator / denominator : null);
    const releasedMilestones = c => {
      let n = 0;
      for (let i = 0; i < c.milestoneCount; i++) if (c.milestonesDone & (1 << i)) n++;
      return n;
    };

    // Distinct counterparties, because a wallet that only ever trades with
    // itself has volume but no reputation. Showing this makes the cheapest
    // sybil pattern visible instead of flattering.
    const creatorCounterparties = new Set();
    for (const [address, c] of commissions) {
      if (c.creator !== wallet) continue;
      for (const s of submissionsFor(address)) creatorCounterparties.add(s.agent);
    }
    const agentCounterparties = new Set(mine.map(m => m.commission.creator));

    const creatorRejections = sum(asCreator, c => c.rejections);
    const creatorAutoReleases = sum(asCreator, c => c.autoReleases);
    const creatorSubmissions = sum(asCreator, c => c.submissions);
    const deliveriesResolved = creatorRejections + creatorAutoReleases;

    // The signal Nathan asked for: an agent who said they were working on
    // something and then never delivered. The protocol enforces nothing here —
    // signalling is free and non-binding — so the whole cost of saying it and
    // not doing it lands right here, in a number anyone can read.
    const honoured = myIntents.filter(i =>
      mine.some(m => m.address === i.commission)).length;
    const withdrawn = myIntents.filter(i => i.withdrawn).length;
    const abandoned = myIntents.filter(i => {
      if (i.withdrawn) return false;
      if (mine.some(m => m.address === i.commission)) return false;
      const c = chain.get(i.commission);
      // Only counts once they have actually run out of time to do it.
      return c && escrow.workClosed(c, now);
    }).length;

    const released = mine.filter(m => m.state === 'released');
    const rejected = mine.filter(m => m.state === 'rejected');
    // Delivered, never judged, because somebody ahead in the queue won. Not a
    // failure and not a rejection, so it is reported as neither.
    const superseded = mine.filter(m => m.state === 'superseded');

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
        // The number an agent checks before spending compute: does this creator
        // pay for work, or reject it and keep shopping?
        rejectionRate: ratio(creatorRejections, creatorSubmissions),
        // Times a milestone had to be released by someone else because this
        // creator went silent on delivered work. Low is good; zero is normal.
        autoReleases: creatorAutoReleases,
        paidOnDelivery: ratio(creatorAutoReleases === 0 ? deliveriesResolved : deliveriesResolved - creatorAutoReleases, deliveriesResolved),
        openCommissions: asCreator.filter(c => ['funding', 'funded'].includes(c.status)).length,
      },
      agent: {
        deliveries: mine.length,
        won: released.length,
        rejected: rejected.length,
        // Delivered in good faith but never judged, because an earlier delivery
        // won the milestone. On an open board this is the normal cost of
        // competing and must not read as a failure.
        superseded: superseded.length,
        pending: mine.filter(m => m.state === 'pending').length,
        distinctCreators: agentCounterparties.size,
        // Competing and losing is not a black mark; it is the cost of entry on
        // an open board, and it is reported as a rate rather than a failure.
        winRate: ratio(released.length, released.length + rejected.length),
        solEarned: sum(released, m => milestonePayout(m.commission, m.milestoneIndex)) / escrow.LAMPORTS_PER_SOL,
        // Intent is non-binding, so this is the only thing that makes it worth
        // anything at all.
        declaredIntent: myIntents.length,
        intentHonoured: honoured,
        intentWithdrawn: withdrawn,
        intentAbandoned: abandoned,
        reliability: ratio(honoured, honoured + abandoned),
      },
      caveats: [
        'Derived from on-chain state only; recompute it yourself from /api/v1/commissions.',
        'A wallet with few distinct counterparties can manufacture its own record cheaply.',
        'Absent history is not a negative signal. A new address has no record, not a bad one.',
        'Losing a race is not a failure. Compare winRate against how much competition the agent entered.',
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
    treasury: TREASURY_WALLET, rpcUrl: PUBLIC_RPC_URL, signInDomain: SIGN_IN_DOMAIN,
  }));
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
// The HTML declares the icon at /favicon.svg, so every actual browser follows
// that link. But tools, previewers and scrapers still probe /favicon.ico
// blindly; without this they would hit the SPA fallback below and be handed
// 46 KB of HTML labelled as text/html, which some of them try to parse as an
// image and quietly cache as broken.
app.get('/favicon.ico', (_req, res) => res.type('image/svg+xml')
  .sendFile(path.join(PUBLIC_DIR, 'favicon.svg')));
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

'use strict';
// The wire format of the GitStarter escrow program, in one place.
//
// The browser and the server both build transactions, and an autonomous agent
// may build its own from the documentation in /llms.txt. If those three ever
// disagreed about a byte, a wallet would sign something other than what it was
// shown. So the encoding lives here and nowhere else.
//
// Everything in this file is derived from program/src/lib.rs. Changing one
// without the other is a bug.

const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;

// @solana/web3.js is loaded only when a transaction is actually being built.
//
// Reading commissions needs nothing but base58 and buffer offsets, and the read
// path is what agents depend on most. Requiring a large wallet library at module
// load would tie discovery to that library's dependency tree - which has already
// bitten us once: a nested ESM-only `uuid` makes web3.js unloadable under
// Node 18, and it would have taken /llms.txt and the whole read API down with
// it. Now that failure can only affect transaction construction, which callers
// can do themselves from the encoding documented in llms.txt.
let web3;
function w3() {
  if (!web3) web3 = require('@solana/web3.js');
  return web3;
}
/// Whether this process can build transactions locally.
function canBuildTransactions() {
  try { w3(); return true; } catch { return false; }
}

const LAMPORTS_PER_SOL = 1_000_000_000;
const BPS_DENOMINATOR = 10_000;
const FEE_BASIS_POINTS = 100;
const MAX_MILESTONES = 8;

// Clocks. Funding, delivery and review are separate phases, each bounded, each
// expiring to the outcome that is fair at that point. Review is the one that
// expires to *payment* rather than refund.
const MAX_FUNDING_DURATION_SECONDS = 30 * 86_400;
/// Ceiling on deliveries per milestone. Generous on purpose — competition is
/// the point; this only bounds a counter and a creator’s worst-case queue.
const MAX_SUBMISSIONS_PER_MILESTONE = 32;
const MIN_WORK_WINDOW_SECONDS = 3_600;
const MAX_WORK_WINDOW_SECONDS = 30 * 86_400;
const DEFAULT_WORK_WINDOW_SECONDS = 3 * 86_400;
const MIN_REVIEW_WINDOW_SECONDS = 3_600;
const MAX_REVIEW_WINDOW_SECONDS = 14 * 86_400;
const DEFAULT_REVIEW_WINDOW_SECONDS = 2 * 86_400;
const NOMINATION_WINDOW_SECONDS = 3 * 86_400;

/// How long a matured, unclaimed delivery is protected from being refunded away.
/// A claim that matures after the delivery deadline would otherwise be a race
/// between the agent who delivered and the first backer to hit refund.
const CLAIM_GRACE_WINDOW_SECONDS = 86_400;

// Pinned by program/src/lib.rs::commission_account_size_is_pinned. If these two
// ever disagree, every commission silently fails to decode.
const COMMISSION_ACCOUNT_BYTES = 275;
const SUBMISSION_ACCOUNT_BYTES = 109;
const PLEDGE_ACCOUNT_BYTES = 83;
const CONFIG_ACCOUNT_BYTES = 67;
/// Mirrors MAX_COMMISSION_LAMPORTS in the program. Kept here so the browser can
/// say no before asking somebody to sign a transaction that the chain would
/// reject anyway — the program is still the thing that enforces it.
const MAX_COMMISSION_LAMPORTS = 5 * 1_000_000_000;
const HANDLE_ACCOUNT_BYTES = 75;
const SEED_HANDLE = Buffer.from('handle');
const MAX_HANDLE_LEN = 32;
const MIN_HANDLE_LEN = 3;
const INTENT_ACCOUNT_BYTES = 75;
// Rent-exemption minimums. Solana charges for 128 bytes of account overhead plus
// the account's own data, at 6960 lamports per byte. These are locked up for as
// long as the account exists, which on a small bounty is a real percentage of
// the commission — so accounts that can never be used again give theirs back.

/// Rent reserve of the 0-byte vault PDA. It is not escrow and is never payable
/// to an agent; it returns to the creator once the escrow is empty.
const VAULT_RENT_LAMPORTS = 890_880;
/// Rent held by an 83-byte pledge account, returned to its backer on refund or
/// once a shipped commission has paid out.
const PLEDGE_RENT_LAMPORTS = (128 + 83) * 6_960;
/// Rent held by the 316-byte commission account. This one is NOT reclaimable and
/// is not meant to be: the account is the permanent public record that
/// reputation is computed from, and leaving it in place is also what stops its
/// seed being reused while stale pledge accounts could still exist.
const COMMISSION_RENT_LAMPORTS = (128 + COMMISSION_ACCOUNT_BYTES) * 6_960;
/// Rent an agent puts up to deliver, returned in full when their submission
/// settles. Losing a race has to be cheap or nobody competes.
const SUBMISSION_RENT_LAMPORTS = (128 + SUBMISSION_ACCOUNT_BYTES) * 6_960;
const INTENT_RENT_LAMPORTS = (128 + INTENT_ACCOUNT_BYTES) * 6_960;

const SEED_COMMISSION = Buffer.from('commission');
const SEED_VAULT = Buffer.from('vault');
const SEED_PLEDGE = Buffer.from('pledge');
const SEED_SUBMISSION = Buffer.from('submission');
const SEED_INTENT = Buffer.from('intent');

/// Borsh enum discriminants, in declaration order.
const IX = {
  initConfig: 0,
  createCommission: 1,
  pledge: 2,
  inviteAgent: 3,
  releaseMilestone: 4,
  refund: 5,
  cancel: 6,
  setPaused: 7,
  signalIntent: 8,
  withdrawIntent: 9,
  submitDelivery: 10,
  rejectDelivery: 11,
  closePledge: 12,
  closeVault: 13,
  closeSubmission: 14,
  closeIntent: 15,
  claimHandle: 16,
};

// There is deliberately no "assigned" state between funded and shipped: funded
// means the work is on the board and anyone may start.
const STATUS = ['funding', 'funded', 'shipped', 'refunded'];
const SUBMISSION_STATE = ['pending', 'released', 'rejected'];

/// EscrowError discriminants, so a rejected transaction can be explained rather
/// than surfaced as "custom program error: 0x18".
/// EscrowError discriminants, transcribed from program/src/lib.rs.
///
/// `impl From<EscrowError> for ProgramError` is `Custom(e as u32)` — no offset —
/// so these numbers are exactly the enum's. This map was previously partial and
/// had code 1 labelled `AlreadyInitialized` when 1 is `NotInitialized`, which
/// meant a real failure could be reported to a user as the wrong cause. A test
/// now parses the Rust enum and asserts this table matches it entry for entry.
const ERRORS = {
  0: 'AlreadyInitialized',
  1: 'NotInitialized',
  2: 'Unauthorized',
  3: 'BadPda',
  4: 'BadOwner',
  5: 'BadMint',
  6: 'BadTokenProgram',
  7: 'BadStatus',
  8: 'MathOverflow',
  9: 'GoalNotMet',
  10: 'GoalAlreadyMet',
  11: 'MilestoneAlreadyReleased',
  12: 'BadMilestones',
  13: 'NothingToRefund',
  14: 'DeadlineNotPassed',
  15: 'Paused',
  16: 'AmountZero',
  17: 'AgentAlreadySet',
  18: 'AgentNotSet',
  19: 'BadAccountTag',
  20: 'InsufficientVault',
  21: 'BadTreasury',
  22: 'DeadlineInPast',
  23: 'DeadlinePassed',
  24: 'SelfDealing',
  25: 'DeadlineTooFar',
  26: 'GoalTooSmall',
  27: 'NoPendingAgent',
  28: 'NoSubmission',
  29: 'ReviewWindowOpen',
  30: 'BadWindow',
  31: 'SubmissionPending',
  32: 'NotSettled',
  33: 'OutOfTurn',
  34: 'NotInvited',
  35: 'TooManySubmissions',
  36: 'WorkWindowClosed',
  37: 'BadHandle',
  38: 'HandleTaken',
  39: 'CommissionTooLarge',
};

const ERROR_HELP = {
  CommissionTooLarge: 'One commission may hold at most 5 SOL while this escrow is new. The program '
    + 'has not been independently reviewed, so the cap is there to make the worst case a number '
    + 'chosen in advance rather than one somebody else chooses later. Split the work into '
    + 'separate commissions.',
  BadHandle: 'A name is 3 to 32 characters of lower-case letters, numbers and inner hyphens. '
    + 'Capitals are refused rather than corrected, because the name is its own address and '
    + '"Alice" would otherwise be a different name from "alice".',
  HandleTaken: 'Somebody already holds that name. Names are first-come and permanent, so that '
    + 'nobody can pick up a name you built a reputation under.',
  Unauthorized: 'That wallet is not the creator, agent, or backer this action requires.',
  BadStatus: 'The commission is not in a state where this action is allowed.',
  MilestoneAlreadyReleased: 'That milestone has already been paid.',
  NothingToRefund: 'This pledge has already been settled.',
  DeadlineNotPassed: 'Only the contracted agent may end a live build before the deadline.',
  Paused: 'New commissions and pledges are paused.',
  BadTreasury: 'The treasury account does not match the one recorded when the commission was created.',
  DeadlineInPast: 'Choose a deadline in the future.',
  DeadlinePassed: 'This commission has expired; it can only be refunded.',
  SelfDealing: 'A creator cannot nominate themselves as the paid agent.',
  DeadlineTooFar: `A funding deadline cannot exceed ${MAX_FUNDING_DURATION_SECONDS / 86_400} days.`,
  GoalTooSmall: `The goal must be at least ${BPS_DENOMINATOR} lamports.`,
  NoPendingAgent: 'There is no unaccepted nomination to withdraw.',
  BadMilestones: `Use 1 to ${MAX_MILESTONES} milestones, and make them sum to exactly 100%.`,
  GoalNotMet: 'This commission has not reached its funding goal yet.',
  GoalAlreadyMet: 'This commission is already fully funded.',
  AmountZero: 'Enter an amount greater than zero.',
  AgentAlreadySet: 'This commission already has an agent.',
  AgentNotSet: 'This commission does not have an agent yet.',
  InsufficientVault: 'The escrow does not hold enough to cover that.',
  MathOverflow: 'That value is out of range.',
  NoSubmission: 'There is no delivery awaiting review on this commission.',
  ReviewWindowOpen: 'The review window has not finished, so only the creator can act yet.',
  BadWindow: 'Delivery and review windows must be between one hour and their maximums.',
  SubmissionPending: 'A delivery is awaiting review. It must be released or rejected first.',
  NotSettled: 'This account is still in use. It is closed automatically once the commission has fully settled.',
  OutOfTurn: 'An earlier delivery on this milestone has not been judged yet. First delivered, first judged.',
  NotInvited: 'This commission was restricted to one invited agent.',
  TooManySubmissions: 'This milestone has taken as many deliveries as it will accept.',
  WorkWindowClosed: 'The window for working on this commission has closed.',
};

function u64(value) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; }
function i64(value) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); return b; }
function u16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; }

const key = value => {
  const { PublicKey } = w3();
  return value instanceof PublicKey ? value : new PublicKey(value);
};

function commissionPda(programId, creator, seed) {
  return w3().PublicKey.findProgramAddressSync(
    [SEED_COMMISSION, key(creator).toBuffer(), u64(seed)], key(programId))[0];
}
function vaultPda(programId, commission) {
  return w3().PublicKey.findProgramAddressSync(
    [SEED_VAULT, key(commission).toBuffer()], key(programId))[0];
}
/// One agent's delivery against one milestone. Keyed by all three so several
/// agents can compete on the same milestone without colliding.
function submissionPda(programId, commission, milestoneIndex, agent) {
  return w3().PublicKey.findProgramAddressSync(
    [SEED_SUBMISSION, key(commission).toBuffer(), Buffer.from([milestoneIndex]), key(agent).toBuffer()],
    key(programId))[0];
}

function intentPda(programId, commission, agent) {
  return w3().PublicKey.findProgramAddressSync(
    [SEED_INTENT, key(commission).toBuffer(), key(agent).toBuffer()], key(programId))[0];
}

/// The address of a name.
///
/// Derived from the name itself, which is what makes uniqueness free: two
/// wallets cannot hold the same handle for the same reason two accounts cannot
/// share an address. The handle must already be lower-cased — the program
/// refuses anything else rather than normalising it, because normalising would
/// mean "Alice" and "alice" derived different addresses and both could be held.
function handlePda(programId, handle) {
  return w3().PublicKey.findProgramAddressSync(
    [SEED_HANDLE, Buffer.from(String(handle).toLowerCase(), 'utf8')], key(programId))[0];
}

/// Decodes a HandleClaim account — one name, bound to one wallet, permanently.
function decodeHandleClaim(data) {
  const b = Buffer.from(data);
  if (b.length !== HANDLE_ACCOUNT_BYTES) throw new Error('Not a handle claim account');
  if (b[0] !== 6) throw new Error('Not a handle claim account');
  const wallet = bs58.encode(b.subarray(1, 33));
  const len = b[65];
  if (len < MIN_HANDLE_LEN || len > MAX_HANDLE_LEN) throw new Error('Not a handle claim account');
  return {
    wallet,
    handle: b.subarray(33, 33 + len).toString('utf8'),
    claimedAt: Number(b.readBigInt64LE(66)),
  };
}

function pledgePda(programId, commission, backer) {
  return w3().PublicKey.findProgramAddressSync(
    [SEED_PLEDGE, key(commission).toBuffer(), key(backer).toBuffer()], key(programId))[0];
}

/// Decodes a Commission account. Layout is pinned by lib.rs; see the size test.
function decodeCommission(data) {
  const b = Buffer.from(data);
  if (b.length !== COMMISSION_ACCOUNT_BYTES) throw new Error('Not a commission account');
  let o = 1;
  const pk = () => { const v = bs58.encode(b.subarray(o, o + 32)); o += 32; return v; };
  const num = () => { const v = Number(b.readBigUInt64LE(o)); o += 8; return v; };
  const i64 = () => { const v = Number(b.readBigInt64LE(o)); o += 8; return v; };
  const creator = pk();
  o += 32; // reserved, retained for layout compatibility
  const treasury = pk();
  const seed = num(), goal = num(), pledged = num(), released = num(), refunded = num();
  const pledgerCount = b.readUInt32LE(o); o += 4;
  const refundedPledgerCount = b.readUInt32LE(o); o += 4;
  const invitedAgent = pk();
  const hasInvite = !!b[o++];
  const status = STATUS[b[o++]] || 'unknown';
  const milestoneCount = b[o++];
  const milestoneBps = [];
  for (let i = 0; i < MAX_MILESTONES; i++) { milestoneBps.push(b.readUInt16LE(o)); o += 2; }
  const milestonesDone = b[o++];
  const deadline = i64();
  o += 2; // bump, vault_bump
  const workWindow = i64();
  const workDeadline = i64();
  const reviewWindow = i64();
  const milestoneSubmitted = [], milestoneRejected = [];
  for (let i = 0; i < MAX_MILESTONES; i++) milestoneSubmitted.push(b[o++]);
  for (let i = 0; i < MAX_MILESTONES; i++) milestoneRejected.push(b[o++]);
  const unresolvedSubmissions = b.readUInt32LE(o); o += 4;
  const latestSubmittedAt = i64();
  const submissions = b.readUInt32LE(o); o += 4;
  const rejections = b.readUInt32LE(o); o += 4;
  const autoReleases = b.readUInt32LE(o); o += 4;
  const intents = b.readUInt32LE(o); o += 4;

  return {
    creator, treasury, seed, goal, pledged, released, refunded,
    pledgerCount, refundedPledgerCount,
    // Open by default. An invitation is a deliberate narrowing, so it is
    // reported as absent rather than as a zeroed key.
    invitedAgent: hasInvite ? invitedAgent : null,
    isOpen: !hasInvite,
    status, milestoneCount,
    milestoneBps: milestoneBps.slice(0, milestoneCount),
    milestonesDone, deadline,
    workWindow, workDeadline, reviewWindow,
    // Per-milestone competition. `submitted - rejected` is how many deliveries
    // are still in the queue, and the one at the front has sequence `rejected`.
    milestoneSubmitted: milestoneSubmitted.slice(0, milestoneCount),
    milestoneRejected: milestoneRejected.slice(0, milestoneCount),
    unresolvedSubmissions, latestSubmittedAt,
    submissions, rejections, autoReleases, intents,
  };
}

/// Decodes a Submission account — one agent's delivery against one milestone.
function decodeSubmission(data) {
  const b = Buffer.from(data);
  if (b.length !== SUBMISSION_ACCOUNT_BYTES) throw new Error('Not a submission account');
  let o = 1;
  const pk = () => { const v = bs58.encode(b.subarray(o, o + 32)); o += 32; return v; };
  const commission = pk(), agent = pk();
  const milestoneIndex = b[o++];
  const sequence = b[o++];
  const submittedAt = Number(b.readBigInt64LE(o)); o += 8;
  const evidenceHash = Buffer.from(b.subarray(o, o + 32)).toString('hex'); o += 32;
  const state = SUBMISSION_STATE[b[o++]] || 'unknown';
  return { commission, agent, milestoneIndex, sequence, submittedAt, evidenceHash, state };
}

/// Decodes the singleton Config account.
///
/// Worth being able to read without trusting anyone's word for it: this is where
/// the two permanent roles live. `admin` is fixed to whoever called InitConfig
/// and can only pause; `treasury` is fixed at that same moment and receives
/// every fee. Neither can be changed afterwards — the program has no SetAdmin,
/// no SetTreasury and no SetFee — so this account is the whole of the protocol's
/// trusted configuration, and it is two public keys.
function decodeConfig(data) {
  const b = Buffer.from(data);
  if (b.length !== CONFIG_ACCOUNT_BYTES) throw new Error('Not a config account');
  if (b[0] !== 1) throw new Error('Not a config account');
  let o = 1;
  const pk = () => { const v = bs58.encode(b.subarray(o, o + 32)); o += 32; return v; };
  const admin = pk(), treasury = pk();
  return { admin, treasury, paused: !!b[o], bump: b[o + 1] };
}

/// Decodes a Pledge account — one backer's stake in one commission.
function decodePledge(data) {
  const b = Buffer.from(data);
  if (b.length !== PLEDGE_ACCOUNT_BYTES) throw new Error('Not a pledge account');
  let o = 1;
  const pk = () => { const v = bs58.encode(b.subarray(o, o + 32)); o += 32; return v; };
  const commission = pk(), backer = pk();
  const amount = Number(b.readBigUInt64LE(o)); o += 8;
  const refunded = Number(b.readBigUInt64LE(o)); o += 8;
  const fullyRefunded = !!b[o++];
  return { commission, backer, amount, refunded, fullyRefunded };
}

/// Decodes an Intent account — a non-binding "I am working on this".
function decodeIntent(data) {
  const b = Buffer.from(data);
  if (b.length !== INTENT_ACCOUNT_BYTES) throw new Error('Not an intent account');
  let o = 1;
  const pk = () => { const v = bs58.encode(b.subarray(o, o + 32)); o += 32; return v; };
  const commission = pk(), agent = pk();
  const signalledAt = Number(b.readBigInt64LE(o)); o += 8;
  const withdrawn = !!b[o++];
  return { commission, agent, signalledAt, withdrawn };
}

/// When a submission's own review window runs out. Every competitor gets the
/// same window on their own delivery rather than inheriting somebody else's.
function reviewEndsAt(submission, reviewWindow) {
  return submission.submittedAt + reviewWindow;
}

/// True once this delivery may be released by anyone, not just the creator.
/// This is the mechanism that turns creator silence into payment.
function reviewExpired(submission, reviewWindow, nowUnix = Math.floor(Date.now() / 1000)) {
  return !!submission
    && submission.state === 'pending'
    && nowUnix >= reviewEndsAt(submission, reviewWindow);
}

/// The delivery that may be judged next on a milestone.
///
/// It is the one whose sequence equals the milestone's rejected count, which is
/// what makes "first delivered, first judged" a rule rather than a slogan. A
/// creator cannot walk past an earlier delivery to reach a favourite.
function frontOfQueue(c, submissions, milestoneIndex) {
  const wanted = c.milestoneRejected?.[milestoneIndex] ?? 0;
  return (submissions || []).find(s =>
    s.milestoneIndex === milestoneIndex && s.state === 'pending' && s.sequence === wanted) || null;
}

/// Deliveries still queued on a milestone, oldest first.
function queueFor(submissions, milestoneIndex) {
  return (submissions || [])
    .filter(s => s.milestoneIndex === milestoneIndex && s.state === 'pending')
    .sort((a, b) => a.sequence - b.sequence);
}

/// True while delivered work still blocks cancellation and refunds.
///
/// Mirrors the program: bounded by the newest submission's own window plus a
/// grace period, so unjudged work can delay an exit but never prevent one.
function claimProtected(c, nowUnix = Math.floor(Date.now() / 1000)) {
  return c.unresolvedSubmissions > 0
    && nowUnix < c.latestSubmittedAt + c.reviewWindow + CLAIM_GRACE_WINDOW_SECONDS;
}

/// True once the window for doing the work has closed.
function workClosed(c, nowUnix = Math.floor(Date.now() / 1000)) {
  return c.workDeadline > 0 && nowUnix >= c.workDeadline;
}

/// Whether `wallet` may deliver work on this commission right now.
///
/// Deliberately short, because the answer is meant to be short: if the money is
/// there and the clock is running, anyone may work. No claim, no assignment, no
/// permission — that is the whole product.
function canWork(c, wallet, nowUnix = Math.floor(Date.now() / 1000)) {
  if (!wallet) return false;
  if (c.status !== 'funded') return false;
  if (workClosed(c, nowUnix)) return false;
  if (wallet === c.creator) return false;
  return !c.invitedAgent || c.invitedAgent === wallet;
}

/// What rent, if any, `wallet` can currently reclaim from this commission.
///
/// A pledge account is closed automatically by a refund, so the only case that
/// needs asking for is a commission that shipped: every lamport went to the
/// agent, no refund will ever be called, and the account would otherwise hold
/// its rent forever. The vault's reserve returns to the creator once the escrow
/// is empty and nobody can still need it.
function reclaimableRent(c, wallet, nowUnix = Math.floor(Date.now() / 1000)) {
  const claims = [];
  const settled = c.released + c.refunded >= c.pledged;
  if (c.status === 'shipped' && settled && wallet && c.pledgerCount > 0) {
    claims.push({ kind: 'pledge', lamports: PLEDGE_RENT_LAMPORTS, to: wallet });
  }
  const everyBackerSettled = c.refundedPledgerCount >= c.pledgerCount;
  if (settled && (c.status === 'shipped' || (c.status === 'refunded' && everyBackerSettled))) {
    claims.push({ kind: 'vault', lamports: VAULT_RENT_LAMPORTS, to: c.creator });
  }
  return { claims, total: claims.reduce((sum, claim) => sum + claim.lamports, 0), nowUnix };
}

/// What this commission is waiting on `wallet` to do, if anything.
///
/// Everything the parties need is already on chain, but it was only visible to
/// someone who happened to open the right dialog. A creator could be handed
/// finished work and never find out. This turns that state into something a
/// list can render and a notification can announce.
///
/// Returns null when nothing is owed, or `{ kind, urgency, label, detail,
/// deadline }` where `urgency` is 'act' (money or a clock depends on it),
/// 'soon' (worth knowing, no clock against this wallet), or 'idle'.
function pendingAttention(c, wallet, options = {}) {
  if (!wallet) return null;
  const nowUnix = typeof options === 'number'
    ? options
    : (options.nowUnix ?? Math.floor(Date.now() / 1000));
  const submissions = (typeof options === 'object' && options.submissions) || [];
  const isCreator = wallet === c.creator;

  // The case that started this: work has been delivered and a clock is running
  // against the creator. Silence pays the agent, so not noticing is expensive.
  if (isCreator) {
    for (let i = 0; i < c.milestoneCount; i++) {
      if (c.milestonesDone & (1 << i)) continue;
      const front = frontOfQueue(c, submissions, i);
      if (!front || reviewExpired(front, c.reviewWindow, nowUnix)) continue;
      const waiting = queueFor(submissions, i).length;
      return {
        kind: 'review',
        urgency: 'act',
        label: waiting > 1
          ? `Milestone ${i + 1}: ${waiting} deliveries waiting on you`
          : `Milestone ${i + 1} delivered \u2014 awaiting your review`,
        detail: waiting > 1
          ? 'Judged oldest first. Release one, or reject it to see the next.'
          : 'Release it, reject it, or it pays out automatically.',
        deadline: reviewEndsAt(front, c.reviewWindow),
      };
    }
  }

  // A matured claim: the agent should be told they can take it, and the creator
  // that they no longer control the outcome.
  for (let i = 0; i < c.milestoneCount; i++) {
    if (c.milestonesDone & (1 << i)) continue;
    const front = frontOfQueue(c, submissions, i);
    if (!front || !reviewExpired(front, c.reviewWindow, nowUnix)) continue;
    const isWinner = front.agent === wallet;
    if (!isWinner && !isCreator) continue;
    return {
      kind: 'claimable',
      urgency: 'act',
      label: isWinner
        ? `Milestone ${i + 1} is yours to claim`
        : `Milestone ${i + 1} review window has passed`,
      detail: isWinner
        ? 'The review window lapsed, so anyone can release this to you.'
        : 'Anyone can now release this to the agent who delivered it.',
      deadline: reviewEndsAt(front, c.reviewWindow) + CLAIM_GRACE_WINDOW_SECONDS,
    };
  }

  // An agent with work in the queue behind somebody else.
  const mine = submissions.filter(s => s.agent === wallet && s.state === 'pending');
  if (mine.length) {
    const ahead = mine.reduce((n, s) => n + s.sequence - (c.milestoneRejected?.[s.milestoneIndex] ?? 0), 0);
    if (ahead > 0) {
      return {
        kind: 'queued',
        urgency: 'soon',
        label: `Your delivery is ${ahead === 1 ? 'next' : `${ahead} back`} in the queue`,
        detail: 'Earlier deliveries are judged first. Yours is judged if they are rejected.',
        deadline: null,
      };
    }
  }

  // Funded and nobody has delivered: worth an agent’s attention, and worth a
  // creator knowing their money is sitting there unworked.
  if (c.status === 'funded' && !workClosed(c, nowUnix) && c.submissions === 0) {
    if (isCreator) {
      return {
        kind: 'awaiting-work',
        urgency: 'soon',
        label: 'Funded and open \u2014 nobody has delivered yet',
        detail: 'Any agent can pick this up. You do not need to choose one.',
        deadline: c.workDeadline || c.deadline,
      };
    }
    if (canWork(c, wallet, nowUnix)) {
      return {
        kind: 'open',
        urgency: 'soon',
        label: 'Open for work, nobody competing yet',
        detail: 'Funded and unclaimed. Deliver it and the escrow is yours to win.',
        deadline: c.workDeadline || c.deadline,
      };
    }
  }

  // Deliberately nothing about account deposits here.
  //
  // Solana's rent is a refundable deposit on each account, and it does have to
  // be returned — but that is plumbing, not an obligation, and surfacing it as
  // something the user must notice and act on turned a bookkeeping detail into a
  // chore. The deposits now ride home on the transaction that settles the
  // commission, so there is nothing to tell anyone about.
  return null;
}
/// Whether a refund from this commission will be charged the connection fee.
/// Once an agent has delivered something the protocol has done the part it
/// controls, so the fee applies however the money leaves escrow.
function refundCarriesFee(c) {
  return c.submissions > 0;
}

/// Lamports still owed by a commission: pledged minus everything paid out.
const escrowRemaining = c => c.pledged - c.released - c.refunded;

const meta = (pubkey, isSigner, isWritable) => ({ pubkey: key(pubkey), isSigner, isWritable });
const systemProgram = () => w3().SystemProgram.programId;
const ix = args => new (w3().TransactionInstruction)(args);

/// Instruction builders. `ctx` carries { programId, configPda, treasury }.
const build = {
  createCommission(ctx, {
    creator, seed, goalLamports, milestoneBasisPoints, deadlineUnix,
    // Zero tells the program to use its own defaults, so a caller that does not
    // care about the clocks still gets workable ones.
    workWindowSeconds = 0, reviewWindowSeconds = 0,
  }) {
    const commission = commissionPda(ctx.programId, creator, seed);
    const vault = vaultPda(ctx.programId, commission);
    return {
      commission, vault,
      instruction: ix({
        programId: key(ctx.programId),
        keys: [
          meta(creator, true, true),
          meta(ctx.configPda, false, false),
          meta(commission, false, true),
          meta(vault, false, true),
          meta(systemProgram(), false, false),
        ],
        data: Buffer.concat([
          Buffer.from([IX.createCommission]), u64(seed), u64(goalLamports),
          u32(milestoneBasisPoints.length), ...milestoneBasisPoints.map(u16), i64(deadlineUnix),
          i64(workWindowSeconds), i64(reviewWindowSeconds),
        ]),
      }),
    };
  },

  pledge(ctx, { backer, commission, amountLamports }) {
    const vault = vaultPda(ctx.programId, commission);
    const pledge = pledgePda(ctx.programId, commission, backer);
    return {
      commission: key(commission), vault, pledge,
      instruction: ix({
        programId: key(ctx.programId),
        keys: [
          meta(backer, true, true),
          meta(ctx.configPda, false, false),
          meta(commission, false, true),
          meta(pledge, false, true),
          meta(vault, false, true),
          meta(systemProgram(), false, false),
        ],
        data: Buffer.concat([Buffer.from([IX.pledge]), u64(amountLamports)]),
      }),
    };
  },

  /// OPTIONAL: narrow a commission to one agent. Passing the creator's own key
  /// clears the restriction and puts the work back on the open board.
  inviteAgent(ctx, { creator, commission, agent }) {
    return {
      commission: key(commission),
      instruction: ix({
        programId: key(ctx.programId),
        keys: [meta(creator, true, false), meta(commission, false, true), meta(agent, false, false)],
        data: Buffer.from([IX.inviteAgent]),
      }),
    };
  },

  /// Non-binding: reserves nothing, blocks nobody, confers no priority.
  signalIntent(ctx, { agent, commission }) {
    const intent = intentPda(ctx.programId, commission, agent);
    return {
      commission: key(commission), intent,
      instruction: ix({
        programId: key(ctx.programId),
        keys: [
          meta(agent, true, true),
          meta(commission, false, true),
          meta(intent, false, true),
          meta(systemProgram(), false, false),
        ],
        data: Buffer.from([IX.signalIntent]),
      }),
    };
  },

  withdrawIntent(ctx, { agent, commission }) {
    const intent = intentPda(ctx.programId, commission, agent);
    return {
      commission: key(commission), intent,
      instruction: ix({
        programId: key(ctx.programId),
        keys: [meta(agent, true, false), meta(commission, false, true), meta(intent, false, true)],
        data: Buffer.from([IX.withdrawIntent]),
      }),
    };
  },

  /// Returns a settled submission's deposit to the agent who delivered it.
  ///
  /// The agent does not sign: the lamports can only go to the wallet named on
  /// the submission, so this rides along on whatever transaction settles the
  /// commission instead of waiting for them to come back and collect.
  closeSubmission(ctx, { agent, commission, milestoneIndex }) {
    const submission = submissionPda(ctx.programId, commission, milestoneIndex, agent);
    return {
      commission: key(commission), submission,
      instruction: ix({
        programId: key(ctx.programId),
        keys: [meta(agent, false, true), meta(commission, false, true), meta(submission, false, true)],
        data: Buffer.from([IX.closeSubmission]),
      }),
    };
  },

  /// Returns an intent's deposit to the agent who declared it.
  ///
  /// The agent does not sign. They are not present when the creator settles the
  /// commission, so requiring them would make the whole sweep unsendable.
  /// Claims a name for the signing wallet, permanently.
  ///
  /// The wallet signs because a name means "this key said so". There is no
  /// matching close or transfer builder because the program has no such
  /// instruction: renaming frees nothing, so a reputation can never be inherited
  /// by somebody who did not build it.
  claimHandle(ctx, { wallet, handle }) {
    const lower = String(handle).toLowerCase();
    const claim = handlePda(ctx.programId, lower);
    const name = Buffer.from(lower, 'utf8');
    return {
      handle: lower, claim,
      instruction: ix({
        programId: key(ctx.programId),
        keys: [
          meta(wallet, true, true),
          meta(claim, false, true),
          meta(systemProgram(), false, false),
        ],
        // Borsh: variant byte, then a u32 length-prefixed byte vector.
        data: Buffer.concat([
          Buffer.from([IX.claimHandle]),
          (() => { const n = Buffer.alloc(4); n.writeUInt32LE(name.length); return n; })(),
          name,
        ]),
      }),
    };
  },

  closeIntent(ctx, { agent, commission }) {
    const intent = intentPda(ctx.programId, commission, agent);
    return {
      commission: key(commission), intent,
      instruction: ix({
        programId: key(ctx.programId),
        keys: [meta(agent, false, true), meta(commission, false, true), meta(intent, false, true)],
        data: Buffer.from([IX.closeIntent]),
      }),
    };
  },

  /// Pays one submission and closes its milestone.
  ///
  /// `signer` may be the creator at any time, or anyone once that submission's
  /// review window has elapsed. The payee is read off the submission account, so
  /// a caller cannot redirect the money.
  releaseMilestone(ctx, { creator, signer, commission, agent, milestoneIndex }) {
    const vault = vaultPda(ctx.programId, commission);
    const submission = submissionPda(ctx.programId, commission, milestoneIndex, agent);
    return {
      commission: key(commission), vault, submission,
      instruction: ix({
        programId: key(ctx.programId),
        keys: [
          meta(signer || creator, true, false),
          meta(commission, false, true),
          meta(submission, false, true),
          meta(vault, false, true),
          meta(agent, false, true),
          meta(ctx.treasury, false, true),
        ],
        data: Buffer.from([IX.releaseMilestone]),
      }),
    };
  },

  /// Deliver work against a milestone. Open to anyone on an open commission:
  /// no claim, no assignment, no permission.
  ///
  /// `evidenceHash` is 32 opaque bytes — a commit id, an artifact digest. The
  /// chain stores the commitment; the content is recorded off chain and only
  /// accepted if it hashes to this.
  submitDelivery(ctx, { agent, commission, milestoneIndex, evidenceHash }) {
    const hash = Buffer.isBuffer(evidenceHash) ? evidenceHash : Buffer.from(evidenceHash || [], 'hex');
    if (hash.length !== 32) throw new Error('evidenceHash must be exactly 32 bytes');
    const submission = submissionPda(ctx.programId, commission, milestoneIndex, agent);
    return {
      commission: key(commission), submission,
      instruction: ix({
        programId: key(ctx.programId),
        keys: [
          meta(agent, true, true),
          meta(commission, false, true),
          meta(submission, false, true),
          meta(systemProgram(), false, false),
        ],
        data: Buffer.concat([Buffer.from([IX.submitDelivery, milestoneIndex]), hash]),
      }),
    };
  },

  /// The creator refuses the delivery at the front of a milestone's queue.
  /// Public, attributable, and it promotes the next one in line.
  rejectDelivery(ctx, { creator, commission, agent, milestoneIndex }) {
    const submission = submissionPda(ctx.programId, commission, milestoneIndex, agent);
    return {
      commission: key(commission), submission,
      instruction: ix({
        programId: key(ctx.programId),
        keys: [
          meta(creator, true, false),
          meta(commission, false, true),
          meta(submission, false, true),
        ],
        data: Buffer.from([IX.rejectDelivery]),
      }),
    };
  },

  refund(ctx, { backer, commission }) {
    const vault = vaultPda(ctx.programId, commission);
    const pledge = pledgePda(ctx.programId, commission, backer);
    return {
      commission: key(commission), vault, pledge,
      instruction: ix({
        programId: key(ctx.programId),
        keys: [
          meta(backer, true, true),
          meta(commission, false, true),
          meta(pledge, false, true),
          meta(vault, false, true),
          // Receives the 1% connection fee when a delivery was ever submitted,
          // and nothing at all when none was.
          meta(ctx.treasury, false, true),
        ],
        data: Buffer.from([IX.refund]),
      }),
    };
  },

  /// Returns a pledge account's deposit to its backer, on the shipped path where
  /// no refund will ever close it.
  ///
  /// The backer does not sign, for the same reason as closeSubmission.
  closePledge(ctx, { backer, commission }) {
    const pledge = pledgePda(ctx.programId, commission, backer);
    return {
      commission: key(commission), pledge,
      instruction: ix({
        programId: key(ctx.programId),
        keys: [
          meta(backer, false, true),
          meta(commission, false, true),
          meta(pledge, false, true),
        ],
        data: Buffer.from([IX.closePledge]),
      }),
    };
  },

  /// Returns the vault's rent reserve to the creator once the escrow is empty.
  /// Anyone may send this; the lamports always go to the creator regardless.
  closeVault(ctx, { signer, commission, creator }) {
    const vault = vaultPda(ctx.programId, commission);
    return {
      commission: key(commission), vault,
      instruction: ix({
        programId: key(ctx.programId),
        keys: [
          meta(signer, true, false),
          meta(commission, false, true),
          meta(vault, false, true),
          meta(creator, false, true),
        ],
        data: Buffer.from([IX.closeVault]),
      }),
    };
  },

  cancel(ctx, { signer, commission }) {
    return {
      commission: key(commission),
      instruction: ix({
        programId: key(ctx.programId),
        keys: [meta(signer, true, false), meta(commission, false, true)],
        data: Buffer.from([IX.cancel]),
      }),
    };
  },
};

/// What a given wallet is allowed to do right now, straight from on-chain state.
/// This is the question an autonomous agent actually needs answered.
///
/// `submissions` is the decoded list for this commission. It is optional: pass
/// it and the queue-sensitive answers become exact, omit it and you still get
/// the answers that depend on the commission alone.
function availableActions(c, wallet, options = {}) {
  const nowUnix = typeof options === 'number'
    ? options
    : (options.nowUnix ?? Math.floor(Date.now() / 1000));
  const submissions = (typeof options === 'object' && options.submissions) || [];
  const fundingExpired = nowUnix >= c.deadline;
  const closed = workClosed(c, nowUnix);
  const isCreator = !!wallet && wallet === c.creator;
  const claimBlocks = claimProtected(c, nowUnix);
  const hasUnreleased = () => {
    for (let i = 0; i < c.milestoneCount; i++) if (!(c.milestonesDone & (1 << i))) return true;
    return false;
  };
  const actions = [];

  if (c.status === 'funding' && !fundingExpired) actions.push('pledge');

  // The heart of it: a funded commission is workable by ANYONE. Under the old
  // model an agent who found this job could do nothing at all until a human
  // chose them, which is the bottleneck this replaced.
  if (canWork(c, wallet, nowUnix) && hasUnreleased()) {
    actions.push('submitDelivery');
    actions.push('signalIntent');
  }
  // Narrowing a commission to one agent stays available, but it is the
  // exception rather than the path.
  if (isCreator && ['funding', 'funded'].includes(c.status)) actions.push('inviteAgent');

  // Judging happens strictly in order of arrival.
  for (let i = 0; i < c.milestoneCount; i++) {
    if (c.milestonesDone & (1 << i)) continue;
    const front = frontOfQueue(c, submissions, i);
    if (!front) continue;
    const matured = reviewExpired(front, c.reviewWindow, nowUnix);
    // The creator may pay at any time; anyone may complete a matured claim.
    if (isCreator || matured) actions.push('releaseMilestone');
    // Refusal is available only while the window still belongs to the creator.
    if (isCreator && !matured) actions.push('rejectDelivery');
  }

  if (!claimBlocks) {
    // A funded bounty cannot be pulled out from under agents who may already
    // be spending compute on it. Before funding it is still just an offer.
    if (isCreator && c.status === 'funding') actions.push('cancel');
    if (['funding', 'funded'].includes(c.status) && (fundingExpired || closed)) actions.push('cancel');

    const refundable = ['cancelled', 'refunded'].includes(c.status)
      || (fundingExpired && ['funding', 'funded'].includes(c.status))
      || closed;
    if (refundable) actions.push('refund');
  }

  // Reclaiming rent is never urgent and never touches escrow, so it comes last
  // and only once an account genuinely cannot be needed again.
  const mine = submissions.filter(s => s.agent === wallet);
  const settledForMe = mine.some(s =>
    s.state !== 'pending'
    || (c.milestonesDone & (1 << s.milestoneIndex)) !== 0
    || c.status === 'refunded'
    || (closed && !claimBlocks));
  if (settledForMe) actions.push('closeSubmission');
  for (const claim of reclaimableRent(c, wallet, nowUnix).claims) {
    if (claim.kind === 'pledge' && wallet) actions.push('closePledge');
    if (claim.kind === 'vault') actions.push('closeVault');
  }
  return [...new Set(actions)];
}
/// Extracts a program error name from a failed transaction, if there is one.
function explainError(error) {
  const message = error?.message || String(error);
  const match = /custom program error:\s*0x([0-9a-f]+)/i.exec(message) || /Custom["\s:]+(\d+)/.exec(message);
  if (!match) return null;
  const code = match[0].includes('0x') ? parseInt(match[1], 16) : Number(match[1]);
  const name = ERRORS[code];
  return name ? { code, name, message: ERROR_HELP[name] || name } : { code, name: 'Unknown', message };
}

module.exports = {
  LAMPORTS_PER_SOL, BPS_DENOMINATOR, FEE_BASIS_POINTS, MAX_MILESTONES,
  COMMISSION_ACCOUNT_BYTES, SUBMISSION_ACCOUNT_BYTES, INTENT_ACCOUNT_BYTES, PLEDGE_ACCOUNT_BYTES, CONFIG_ACCOUNT_BYTES, HANDLE_ACCOUNT_BYTES,
  MAX_COMMISSION_LAMPORTS,
  VAULT_RENT_LAMPORTS, PLEDGE_RENT_LAMPORTS, COMMISSION_RENT_LAMPORTS,
  SUBMISSION_RENT_LAMPORTS, INTENT_RENT_LAMPORTS,
  MAX_FUNDING_DURATION_SECONDS,
  MIN_WORK_WINDOW_SECONDS, MAX_WORK_WINDOW_SECONDS, DEFAULT_WORK_WINDOW_SECONDS,
  MIN_REVIEW_WINDOW_SECONDS, MAX_REVIEW_WINDOW_SECONDS, DEFAULT_REVIEW_WINDOW_SECONDS,
  CLAIM_GRACE_WINDOW_SECONDS, MAX_SUBMISSIONS_PER_MILESTONE,
  reviewEndsAt, reviewExpired, claimProtected, workClosed, canWork,
  frontOfQueue, queueFor, refundCarriesFee, reclaimableRent, pendingAttention,
  IX, STATUS, SUBMISSION_STATE, ERRORS, ERROR_HELP,
  commissionPda, vaultPda, pledgePda, submissionPda, intentPda,
  decodeCommission, decodeSubmission, decodeIntent, decodePledge, decodeConfig, decodeHandleClaim, escrowRemaining,
  handlePda,
  build, availableActions, explainError, canBuildTransactions,
};

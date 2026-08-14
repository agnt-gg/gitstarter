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
const MIN_DELIVERY_WINDOW_SECONDS = 3_600;
const MAX_DELIVERY_WINDOW_SECONDS = 30 * 86_400;
const DEFAULT_DELIVERY_WINDOW_SECONDS = 3 * 86_400;
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
const COMMISSION_ACCOUNT_BYTES = 316;
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
const COMMISSION_RENT_LAMPORTS = (128 + 316) * 6_960;

const SEED_COMMISSION = Buffer.from('commission');
const SEED_VAULT = Buffer.from('vault');
const SEED_PLEDGE = Buffer.from('pledge');

/// Borsh enum discriminants, in declaration order.
const IX = {
  initConfig: 0,
  createCommission: 1,
  pledge: 2,
  selectAgent: 3,
  releaseMilestone: 4,
  refund: 5,
  cancel: 6,
  setPaused: 7,
  acceptAgent: 8,
  revokeAgent: 9,
  submitDelivery: 10,
  rejectDelivery: 11,
  closePledge: 12,
  closeVault: 13,
};

const STATUS = ['funding', 'funded', 'building', 'shipped', 'refunded'];

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
};

const ERROR_HELP = {
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
  NotSettled: 'This account is still in use. Rent can only be reclaimed once the commission has fully settled.',
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
function pledgePda(programId, commission, backer) {
  return w3().PublicKey.findProgramAddressSync(
    [SEED_PLEDGE, key(commission).toBuffer(), key(backer).toBuffer()], key(programId))[0];
}

/// Decodes a Commission account. Layout is fixed at 315 bytes; see lib.rs.
function decodeCommission(data) {
  const b = Buffer.from(data);
  if (b.length !== COMMISSION_ACCOUNT_BYTES) throw new Error('Not a commission account');
  let o = 1;
  const pk = () => { const v = bs58.encode(b.subarray(o, o + 32)); o += 32; return v; };
  const num = () => { const v = Number(b.readBigUInt64LE(o)); o += 8; return v; };
  const creator = pk();
  o += 32; // reserved, retained for layout compatibility
  const treasury = pk();
  const seed = num(), goal = num(), pledged = num(), released = num(), refunded = num();
  const pledgerCount = b.readUInt32LE(o); o += 4;
  const refundedPledgerCount = b.readUInt32LE(o); o += 4;
  const agent = pk(), pendingAgent = pk();
  const hasPendingAgent = !!b[o++], hasAgent = !!b[o++];
  const status = STATUS[b[o++]] || 'unknown';
  const milestoneCount = b[o++];
  const milestoneBps = [];
  for (let i = 0; i < MAX_MILESTONES; i++) { milestoneBps.push(b.readUInt16LE(o)); o += 2; }
  const milestonesDone = b[o++];
  const i64 = () => { const v = Number(b.readBigInt64LE(o)); o += 8; return v; };
  const deadline = i64();
  o += 2; // bump, vault_bump
  const deliveryWindow = i64();
  const deliveryDeadline = i64();
  const reviewWindow = i64();
  const submittedAt = i64();
  const submittedIndex = b[o++];
  const evidenceHash = Buffer.from(b.subarray(o, o + 32)).toString('hex'); o += 32;
  const nominatedAt = i64();
  const submissions = b[o++], rejections = b[o++], autoReleases = b[o++];

  const hasPendingSubmission = submittedAt > 0;
  return {
    creator, treasury, seed, goal, pledged, released, refunded,
    pledgerCount, refundedPledgerCount,
    agent: hasAgent ? agent : null,
    pendingAgent: hasPendingAgent ? pendingAgent : null,
    status, milestoneCount,
    milestoneBps: milestoneBps.slice(0, milestoneCount),
    milestonesDone, deadline,
    deliveryWindow, deliveryDeadline, reviewWindow,
    // A zeroed hash means "no submission", so it is reported as absent rather
    // than as 64 characters of misleading zeroes.
    submission: hasPendingSubmission
      ? {
        milestoneIndex: submittedIndex,
        submittedAt,
        evidenceHash,
        reviewEndsAt: submittedAt + reviewWindow,
      }
      : null,
    nominatedAt: nominatedAt || null,
    nominationLapsesAt: nominatedAt ? nominatedAt + NOMINATION_WINDOW_SECONDS : null,
    submissions, rejections, autoReleases,
  };
}

/// True once a submitted delivery may be released by anyone, not just the
/// creator. This is the mechanism that turns creator silence into payment.
function reviewExpired(c, nowUnix = Math.floor(Date.now() / 1000)) {
  return !!c.submission && nowUnix >= c.submission.reviewEndsAt;
}

/// True while a delivery still blocks cancellation and refunds — through the
/// review window and for a grace period afterwards, so an agent who genuinely
/// delivered cannot lose a race to a fast backer.
function claimProtected(c, nowUnix = Math.floor(Date.now() / 1000)) {
  return !!c.submission && nowUnix < c.submission.reviewEndsAt + CLAIM_GRACE_WINDOW_SECONDS;
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
    deliveryWindowSeconds = 0, reviewWindowSeconds = 0,
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
          i64(deliveryWindowSeconds), i64(reviewWindowSeconds),
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

  selectAgent(ctx, { creator, commission, agent }) {
    return {
      commission: key(commission),
      instruction: ix({
        programId: key(ctx.programId),
        keys: [meta(creator, true, false), meta(commission, false, true), meta(agent, false, false)],
        data: Buffer.from([IX.selectAgent]),
      }),
    };
  },

  revokeAgent(ctx, { creator, commission }) {
    return {
      commission: key(commission),
      instruction: ix({
        programId: key(ctx.programId),
        keys: [meta(creator, true, false), meta(commission, false, true)],
        data: Buffer.from([IX.revokeAgent]),
      }),
    };
  },

  acceptAgent(ctx, { agent, commission }) {
    return {
      commission: key(commission),
      instruction: ix({
        programId: key(ctx.programId),
        keys: [meta(agent, true, false), meta(commission, false, true)],
        data: Buffer.from([IX.acceptAgent]),
      }),
    };
  },

  releaseMilestone(ctx, { creator, commission, agent, milestoneIndex }) {
    const vault = vaultPda(ctx.programId, commission);
    return {
      commission: key(commission), vault,
      instruction: ix({
        programId: key(ctx.programId),
        keys: [
          meta(creator, true, false),
          meta(commission, false, true),
          meta(vault, false, true),
          meta(agent, false, true),
          meta(ctx.treasury, false, true),
        ],
        data: Buffer.from([IX.releaseMilestone, milestoneIndex]),
      }),
    };
  },

  /// The agent records a delivery, starting the review clock. `evidenceHash` is
  /// 32 opaque bytes — a commit id, an artifact digest. The chain stores the
  /// commitment, never the content.
  submitDelivery(ctx, { agent, commission, milestoneIndex, evidenceHash }) {
    const hash = Buffer.isBuffer(evidenceHash) ? evidenceHash : Buffer.from(evidenceHash || [], 'hex');
    if (hash.length !== 32) throw new Error('evidenceHash must be exactly 32 bytes');
    return {
      commission: key(commission),
      instruction: ix({
        programId: key(ctx.programId),
        keys: [meta(agent, true, false), meta(commission, false, true)],
        data: Buffer.concat([Buffer.from([IX.submitDelivery, milestoneIndex]), hash]),
      }),
    };
  },

  /// The creator refuses a delivery. Public, attributable, and it stops the
  /// clock that would otherwise have paid the agent.
  rejectDelivery(ctx, { creator, commission }) {
    return {
      commission: key(commission),
      instruction: ix({
        programId: key(ctx.programId),
        keys: [meta(creator, true, false), meta(commission, false, true)],
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

  /// Returns an 83-byte pledge account's rent to its backer, on the shipped path
  /// where no refund will ever close it.
  closePledge(ctx, { backer, commission }) {
    const pledge = pledgePda(ctx.programId, commission, backer);
    return {
      commission: key(commission), pledge,
      instruction: ix({
        programId: key(ctx.programId),
        keys: [
          meta(backer, true, true),
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
function availableActions(c, wallet, nowUnix = Math.floor(Date.now() / 1000)) {
  const fundingExpired = nowUnix >= c.deadline;
  // Once started, the delivery clock governs the commission whatever its status
  // — including one rejected back into the pool and never re-accepted.
  const deliveryExpired = c.deliveryDeadline > 0 && nowUnix >= c.deliveryDeadline;
  const isCreator = wallet && wallet === c.creator;
  const isAgent = wallet && wallet === c.agent;
  const isNominee = wallet && wallet === c.pendingAgent;
  const matured = reviewExpired(c, nowUnix);
  // A delivery awaiting judgement freezes every exit, so that work which has
  // been handed over cannot be cancelled or refunded out from under the agent.
  // The freeze outlasts the review window by a grace period, so a claim that
  // matures after the delivery deadline is not a race the agent can lose.
  const claimBlocks = claimProtected(c, nowUnix);
  const hasUnreleased = () => {
    for (let i = 0; i < c.milestoneCount; i++) if (!(c.milestonesDone & (1 << i))) return true;
    return false;
  };
  const actions = [];

  if (c.status === 'funding' && !fundingExpired) actions.push('pledge');
  if (c.status === 'funded' && isCreator && !c.pendingAgent && !c.agent && !fundingExpired) actions.push('selectAgent');
  if (c.status === 'funded' && c.pendingAgent && !c.agent) {
    const lapsed = c.nominationLapsesAt !== null && nowUnix >= c.nominationLapsesAt;
    if (isCreator || lapsed) actions.push('revokeAgent');
  }
  if (c.status === 'funded' && isNominee && !fundingExpired) actions.push('acceptAgent');

  if (c.status === 'funded' && !c.agent && !c.pendingAgent && !fundingExpired && !deliveryExpired && c.deliveryDeadline > 0) {
    // Rejected back into the pool: still hireable, but only while the delivery
    // clock the next agent would inherit still has time left on it.
    if (isCreator) actions.push('selectAgent');
  }

  if (c.status === 'building') {
    // The agent hands work over; only they can, and only before their clock runs out.
    if (isAgent && !c.submission && !deliveryExpired && hasUnreleased()) actions.push('submitDelivery');
    // The creator may pay at any time. Anyone may finish a matured claim.
    if (isCreator && hasUnreleased()) actions.push('releaseMilestone');
    if (matured) actions.push('releaseMilestone');
    // Refusal is available only while the window still belongs to the creator.
    if (isCreator && c.submission && !matured) actions.push('rejectDelivery');
  }

  if (!claimBlocks) {
    // The creator may back out at will only while nobody has ever committed to
    // the work. Once a delivery clock exists it governs, including after a
    // rejection — otherwise rejecting would be an instant unilateral exit.
    if (isCreator && ['funding', 'funded'].includes(c.status) && !c.deliveryDeadline) actions.push('cancel');
    if (isAgent && c.status === 'building') actions.push('cancel');
    if (!isCreator && !isAgent && fundingExpired && ['funding', 'funded'].includes(c.status)) actions.push('cancel');
    if (deliveryExpired) actions.push('cancel');

    const refundable = ['cancelled', 'refunded'].includes(c.status)
      || (fundingExpired && ['funding', 'funded'].includes(c.status))
      || deliveryExpired;
    if (refundable) actions.push('refund');
  }

  // Reclaiming rent is never urgent and never affects escrow, so it is offered
  // last and only once the account genuinely cannot be needed again.
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
  COMMISSION_ACCOUNT_BYTES, VAULT_RENT_LAMPORTS,
  MAX_FUNDING_DURATION_SECONDS,
  MIN_DELIVERY_WINDOW_SECONDS, MAX_DELIVERY_WINDOW_SECONDS, DEFAULT_DELIVERY_WINDOW_SECONDS,
  MIN_REVIEW_WINDOW_SECONDS, MAX_REVIEW_WINDOW_SECONDS, DEFAULT_REVIEW_WINDOW_SECONDS,
  NOMINATION_WINDOW_SECONDS, CLAIM_GRACE_WINDOW_SECONDS,
  PLEDGE_RENT_LAMPORTS, COMMISSION_RENT_LAMPORTS,
  reviewExpired, claimProtected, refundCarriesFee, reclaimableRent,
  IX, STATUS, ERRORS, ERROR_HELP,
  commissionPda, vaultPda, pledgePda, decodeCommission, escrowRemaining,
  build, availableActions, explainError, canBuildTransactions,
};

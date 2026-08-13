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

// Pinned by program/src/lib.rs::commission_account_size_is_pinned. If these two
// ever disagree, every commission silently fails to decode.
const COMMISSION_ACCOUNT_BYTES = 316;
/// Rent reserve of the 0-byte vault PDA. It is not escrow and is never payable.
const VAULT_RENT_LAMPORTS = 890_880;

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
};

const STATUS = ['funding', 'funded', 'building', 'shipped', 'refunded'];

/// EscrowError discriminants, so a rejected transaction can be explained rather
/// than surfaced as "custom program error: 0x18".
const ERRORS = {
  1: 'AlreadyInitialized',
  2: 'Unauthorized',
  7: 'BadStatus',
  11: 'MilestoneAlreadyReleased',
  13: 'NothingToRefund',
  14: 'DeadlineNotPassed',
  15: 'Paused',
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
  NoSubmission: 'There is no delivery awaiting review on this commission.',
  ReviewWindowOpen: 'The review window has not finished, so only the creator can act yet.',
  BadWindow: 'Delivery and review windows must be between one hour and their maximums.',
  SubmissionPending: 'A delivery is awaiting review. It must be released or rejected first.',
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
        ],
        data: Buffer.from([IX.refund]),
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
  const deliveryExpired = c.status === 'building' && nowUnix >= c.deliveryDeadline;
  const isCreator = wallet && wallet === c.creator;
  const isAgent = wallet && wallet === c.agent;
  const isNominee = wallet && wallet === c.pendingAgent;
  const matured = reviewExpired(c, nowUnix);
  // A delivery awaiting judgement freezes every exit, so that work which has
  // been handed over cannot be cancelled or refunded out from under the agent.
  const claimBlocks = !!c.submission && !matured;
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
    if (isCreator && ['funding', 'funded'].includes(c.status)) actions.push('cancel');
    if (isAgent && c.status === 'building') actions.push('cancel');
    if (!isCreator && !isAgent && fundingExpired && ['funding', 'funded'].includes(c.status)) actions.push('cancel');
    if (deliveryExpired) actions.push('cancel');

    const refundable = ['cancelled', 'refunded'].includes(c.status)
      || (fundingExpired && ['funding', 'funded'].includes(c.status))
      || deliveryExpired;
    if (refundable) actions.push('refund');
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
  NOMINATION_WINDOW_SECONDS, reviewExpired,
  IX, STATUS, ERRORS, ERROR_HELP,
  commissionPda, vaultPda, pledgePda, decodeCommission, escrowRemaining,
  build, availableActions, explainError, canBuildTransactions,
};

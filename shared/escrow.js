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
const MAX_COMMISSION_DURATION_SECONDS = 180 * 86_400;
const COMMISSION_ACCOUNT_BYTES = 240;
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
  DeadlineTooFar: `Deadlines cannot exceed ${MAX_COMMISSION_DURATION_SECONDS / 86_400} days.`,
  GoalTooSmall: `The goal must be at least ${BPS_DENOMINATOR} lamports.`,
  NoPendingAgent: 'There is no unaccepted nomination to withdraw.',
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

/// Decodes a Commission account. Layout is fixed at 240 bytes; see lib.rs.
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
  const deadline = Number(b.readBigInt64LE(o));
  return {
    creator, treasury, seed, goal, pledged, released, refunded,
    pledgerCount, refundedPledgerCount,
    agent: hasAgent ? agent : null,
    pendingAgent: hasPendingAgent ? pendingAgent : null,
    status, milestoneCount,
    milestoneBps: milestoneBps.slice(0, milestoneCount),
    milestonesDone, deadline,
  };
}

/// Lamports still owed by a commission: pledged minus everything paid out.
const escrowRemaining = c => c.pledged - c.released - c.refunded;

const meta = (pubkey, isSigner, isWritable) => ({ pubkey: key(pubkey), isSigner, isWritable });
const systemProgram = () => w3().SystemProgram.programId;
const ix = args => new (w3().TransactionInstruction)(args);

/// Instruction builders. `ctx` carries { programId, configPda, treasury }.
const build = {
  createCommission(ctx, { creator, seed, goalLamports, milestoneBasisPoints, deadlineUnix }) {
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
  const expired = nowUnix >= c.deadline;
  const isCreator = wallet && wallet === c.creator;
  const isAgent = wallet && wallet === c.agent;
  const isNominee = wallet && wallet === c.pendingAgent;
  const actions = [];
  if (c.status === 'funding' && !expired) actions.push('pledge');
  if (c.status === 'funded' && isCreator && !c.pendingAgent && !c.agent && !expired) actions.push('selectAgent');
  if (c.status === 'funded' && isCreator && c.pendingAgent) actions.push('revokeAgent');
  if (c.status === 'funded' && isNominee && !expired) actions.push('acceptAgent');
  if (c.status === 'building' && isCreator) {
    for (let i = 0; i < c.milestoneCount; i++) if (!(c.milestonesDone & (1 << i))) { actions.push('releaseMilestone'); break; }
  }
  if (isCreator && ['funding', 'funded'].includes(c.status)) actions.push('cancel');
  if (isAgent && c.status === 'building') actions.push('cancel');
  if (!isCreator && !isAgent && expired && ['funding', 'funded'].includes(c.status)) actions.push('cancel');
  if (['cancelled', 'refunded'].includes(c.status) || (expired && ['funding', 'funded'].includes(c.status))) actions.push('refund');
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
  MAX_COMMISSION_DURATION_SECONDS, COMMISSION_ACCOUNT_BYTES, VAULT_RENT_LAMPORTS,
  IX, STATUS, ERRORS, ERROR_HELP,
  commissionPda, vaultPda, pledgePda, decodeCommission, escrowRemaining,
  build, availableActions, explainError, canBuildTransactions,
};

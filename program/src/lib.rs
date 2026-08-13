//! GitStarter escrow — milestone-gated escrow for crowdfunded agent commissions.
//!
//! ## The mechanism
//!
//! Backers pledge native SOL into a per-commission PDA vault. SOL does NOT go
//! to the agent until milestones are accepted. A fixed 1.00% fee is taken once,
//! when successful work is released; refunds return all unreleased SOL free.
//!
//! ## Design rules this file follows
//!
//! 1. **No unchecked arithmetic.** Every add/sub/mul is `checked_*`. Pro-rata
//!    math widens to `u128` before multiplying, so `amount * total` cannot
//!    overflow for any `u64` inputs.
//! 2. **No trusted bumps.** Every PDA is re-derived with
//!    `find_program_address` inside the instruction. A caller-supplied bump is
//!    never used to sign or to validate.
//! 3. **Checks → effects → interactions.** All state is written and persisted
//!    before any SOL transfer, so every later instruction observes
//!    already-decremented balances.
//! 4. **Every account is validated.** Owner, signer, PDA address, treasury, agent,
//!    and account discriminator are checked explicitly.
//! 5. **Native SOL only.** No mint, token account, approval, swap, or liquidity
//!    dependency can block a commission.
//! 6. **Conservation.** For every commission:
//!    `total_pledged == vault_balance + released + refunded`, always. The
//!    integration tests assert this invariant after every state transition.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

// Parsed by explorers and by `query-security-txt`. Every field here is a claim
// that must stay true: `auditors` in particular says exactly what review this
// program has had, because overstating that is worse than declaring nothing.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "GitStarter Escrow",
    project_url: "https://gitstarter.agnt.gg",
    contacts: "email:hello@agnt.gg,link:https://github.com/agnt-gg/gitstarter/security/advisories/new",
    policy: "https://github.com/agnt-gg/gitstarter/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/agnt-gg/gitstarter",
    source_release: "devnet-2026-08-13",
    auditors: "None. Internal adversarial review only - see docs/MECHANICS.md",
    acknowledgements: "Disclose privately before exploiting and you will be credited here."
}

// ───────────────────────────── constants ─────────────────────────────

/// Protocol fee, in basis points. 100 bps = 1.00%.
///
/// This is a compile-time constant rather than a config field on purpose: a
/// mutable fee is an authority that can be abused, and a fee that can be raised
/// after SOL is already escrowed is a rug vector. To change the fee you
/// must ship a new program, which is a visible, reviewable event.
pub const FEE_BPS: u64 = 100;
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Only this wallet can initialize the singleton. This closes the deployment
/// front-running window: without a fixed initializer, the first observer to
/// call InitConfig becomes admin and chooses the fee treasury.
///
/// The mainnet authority is compiled in behind the `mainnet` feature so that a
/// production binary can never be built with the disposable devnet key by
/// accident. Switching it is a visible, reviewable, recompiled event.
#[cfg(not(feature = "mainnet"))]
pub const INITIALIZER: Pubkey =
    solana_program::pubkey!("4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY");

#[cfg(feature = "mainnet")]
pub const INITIALIZER: Pubkey =
    solana_program::pubkey!("AactHbz74TBh1nGkEMeHaAdpwUGQHqnBrKabZefLikYj");

pub const MAX_MILESTONES: usize = 8;

// ── clocks ──────────────────────────────────────────────────────────────────
//
// One deadline used to cover both raising the money and doing the work, which
// meant a late-funded commission silently gave its agent less time. The phases
// are now separate, each with its own bound, and each expiring to the outcome
// that is fair at that point:
//
//   funding  expires -> refund   (nobody worked, so backers get their SOL back)
//   delivery expires -> refund   (the agent failed, same conclusion)
//   review   expires -> RELEASE  (the agent delivered and the creator went quiet)
//
// That last inversion is the whole point. Silence used to be free for a creator
// sitting on delivered work; now silence pays.

/// Ceiling on the funding phase. Also bounds the worst-case lock: a commission
/// can hold SOL for at most MAX_FUNDING_DURATION + MAX_DELIVERY_WINDOW.
pub const MAX_FUNDING_DURATION: i64 = 30 * 86_400;

/// Delivery clock, measured from the moment the agent accepts. Agents building
/// software work in hours, so the floor is deliberately low.
pub const MIN_DELIVERY_WINDOW: i64 = 3_600;
pub const MAX_DELIVERY_WINDOW: i64 = 30 * 86_400;
pub const DEFAULT_DELIVERY_WINDOW: i64 = 3 * 86_400;

/// How long a creator has to review a submitted delivery before anyone may
/// release it on the agent's behalf. Chosen by the creator at creation time and
/// visible to the agent before they accept, so it is a disclosed term rather
/// than a surprise.
pub const MIN_REVIEW_WINDOW: i64 = 3_600;
pub const MAX_REVIEW_WINDOW: i64 = 14 * 86_400;
pub const DEFAULT_REVIEW_WINDOW: i64 = 2 * 86_400;

/// A nomination nobody accepts lapses, so an unresponsive nominee cannot park a
/// funded commission. Until it lapses the claim is exclusive, which is what
/// stops several agents from speculatively building the same thing.
pub const NOMINATION_WINDOW: i64 = 3 * 86_400;

pub const SEED_CONFIG: &[u8] = b"config";
pub const SEED_COMMISSION: &[u8] = b"commission";
pub const SEED_VAULT: &[u8] = b"vault";
pub const SEED_PLEDGE: &[u8] = b"pledge";

/// Account-type tags. A single byte at offset 0 of every account we own.
/// Without this, an attacker can pass a `Pledge` where a `Commission` is
/// expected and have borsh happily decode overlapping bytes into a different
/// meaning.
pub const TAG_CONFIG: u8 = 1;
pub const TAG_COMMISSION: u8 = 2;
pub const TAG_PLEDGE: u8 = 3;

// ───────────────────────────── errors ─────────────────────────────

#[derive(Debug, Clone, Copy)]
pub enum EscrowError {
    AlreadyInitialized = 0,
    NotInitialized = 1,
    Unauthorized = 2,
    BadPda = 3,
    BadOwner = 4,
    BadMint = 5,
    BadTokenProgram = 6,
    BadStatus = 7,
    MathOverflow = 8,
    GoalNotMet = 9,
    GoalAlreadyMet = 10,
    MilestoneAlreadyReleased = 11,
    BadMilestones = 12,
    NothingToRefund = 13,
    DeadlineNotPassed = 14,
    Paused = 15,
    AmountZero = 16,
    AgentAlreadySet = 17,
    AgentNotSet = 18,
    BadAccountTag = 19,
    InsufficientVault = 20,
    BadTreasury = 21,
    DeadlineInPast = 22,
    DeadlinePassed = 23,
    SelfDealing = 24,
    DeadlineTooFar = 25,
    GoalTooSmall = 26,
    NoPendingAgent = 27,
    NoSubmission = 28,
    ReviewWindowOpen = 29,
    BadWindow = 30,
    SubmissionPending = 31,
}

impl From<EscrowError> for ProgramError {
    fn from(e: EscrowError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

// ───────────────────────────── state ─────────────────────────────

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Config {
    pub tag: u8,
    /// May pause new pledges and new commissions. Deliberately CANNOT move
    /// escrowed SOL, change the fee, or seize a vault.
    pub admin: Pubkey,
    /// Wallet that receives the 1% SOL release fee.
    pub treasury: Pubkey,
    pub paused: bool,
    pub bump: u8,
}
impl Config {
    pub const LEN: usize = 1 + 32 + 32 + 1 + 1;
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// Accepting pledges.
    Funding,
    /// Goal met; agent may be selected.
    Funded,
    /// Agent selected; milestones may be released.
    Building,
    /// All milestones released.
    Delivered,
    /// Terminated. Remaining escrow is refundable.
    Cancelled,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Commission {
    pub tag: u8,
    pub creator: Pubkey,
    /// Reserved for layout compatibility with the original devnet program.
    pub mint: Pubkey,
    /// Snapshot of the treasury at creation time. Fees for this commission go
    /// here for its whole life, so a later config change cannot redirect fees
    /// on SOL that is already escrowed.
    pub treasury: Pubkey,
    pub seed: u64,
    pub goal: u64,
    /// Gross lamports pledged into escrow.
    pub total_pledged: u64,
    /// Gross lamports released against milestones (agent payout + fee).
    pub released: u64,
    /// Lamports refunded to backers, with no protocol fee.
    pub refunded: u64,
    /// Number of distinct pledge accounts and number already fully refunded.
    /// The last refunder receives integer-division dust, so no lamport can remain
    /// permanently stranded in a cancelled vault.
    pub pledger_count: u32,
    pub refunded_pledger_count: u32,
    pub agent: Pubkey,
    /// Creator-nominated agent; activated only by that wallet's signature.
    pub pending_agent: Pubkey,
    pub has_pending_agent: bool,
    pub has_agent: bool,
    pub status: Status,
    pub milestone_count: u8,
    /// Basis points per milestone. Must sum to exactly 10_000.
    pub milestone_bps: [u16; MAX_MILESTONES],
    /// Bitmap of released milestones; bit i == milestone i.
    pub milestones_done: u8,
    /// End of the funding phase.
    pub deadline: i64,
    pub bump: u8,
    pub vault_bump: u8,

    // ── delivery and review ──────────────────────────────────────────────
    /// Seconds the agent gets, counted from acceptance. Fixed at creation so an
    /// agent knows the terms before committing.
    pub delivery_window: i64,
    /// Absolute delivery deadline. Zero until an agent accepts.
    pub delivery_deadline: i64,
    /// Seconds a creator has to review a submission before anyone may release it.
    pub review_window: i64,
    /// When the current delivery was submitted. Zero means nothing is pending.
    pub submitted_at: i64,
    /// Which milestone the pending submission is for.
    pub submitted_index: u8,
    /// Hash of whatever the agent submitted as evidence — a commit, an artifact,
    /// a URL. The chain stores the commitment, never the content.
    pub evidence_hash: [u8; 32],
    /// When the standing nomination was made, so a stale claim can lapse.
    pub nominated_at: i64,
    /// Counters that make conduct legible. Both are monotonic and derived from
    /// actions the counterparty already took publicly.
    pub submissions: u8,
    pub rejections: u8,
    pub auto_releases: u8,
}
impl Commission {
    pub const LEN: usize = 1
        + 32
        + 32
        + 32
        + 8
        + 8
        + 8
        + 8
        + 8
        + 4
        + 4
        + 32
        + 32
        + 1
        + 1
        + 1
        + 1
        + (2 * MAX_MILESTONES)
        + 1
        + 8
        + 1
        + 1
        + 8
        + 8
        + 8
        + 8
        + 1
        + 32
        + 8
        + 1
        + 1
        + 1;

    /// Pledged lamports still owed by this commission.
    pub fn escrow_remaining(&self) -> Result<u64, ProgramError> {
        self.total_pledged
            .checked_sub(self.released)
            .and_then(|v| v.checked_sub(self.refunded))
            .ok_or_else(|| EscrowError::MathOverflow.into())
    }

    /// A submission is pending when it has been made and not yet resolved by a
    /// release or a rejection.
    pub fn has_pending_submission(&self) -> bool {
        self.submitted_at > 0
    }

    /// True once the creator's review window has elapsed on a pending
    /// submission, at which point anyone may release it on the agent's behalf.
    pub fn review_expired(&self, now: i64) -> bool {
        self.has_pending_submission() && now >= self.submitted_at.saturating_add(self.review_window)
    }

    /// Clears the pending submission. Called on release and on rejection.
    pub fn clear_submission(&mut self) {
        self.submitted_at = 0;
        self.submitted_index = 0;
        self.evidence_hash = [0u8; 32];
    }
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Pledge {
    pub tag: u8,
    pub commission: Pubkey,
    pub backer: Pubkey,
    /// Gross lamports this backer put into escrow, cumulative.
    pub amount: u64,
    /// Lamports already refunded to this backer.
    pub refunded: u64,
    pub fully_refunded: bool,
    pub bump: u8,
}
impl Pledge {
    pub const LEN: usize = 1 + 32 + 32 + 8 + 8 + 1 + 1;
}

// ───────────────────────────── fee math ─────────────────────────────

/// Split `gross` into (fee, net) at exactly `FEE_BPS`.
///
/// `fee + net == gross` for every input, by construction — `net` is computed by
/// subtraction, never by a second rounding. That is what makes the conservation
/// invariant hold: no dust can be created or destroyed by a split.
pub fn split_fee(gross: u64) -> Result<(u64, u64), ProgramError> {
    let fee = (gross as u128)
        .checked_mul(FEE_BPS as u128)
        .ok_or(EscrowError::MathOverflow)?
        / (BPS_DENOMINATOR as u128);
    let fee = u64::try_from(fee).map_err(|_| EscrowError::MathOverflow)?;
    let net = gross.checked_sub(fee).ok_or(EscrowError::MathOverflow)?;
    Ok((fee, net))
}

/// `total * numerator / denominator`, widened so the multiply cannot overflow.
pub fn mul_div(total: u64, numerator: u64, denominator: u64) -> Result<u64, ProgramError> {
    if denominator == 0 {
        return Err(EscrowError::MathOverflow.into());
    }
    let v = (total as u128)
        .checked_mul(numerator as u128)
        .ok_or(EscrowError::MathOverflow)?
        / (denominator as u128);
    u64::try_from(v).map_err(|_| EscrowError::MathOverflow.into())
}

// ───────────────────────────── instructions ─────────────────────────────

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum Instruction {
    /// 0. Create the singleton config PDA.
    /// Accounts: [payer(s,w)] [config(w)] [system_program]
    InitConfig { treasury: Pubkey },

    /// 1. Open a commission.
    /// Accounts: [creator(s,w)] [config] [commission(w)] [vault(w)] [system_program]
    CreateCommission {
        seed: u64,
        goal: u64,
        milestone_bps: Vec<u16>,
        /// End of the funding phase.
        deadline: i64,
        /// Seconds the agent gets once they accept. Zero selects the default.
        delivery_window: i64,
        /// Seconds the creator gets to review a delivery before anyone may
        /// release it. Zero selects the default.
        review_window: i64,
    },

    /// 2. Pledge native SOL into escrow.
    /// Accounts: [backer(s,w)] [config] [commission(w)] [pledge(w)] [vault(w)] [system_program]
    Pledge { amount: u64 },

    /// 3. Creator nominates an agent. Requires status == Funded.
    /// Accounts: [creator(s)] [commission(w)] [agent]
    SelectAgent,

    /// 4. Release a milestone slice from escrow.
    ///
    /// The creator may call this at any time. Anyone may call it once the
    /// review window on a submitted delivery has elapsed — that is what makes a
    /// silent creator pay rather than costing the agent their work.
    /// Accounts: [signer(s)] [commission(w)] [vault(w)] [agent(w)] [treasury(w)]
    ReleaseMilestone { index: u8 },

    /// 5. Backer withdraws their pro-rata share of whatever was never released.
    /// Accounts: [backer(s,w)] [commission(w)] [pledge(w)] [vault(w)]
    Refund,

    /// 6. Terminate. Creator any time before Delivered, or anyone once the
    ///    deadline has passed.
    /// Accounts: [signer(s)] [commission(w)]
    Cancel,

    /// 7. Admin pause switch. Blocks new commissions and new pledges only.
    /// Accounts: [admin(s)] [config(w)]
    SetPaused { paused: bool },

    /// 8. Nominated agent independently accepts the funded contract.
    /// Accounts: [agent(s)] [commission(w)]
    AcceptAgent,

    /// 9. Withdraw a nomination the nominee never accepted, so one unresponsive
    ///    counterparty cannot strand a successfully funded raise. The creator
    ///    may do this at will; anyone may once the nomination has lapsed.
    /// Accounts: [signer(s)] [commission(w)]
    RevokeAgent,

    /// 10. Agent submits a delivery for review, starting the review clock.
    ///
    /// `evidence_hash` is an opaque 32-byte commitment — a commit id, an
    /// artifact digest, a hash of a URL. The chain stores the commitment and
    /// never the content, so this cannot become a data-availability problem.
    /// Accounts: [agent(s)] [commission(w)]
    SubmitDelivery { index: u8, evidence_hash: [u8; 32] },

    /// 11. Creator rejects a submitted delivery, stopping the review clock and
    ///     recording the refusal publicly. The agent may submit again.
    /// Accounts: [creator(s)] [commission(w)]
    RejectDelivery,
}

// ───────────────────────────── helpers ─────────────────────────────

fn assert_signer(ai: &AccountInfo) -> ProgramResult {
    if !ai.is_signer {
        return Err(EscrowError::Unauthorized.into());
    }
    Ok(())
}

fn assert_owned_by_program(ai: &AccountInfo, program_id: &Pubkey) -> ProgramResult {
    if ai.owner != program_id {
        return Err(EscrowError::BadOwner.into());
    }
    Ok(())
}

/// Re-derive a PDA and require the passed account to match it exactly.
fn assert_pda(
    expected_seeds: &[&[u8]],
    program_id: &Pubkey,
    ai: &AccountInfo,
) -> Result<u8, ProgramError> {
    let (key, bump) = Pubkey::find_program_address(expected_seeds, program_id);
    if key != *ai.key {
        msg!("pda mismatch");
        return Err(EscrowError::BadPda.into());
    }
    Ok(bump)
}

fn load_commission(ai: &AccountInfo, program_id: &Pubkey) -> Result<Commission, ProgramError> {
    assert_owned_by_program(ai, program_id)?;
    let data = ai.try_borrow_data()?;
    if data.is_empty() || data[0] != TAG_COMMISSION {
        return Err(EscrowError::BadAccountTag.into());
    }
    Commission::try_from_slice(&data).map_err(|_| ProgramError::InvalidAccountData)
}

fn save<T: BorshSerialize>(ai: &AccountInfo, v: &T) -> ProgramResult {
    let mut d = ai.try_borrow_mut_data()?;
    let bytes = v.try_to_vec()?;
    if bytes.len() > d.len() {
        return Err(ProgramError::AccountDataTooSmall);
    }
    d[..bytes.len()].copy_from_slice(&bytes);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn create_pda_account<'a>(
    payer: &AccountInfo<'a>,
    new_account: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    program_id: &Pubkey,
    space: usize,
    seeds_with_bump: &[&[u8]],
) -> ProgramResult {
    let rent = Rent::get()?;
    let required = rent.minimum_balance(space);
    let current = new_account.lamports();

    if current == 0 {
        let ix = system_instruction::create_account(
            payer.key,
            new_account.key,
            required,
            space as u64,
            program_id,
        );
        return invoke_signed(
            &ix,
            &[payer.clone(), new_account.clone(), system_program.clone()],
            &[seeds_with_bump],
        );
    }

    // Every PDA address here is deterministic and therefore precomputable by a
    // stranger, who can grief the owner by sending 1 lamport to it first: the
    // system program refuses `create_account` on any funded account. Topping up
    // then allocating and assigning reaches an identical end state, so a
    // deliberate grief costs the attacker a lamport and changes nothing.
    if current < required {
        solana_program::program::invoke(
            &system_instruction::transfer(payer.key, new_account.key, required - current),
            &[payer.clone(), new_account.clone(), system_program.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(new_account.key, space as u64),
        &[new_account.clone(), system_program.clone()],
        &[seeds_with_bump],
    )?;
    invoke_signed(
        &system_instruction::assign(new_account.key, program_id),
        &[new_account.clone(), system_program.clone()],
        &[seeds_with_bump],
    )
}

// ───────────────────────────── entrypoint ─────────────────────────────

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let ix = Instruction::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)?;
    match ix {
        Instruction::InitConfig { treasury } => init_config(program_id, accounts, treasury),
        Instruction::CreateCommission {
            seed,
            goal,
            milestone_bps,
            deadline,
            delivery_window,
            review_window,
        } => create_commission(
            program_id,
            accounts,
            seed,
            goal,
            milestone_bps,
            deadline,
            delivery_window,
            review_window,
        ),
        Instruction::Pledge { amount } => pledge(program_id, accounts, amount),
        Instruction::SelectAgent => select_agent(program_id, accounts),
        Instruction::ReleaseMilestone { index } => release_milestone(program_id, accounts, index),
        Instruction::Refund => refund(program_id, accounts),
        Instruction::Cancel => cancel(program_id, accounts),
        Instruction::SetPaused { paused } => set_paused(program_id, accounts, paused),
        Instruction::AcceptAgent => accept_agent(program_id, accounts),
        Instruction::RevokeAgent => revoke_agent(program_id, accounts),
        Instruction::SubmitDelivery {
            index,
            evidence_hash,
        } => submit_delivery(program_id, accounts, index, evidence_hash),
        Instruction::RejectDelivery => reject_delivery(program_id, accounts),
    }
}

// 0 ── InitConfig ────────────────────────────────────────────────────
fn init_config(program_id: &Pubkey, accounts: &[AccountInfo], treasury: Pubkey) -> ProgramResult {
    let ai = &mut accounts.iter();
    let payer = next_account_info(ai)?;
    let config_ai = next_account_info(ai)?;
    let system_program = next_account_info(ai)?;

    assert_signer(payer)?;
    if *payer.key != INITIALIZER {
        return Err(EscrowError::Unauthorized.into());
    }
    if *system_program.key != solana_program::system_program::ID {
        return Err(EscrowError::BadOwner.into());
    }
    // The treasury is snapshotted into every commission created under this
    // config. A treasury that cannot receive lamports would make every release
    // fail permanently, so it is validated once, here, rather than discovered
    // later by a creator whose commission can never pay out.
    if treasury == Pubkey::default() || treasury == solana_program::system_program::ID {
        return Err(EscrowError::BadTreasury.into());
    }
    let bump = assert_pda(&[SEED_CONFIG], program_id, config_ai)?;

    // A non-empty config account means someone already ran this.
    if !config_ai.data_is_empty() {
        return Err(EscrowError::AlreadyInitialized.into());
    }

    create_pda_account(
        payer,
        config_ai,
        system_program,
        program_id,
        Config::LEN,
        &[SEED_CONFIG, &[bump]],
    )?;

    let cfg = Config {
        tag: TAG_CONFIG,
        admin: *payer.key,
        treasury,
        paused: false,
        bump,
    };
    save(config_ai, &cfg)?;
    msg!("config initialized");
    Ok(())
}

// 1 ── CreateCommission ──────────────────────────────────────────────
fn create_commission(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    seed: u64,
    goal: u64,
    milestone_bps: Vec<u16>,
    deadline: i64,
    delivery_window: i64,
    review_window: i64,
) -> ProgramResult {
    let ai = &mut accounts.iter();
    let creator = next_account_info(ai)?;
    let config_ai = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let vault_ai = next_account_info(ai)?;
    let system_program = next_account_info(ai)?;

    assert_signer(creator)?;
    if *system_program.key != solana_program::system_program::ID {
        return Err(EscrowError::BadOwner.into());
    }
    assert_owned_by_program(config_ai, program_id)?;
    assert_pda(&[SEED_CONFIG], program_id, config_ai)?;
    let cfg = {
        let d = config_ai.try_borrow_data()?;
        if d.is_empty() || d[0] != TAG_CONFIG {
            return Err(EscrowError::BadAccountTag.into());
        }
        Config::try_from_slice(&d).map_err(|_| ProgramError::InvalidAccountData)?
    };
    if cfg.paused {
        return Err(EscrowError::Paused.into());
    }
    // A goal below one basis-point unit lets an individual milestone slice floor
    // to zero lamports, which reverts and wedges the schedule short of Delivered.
    if goal < BPS_DENOMINATOR {
        return Err(EscrowError::GoalTooSmall.into());
    }
    let now = Clock::get()?.unix_timestamp;
    if deadline <= now {
        return Err(EscrowError::DeadlineInPast.into());
    }
    if deadline > now.saturating_add(MAX_FUNDING_DURATION) {
        return Err(EscrowError::DeadlineTooFar.into());
    }
    // Zero means "use the default", so a caller who does not care about these
    // terms still gets sane ones rather than a commission that can never move.
    let delivery_window = if delivery_window == 0 {
        DEFAULT_DELIVERY_WINDOW
    } else {
        delivery_window
    };
    let review_window = if review_window == 0 {
        DEFAULT_REVIEW_WINDOW
    } else {
        review_window
    };
    if !(MIN_DELIVERY_WINDOW..=MAX_DELIVERY_WINDOW).contains(&delivery_window)
        || !(MIN_REVIEW_WINDOW..=MAX_REVIEW_WINDOW).contains(&review_window)
    {
        return Err(EscrowError::BadWindow.into());
    }
    if milestone_bps.is_empty() || milestone_bps.len() > MAX_MILESTONES {
        return Err(EscrowError::BadMilestones.into());
    }
    let mut sum: u32 = 0;
    for b in &milestone_bps {
        if *b == 0 {
            return Err(EscrowError::BadMilestones.into());
        }
        sum = sum
            .checked_add(*b as u32)
            .ok_or(EscrowError::MathOverflow)?;
    }
    if sum as u64 != BPS_DENOMINATOR {
        return Err(EscrowError::BadMilestones.into());
    }

    let seed_bytes = seed.to_le_bytes();
    let c_bump = assert_pda(
        &[SEED_COMMISSION, creator.key.as_ref(), &seed_bytes],
        program_id,
        commission_ai,
    )?;
    if !commission_ai.data_is_empty() {
        return Err(EscrowError::AlreadyInitialized.into());
    }
    let v_bump = assert_pda(
        &[SEED_VAULT, commission_ai.key.as_ref()],
        program_id,
        vault_ai,
    )?;
    // The vault holds zero bytes for its whole life, so `data_is_empty()` is
    // always true here and cannot serve as the reinit guard. Ownership is the
    // property that actually changes: an initialised vault belongs to this
    // program, an uninitialised address still belongs to the system program.
    // A lamport balance proves nothing either way, since anyone may send to a
    // precomputable address, and create_pda_account absorbs that case.
    if vault_ai.owner != &solana_program::system_program::ID {
        return Err(EscrowError::AlreadyInitialized.into());
    }
    create_pda_account(
        creator,
        commission_ai,
        system_program,
        program_id,
        Commission::LEN,
        &[
            SEED_COMMISSION,
            creator.key.as_ref(),
            &seed_bytes,
            &[c_bump],
        ],
    )?;
    create_pda_account(
        creator,
        vault_ai,
        system_program,
        program_id,
        0,
        &[SEED_VAULT, commission_ai.key.as_ref(), &[v_bump]],
    )?;

    let mut bps = [0u16; MAX_MILESTONES];
    bps[..milestone_bps.len()].copy_from_slice(&milestone_bps);
    let c = Commission {
        tag: TAG_COMMISSION,
        creator: *creator.key,
        mint: Pubkey::default(),
        treasury: cfg.treasury,
        seed,
        goal,
        total_pledged: 0,
        released: 0,
        refunded: 0,
        pledger_count: 0,
        refunded_pledger_count: 0,
        agent: Pubkey::default(),
        pending_agent: Pubkey::default(),
        has_pending_agent: false,
        has_agent: false,
        status: Status::Funding,
        milestone_count: milestone_bps.len() as u8,
        milestone_bps: bps,
        milestones_done: 0,
        deadline,
        bump: c_bump,
        vault_bump: v_bump,
        delivery_window,
        delivery_deadline: 0,
        review_window,
        submitted_at: 0,
        submitted_index: 0,
        evidence_hash: [0u8; 32],
        nominated_at: 0,
        submissions: 0,
        rejections: 0,
        auto_releases: 0,
    };
    save(commission_ai, &c)?;
    msg!("SOL commission created");
    Ok(())
}

// 2 ── Pledge ────────────────────────────────────────────────────────
fn pledge(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let ai = &mut accounts.iter();
    let backer = next_account_info(ai)?;
    let config_ai = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let pledge_ai = next_account_info(ai)?;
    let vault_ai = next_account_info(ai)?;
    let system_program = next_account_info(ai)?;
    assert_signer(backer)?;
    if amount == 0 {
        return Err(EscrowError::AmountZero.into());
    }
    if *system_program.key != solana_program::system_program::ID {
        return Err(EscrowError::BadOwner.into());
    }
    assert_owned_by_program(config_ai, program_id)?;
    assert_pda(&[SEED_CONFIG], program_id, config_ai)?;
    let cfg = {
        let d = config_ai.try_borrow_data()?;
        if d.is_empty() || d[0] != TAG_CONFIG {
            return Err(EscrowError::BadAccountTag.into());
        }
        Config::try_from_slice(&d).map_err(|_| ProgramError::InvalidAccountData)?
    };
    if cfg.paused {
        return Err(EscrowError::Paused.into());
    }
    let mut c = load_commission(commission_ai, program_id)?;
    if c.status != Status::Funding {
        return Err(EscrowError::BadStatus.into());
    }
    // A commission at or past its deadline is already refundable. Accepting new
    // money into it would let pledges and refunds interleave in the same state,
    // which is what previously allowed a commission to enter Building with a
    // non-zero refunded balance and strand a milestone that could never be paid.
    if Clock::get()?.unix_timestamp >= c.deadline {
        return Err(EscrowError::DeadlinePassed.into());
    }
    assert_pda(
        &[SEED_VAULT, commission_ai.key.as_ref()],
        program_id,
        vault_ai,
    )?;
    if vault_ai.owner != program_id {
        return Err(EscrowError::BadOwner.into());
    }
    let p_bump = assert_pda(
        &[SEED_PLEDGE, commission_ai.key.as_ref(), backer.key.as_ref()],
        program_id,
        pledge_ai,
    )?;
    let new_pledger = pledge_ai.data_is_empty();
    let mut p = if new_pledger {
        create_pda_account(
            backer,
            pledge_ai,
            system_program,
            program_id,
            Pledge::LEN,
            &[
                SEED_PLEDGE,
                commission_ai.key.as_ref(),
                backer.key.as_ref(),
                &[p_bump],
            ],
        )?;
        Pledge {
            tag: TAG_PLEDGE,
            commission: *commission_ai.key,
            backer: *backer.key,
            amount: 0,
            refunded: 0,
            fully_refunded: false,
            bump: p_bump,
        }
    } else {
        assert_owned_by_program(pledge_ai, program_id)?;
        let d = pledge_ai.try_borrow_data()?;
        if d.is_empty() || d[0] != TAG_PLEDGE {
            return Err(EscrowError::BadAccountTag.into());
        }
        let existing = Pledge::try_from_slice(&d).map_err(|_| ProgramError::InvalidAccountData)?;
        if existing.commission != *commission_ai.key || existing.backer != *backer.key {
            return Err(EscrowError::BadPda.into());
        }
        existing
    };
    p.amount = p
        .amount
        .checked_add(amount)
        .ok_or(EscrowError::MathOverflow)?;
    c.total_pledged = c
        .total_pledged
        .checked_add(amount)
        .ok_or(EscrowError::MathOverflow)?;
    if new_pledger {
        c.pledger_count = c
            .pledger_count
            .checked_add(1)
            .ok_or(EscrowError::MathOverflow)?;
    }
    if c.total_pledged >= c.goal {
        c.status = Status::Funded;
    }
    save(pledge_ai, &p)?;
    save(commission_ai, &c)?;
    solana_program::program::invoke(
        &system_instruction::transfer(backer.key, vault_ai.key, amount),
        &[backer.clone(), vault_ai.clone(), system_program.clone()],
    )?;
    msg!("pledged {} lamports", amount);
    Ok(())
}

// 3 ── SelectAgent ───────────────────────────────────────────────────
fn select_agent(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let creator = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let agent = next_account_info(ai)?;

    assert_signer(creator)?;
    let mut c = load_commission(commission_ai, program_id)?;
    if c.creator != *creator.key {
        return Err(EscrowError::Unauthorized.into());
    }
    if c.has_agent || c.has_pending_agent {
        return Err(EscrowError::AgentAlreadySet.into());
    }
    if c.status != Status::Funded {
        return Err(EscrowError::GoalNotMet.into());
    }
    // The creator alone decides when milestones release. If the creator could
    // also be the payee, a commission funded by third parties would be a
    // one-signature path to draining every backer. A determined creator can
    // still route through a second wallet, which is why backers are told plainly
    // that they are trusting the named creator's judgement — but the naive,
    // one-click version of that theft is closed here.
    if *agent.key == c.creator {
        return Err(EscrowError::SelfDealing.into());
    }
    c.pending_agent = *agent.key;
    c.has_pending_agent = true;
    // Timestamping the claim is what lets it expire. An exclusive claim that
    // never lapses is just a different way to park a commission.
    c.nominated_at = Clock::get()?.unix_timestamp;
    save(commission_ai, &c)?;
    msg!("agent nominated");
    Ok(())
}

fn accept_agent(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let agent = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    assert_signer(agent)?;
    let mut c = load_commission(commission_ai, program_id)?;
    if c.status != Status::Funded || !c.has_pending_agent {
        return Err(EscrowError::BadStatus.into());
    }
    if c.pending_agent != *agent.key {
        return Err(EscrowError::Unauthorized.into());
    }
    // Accepting an expired commission would move already-refundable money into
    // Building, where the creator could still release it. Backers who consider
    // that commission dead must not have to race a late acceptance.
    if Clock::get()?.unix_timestamp >= c.deadline {
        return Err(EscrowError::DeadlinePassed.into());
    }
    c.agent = *agent.key;
    c.has_agent = true;
    c.has_pending_agent = false;
    c.status = Status::Building;
    // The delivery clock starts now, not at creation. An agent who accepts late
    // in a funding window gets the same time to work as one who accepts early.
    c.delivery_deadline = Clock::get()?
        .unix_timestamp
        .checked_add(c.delivery_window)
        .ok_or(EscrowError::MathOverflow)?;
    save(commission_ai, &c)?;
    msg!("agent accepted, delivery due {}", c.delivery_deadline);
    Ok(())
}

fn revoke_agent(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let signer = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    assert_signer(signer)?;
    let mut c = load_commission(commission_ai, program_id)?;
    // Only an unaccepted nomination may be withdrawn. Once an agent has signed,
    // their contract is theirs and only they can end it early.
    if c.has_agent || !c.has_pending_agent {
        return Err(EscrowError::NoPendingAgent.into());
    }
    // The creator may withdraw at will. Anyone may clear a claim that has gone
    // stale, so a nominee who never answers cannot hold the commission shut and
    // keep other agents from being considered.
    let lapsed = Clock::get()?.unix_timestamp >= c.nominated_at.saturating_add(NOMINATION_WINDOW);
    if c.creator != *signer.key && !lapsed {
        return Err(EscrowError::Unauthorized.into());
    }
    c.pending_agent = Pubkey::default();
    c.has_pending_agent = false;
    c.nominated_at = 0;
    save(commission_ai, &c)?;
    msg!("nomination withdrawn");
    Ok(())
}

// 10 ── SubmitDelivery ───────────────────────────────────────────────
//
// The chain previously had no idea whether work had happened; it only saw money
// move. That blind spot is exactly what made stiffing an agent free. Recording
// a delivery starts a clock that resolves to payment on silence.
fn submit_delivery(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    index: u8,
    evidence_hash: [u8; 32],
) -> ProgramResult {
    let ai = &mut accounts.iter();
    let agent = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    assert_signer(agent)?;
    let mut c = load_commission(commission_ai, program_id)?;
    if c.status != Status::Building || !c.has_agent {
        return Err(EscrowError::BadStatus.into());
    }
    if c.agent != *agent.key {
        return Err(EscrowError::Unauthorized.into());
    }
    if index as usize >= c.milestone_count as usize {
        return Err(EscrowError::BadMilestones.into());
    }
    if c.milestones_done & (1u8 << index) != 0 {
        return Err(EscrowError::MilestoneAlreadyReleased.into());
    }
    // Submitting after the delivery deadline is refused: past that point the
    // escrow is refundable, and letting a late submission reopen it would take
    // back a refund backers are already entitled to.
    if Clock::get()?.unix_timestamp >= c.delivery_deadline {
        return Err(EscrowError::DeadlinePassed.into());
    }
    // Re-submitting replaces the pending claim and restarts the review clock.
    // Only the agent can do that, and it only ever costs them time.
    c.submitted_at = Clock::get()?.unix_timestamp;
    c.submitted_index = index;
    c.evidence_hash = evidence_hash;
    c.submissions = c.submissions.saturating_add(1);
    save(commission_ai, &c)?;
    msg!("delivery submitted for milestone {}", index);
    Ok(())
}

// 11 ── RejectDelivery ───────────────────────────────────────────────
//
// A creator can still refuse work. What they can no longer do is refuse it
// silently and for free: rejection is an on-chain act attributable to their
// address, and it stops a clock that would otherwise have paid the agent.
fn reject_delivery(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let creator = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    assert_signer(creator)?;
    let mut c = load_commission(commission_ai, program_id)?;
    if c.creator != *creator.key {
        return Err(EscrowError::Unauthorized.into());
    }
    if !c.has_pending_submission() {
        return Err(EscrowError::NoSubmission.into());
    }
    // Once the window has elapsed the agent's claim has already matured; the
    // creator cannot retroactively cancel a release anyone is entitled to make.
    if c.review_expired(Clock::get()?.unix_timestamp) {
        return Err(EscrowError::ReviewWindowOpen.into());
    }
    c.clear_submission();
    c.rejections = c.rejections.saturating_add(1);
    save(commission_ai, &c)?;
    msg!("delivery rejected");
    Ok(())
}

// 4 ── ReleaseMilestone ──────────────────────────────────────────────
fn release_milestone(program_id: &Pubkey, accounts: &[AccountInfo], index: u8) -> ProgramResult {
    let ai = &mut accounts.iter();
    let signer = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let vault_ai = next_account_info(ai)?;
    let agent = next_account_info(ai)?;
    let treasury = next_account_info(ai)?;
    assert_signer(signer)?;
    let mut c = load_commission(commission_ai, program_id)?;
    if c.status != Status::Building || !c.has_agent {
        return Err(EscrowError::BadStatus.into());
    }
    // The creator may pay at any time, including before a formal submission —
    // paying early is never something to obstruct.
    //
    // Anyone else may only complete a release the agent has already earned: a
    // delivery for *this* milestone whose review window has run out. That is the
    // mechanism that converts creator silence into payment, and it deliberately
    // needs no arbiter, no oracle and no privileged caller.
    let now = Clock::get()?.unix_timestamp;
    let is_creator = c.creator == *signer.key;
    let matured = c.review_expired(now) && c.submitted_index == index;
    if !is_creator && !matured {
        return Err(EscrowError::ReviewWindowOpen.into());
    }
    if *agent.key != c.agent {
        return Err(EscrowError::BadOwner.into());
    }
    if *treasury.key != c.treasury {
        return Err(EscrowError::BadTreasury.into());
    }
    if index as usize >= c.milestone_count as usize {
        return Err(EscrowError::BadMilestones.into());
    }
    let bit = 1u8 << index;
    if c.milestones_done & bit != 0 {
        return Err(EscrowError::MilestoneAlreadyReleased.into());
    }
    assert_pda(
        &[SEED_VAULT, commission_ai.key.as_ref()],
        program_id,
        vault_ai,
    )?;
    if vault_ai.owner != program_id {
        return Err(EscrowError::BadOwner.into());
    }
    let all_mask = if c.milestone_count == 8 {
        u8::MAX
    } else {
        (1u8 << c.milestone_count) - 1
    };
    let completes_schedule = (c.milestones_done | bit) == all_mask;
    let gross = if completes_schedule {
        c.escrow_remaining()?
    } else {
        mul_div(
            c.total_pledged,
            c.milestone_bps[index as usize] as u64,
            BPS_DENOMINATOR,
        )?
    };
    if gross == 0 || gross > c.escrow_remaining()? {
        return Err(EscrowError::InsufficientVault.into());
    }
    let (fee, net) = split_fee(gross)?;
    c.milestones_done |= bit;
    c.released = c
        .released
        .checked_add(gross)
        .ok_or(EscrowError::MathOverflow)?;
    // Releasing settles whatever submission was outstanding for this milestone.
    if c.has_pending_submission() && c.submitted_index == index {
        if !is_creator {
            c.auto_releases = c.auto_releases.saturating_add(1);
        }
        c.clear_submission();
    }
    if completes_schedule {
        c.status = Status::Delivered;
    }
    save(commission_ai, &c)?;
    **vault_ai.try_borrow_mut_lamports()? = vault_ai
        .lamports()
        .checked_sub(gross)
        .ok_or(EscrowError::InsufficientVault)?;
    **agent.try_borrow_mut_lamports()? = agent
        .lamports()
        .checked_add(net)
        .ok_or(EscrowError::MathOverflow)?;
    **treasury.try_borrow_mut_lamports()? = treasury
        .lamports()
        .checked_add(fee)
        .ok_or(EscrowError::MathOverflow)?;
    msg!("milestone {} released net={} fee={}", index, net, fee);
    Ok(())
}

// 5 ── Refund ────────────────────────────────────────────────────────
fn refund(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let backer = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let pledge_ai = next_account_info(ai)?;
    let vault_ai = next_account_info(ai)?;
    assert_signer(backer)?;
    let mut c = load_commission(commission_ai, program_id)?;
    // A commission that met its goal and then expired without an agent holds
    // backer money exactly as a Funding one does. Requiring a third party to pay
    // for a Cancel first served no purpose.
    let now = Clock::get()?.unix_timestamp;
    // An agent who accepted and then delivered nothing leaves the escrow in
    // exactly the state an unfunded one is in, so it refunds on the same terms
    // once their delivery clock runs out.
    let delivery_expired = c.status == Status::Building && now >= c.delivery_deadline;
    let refundable = c.status == Status::Cancelled
        || (matches!(c.status, Status::Funding | Status::Funded) && now >= c.deadline)
        || delivery_expired;
    if !refundable {
        return Err(EscrowError::BadStatus.into());
    }
    // Work that has been delivered and not yet judged is not abandoned work.
    // Refunding around a live claim would hand the creator back the exact
    // free-work outcome the review clock exists to prevent.
    if c.has_pending_submission() && !c.review_expired(now) {
        return Err(EscrowError::SubmissionPending.into());
    }
    assert_pda(
        &[SEED_VAULT, commission_ai.key.as_ref()],
        program_id,
        vault_ai,
    )?;
    assert_pda(
        &[SEED_PLEDGE, commission_ai.key.as_ref(), backer.key.as_ref()],
        program_id,
        pledge_ai,
    )?;
    if vault_ai.owner != program_id {
        return Err(EscrowError::BadOwner.into());
    }
    assert_owned_by_program(pledge_ai, program_id)?;
    let mut p = {
        let d = pledge_ai.try_borrow_data()?;
        if d.is_empty() || d[0] != TAG_PLEDGE {
            return Err(EscrowError::BadAccountTag.into());
        }
        Pledge::try_from_slice(&d).map_err(|_| ProgramError::InvalidAccountData)?
    };
    if p.backer != *backer.key || p.commission != *commission_ai.key {
        return Err(EscrowError::Unauthorized.into());
    }
    if p.fully_refunded {
        return Err(EscrowError::NothingToRefund.into());
    }
    let never_released = c
        .total_pledged
        .checked_sub(c.released)
        .ok_or(EscrowError::MathOverflow)?;
    let is_last = c
        .refunded_pledger_count
        .checked_add(1)
        .ok_or(EscrowError::MathOverflow)?
        == c.pledger_count;
    let entitled = mul_div(never_released, p.amount, c.total_pledged)?;
    let amount = if is_last {
        c.escrow_remaining()?
    } else {
        entitled
            .checked_sub(p.refunded)
            .ok_or(EscrowError::MathOverflow)?
    };
    if amount > c.escrow_remaining()? {
        return Err(EscrowError::NothingToRefund.into());
    }
    // A dust-sized pledge can be entitled to exactly zero after flooring. That is
    // still a settled claim, and it must be recorded: refusing it would stop
    // `refunded_pledger_count` from ever reaching `pledger_count`, so the final
    // refunder's sweep would never fire and the remainder would strand forever.
    p.refunded = p
        .refunded
        .checked_add(amount)
        .ok_or(EscrowError::MathOverflow)?;
    p.fully_refunded = true;
    c.refunded = c
        .refunded
        .checked_add(amount)
        .ok_or(EscrowError::MathOverflow)?;
    c.refunded_pledger_count = c
        .refunded_pledger_count
        .checked_add(1)
        .ok_or(EscrowError::MathOverflow)?;
    save(pledge_ai, &p)?;
    save(commission_ai, &c)?;
    if amount > 0 {
        **vault_ai.try_borrow_mut_lamports()? = vault_ai
            .lamports()
            .checked_sub(amount)
            .ok_or(EscrowError::InsufficientVault)?;
        **backer.try_borrow_mut_lamports()? = backer
            .lamports()
            .checked_add(amount)
            .ok_or(EscrowError::MathOverflow)?;
    }
    msg!("refunded {} lamports, fee=0", amount);
    Ok(())
}

// 6 ── Cancel ────────────────────────────────────────────────────────
fn cancel(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let signer = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;

    assert_signer(signer)?;
    let mut c = load_commission(commission_ai, program_id)?;
    if c.status == Status::Delivered || c.status == Status::Cancelled {
        return Err(EscrowError::BadStatus.into());
    }
    let now = Clock::get()?.unix_timestamp;
    let is_creator = c.creator == *signer.key;
    // Before an agent accepts, the creator may cancel. After selection, neither
    // side can be rugged mid-build: cancellation opens only at the precommitted
    // deadline, by anyone.
    let creator_may_cancel = is_creator && matches!(c.status, Status::Funding | Status::Funded);
    // The contracted agent may always walk away. Surrendering their own claim
    // cannot harm backers — it only releases the remaining escrow for refund
    // immediately instead of making everyone wait out the deadline.
    let agent_may_walk_away = c.has_agent && c.agent == *signer.key && c.status == Status::Building;
    // Which clock has to have run depends on the phase. Once an agent is
    // building, the funding deadline is behind us and irrelevant; what matters
    // is whether they still have time left to deliver.
    let expiry = if c.status == Status::Building {
        c.delivery_deadline
    } else {
        c.deadline
    };
    if !creator_may_cancel && !agent_may_walk_away && now < expiry {
        return Err(EscrowError::DeadlineNotPassed.into());
    }
    // A delivery awaiting judgement blocks cancellation from every direction,
    // including the agent's own. Otherwise a creator could watch work land and
    // then cancel out from under it, which is precisely the theft this change
    // exists to stop. The escape hatch is not privileged: once the review window
    // lapses, anyone may release the milestone, and cancelling becomes possible
    // again afterwards.
    if c.has_pending_submission() && !c.review_expired(now) {
        return Err(EscrowError::SubmissionPending.into());
    }
    c.status = Status::Cancelled;
    save(commission_ai, &c)?;
    msg!("commission cancelled");
    Ok(())
}

// 7 ── SetPaused ─────────────────────────────────────────────────────
fn set_paused(program_id: &Pubkey, accounts: &[AccountInfo], paused: bool) -> ProgramResult {
    let ai = &mut accounts.iter();
    let admin = next_account_info(ai)?;
    let config_ai = next_account_info(ai)?;

    assert_signer(admin)?;
    assert_owned_by_program(config_ai, program_id)?;
    assert_pda(&[SEED_CONFIG], program_id, config_ai)?;
    let mut cfg = {
        let d = config_ai.try_borrow_data()?;
        if d.is_empty() || d[0] != TAG_CONFIG {
            return Err(EscrowError::BadAccountTag.into());
        }
        Config::try_from_slice(&d).map_err(|_| ProgramError::InvalidAccountData)?
    };
    if cfg.admin != *admin.key {
        return Err(EscrowError::Unauthorized.into());
    }
    cfg.paused = paused;
    save(config_ai, &cfg)?;
    Ok(())
}

// ───────────────────────────── unit tests ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_is_exactly_one_percent_and_conserves() {
        for gross in [0u64, 1, 99, 100, 101, 12_345, 1_000_000, u64::MAX / 2] {
            let (fee, net) = split_fee(gross).unwrap();
            assert_eq!(
                fee.checked_add(net).unwrap(),
                gross,
                "fee+net must equal gross"
            );
            assert_eq!(fee, ((gross as u128) * 100 / 10_000) as u64);
        }
    }

    #[test]
    fn fee_rounds_down_and_never_exceeds_gross() {
        // Sub-100 amounts pay zero fee rather than being rounded up into one.
        for gross in 0u64..100 {
            let (fee, net) = split_fee(gross).unwrap();
            assert_eq!(fee, 0);
            assert_eq!(net, gross);
        }
        let (fee, net) = split_fee(100).unwrap();
        assert_eq!((fee, net), (1, 99));
    }

    #[test]
    fn mul_div_does_not_overflow_at_u64_extremes() {
        let v = mul_div(u64::MAX, 1, 2).unwrap();
        assert_eq!(v, u64::MAX / 2);
        assert!(
            mul_div(u64::MAX, 2, 1).is_err(),
            "must reject results above u64"
        );
        assert!(mul_div(1, 1, 0).is_err(), "must reject zero denominator");
    }

    #[test]
    fn milestone_slices_never_exceed_the_pot() {
        let total: u64 = 1_000_000_007;
        let bps = [3000u64, 3000, 2500, 1500];
        let sum: u64 = bps
            .iter()
            .map(|b| mul_div(total, *b, BPS_DENOMINATOR).unwrap())
            .sum();
        assert!(
            sum <= total,
            "integer division must leave dust in the vault, never overdraw"
        );
        assert!(total - sum < 4, "dust bounded by one unit per milestone");
    }

    #[test]
    fn escrow_remaining_is_conserved() {
        let mut c = dummy_commission();
        c.total_pledged = 1_000;
        c.released = 300;
        c.refunded = 200;
        assert_eq!(c.escrow_remaining().unwrap(), 500);
        c.released = 900;
        assert!(
            c.escrow_remaining().is_err(),
            "must not underflow into a huge number"
        );
    }

    /// The production authority is selected by a feature flag, and an optimising
    /// build inlines it rather than storing it as a searchable literal. This is
    /// the only reliable way to prove which key a given artifact will trust.
    #[test]
    fn initializer_matches_the_target_network() {
        #[cfg(feature = "mainnet")]
        assert_eq!(
            INITIALIZER.to_string(),
            "AactHbz74TBh1nGkEMeHaAdpwUGQHqnBrKabZefLikYj",
            "a mainnet build must trust only the production authority"
        );
        #[cfg(not(feature = "mainnet"))]
        assert_eq!(
            INITIALIZER.to_string(),
            "4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY",
            "a default build must trust only the disposable devnet authority"
        );
    }

    /// The off-chain decoder and the documentation both hard-code this number,
    /// and a mismatch makes every commission silently undecodable rather than
    /// loudly broken. Pinning it here gives them something to check against.
    #[test]
    fn commission_account_size_is_pinned() {
        assert_eq!(
            Commission::LEN,
            316,
            "account size changed; update shared/escrow.js, the dataSize filters, and the layout tables"
        );
    }

    #[test]
    fn state_sizes_match_serialized_length() {
        let c = dummy_commission();
        assert_eq!(c.try_to_vec().unwrap().len(), Commission::LEN);
        let p = Pledge {
            tag: TAG_PLEDGE,
            commission: Pubkey::default(),
            backer: Pubkey::default(),
            amount: 0,
            refunded: 0,
            fully_refunded: false,
            bump: 0,
        };
        assert_eq!(p.try_to_vec().unwrap().len(), Pledge::LEN);
        let cfg = Config {
            tag: TAG_CONFIG,
            admin: Pubkey::default(),
            treasury: Pubkey::default(),
            paused: false,
            bump: 0,
        };
        assert_eq!(cfg.try_to_vec().unwrap().len(), Config::LEN);
    }

    fn dummy_commission() -> Commission {
        Commission {
            tag: TAG_COMMISSION,
            creator: Pubkey::default(),
            mint: Pubkey::default(),
            treasury: Pubkey::default(),
            seed: 0,
            goal: 0,
            total_pledged: 0,
            released: 0,
            refunded: 0,
            pledger_count: 0,
            refunded_pledger_count: 0,
            agent: Pubkey::default(),
            pending_agent: Pubkey::default(),
            has_pending_agent: false,
            has_agent: false,
            status: Status::Funding,
            milestone_count: 4,
            milestone_bps: [3000, 3000, 2500, 1500, 0, 0, 0, 0],
            milestones_done: 0,
            deadline: 0,
            bump: 0,
            vault_bump: 0,
            delivery_window: DEFAULT_DELIVERY_WINDOW,
            delivery_deadline: 0,
            review_window: DEFAULT_REVIEW_WINDOW,
            submitted_at: 0,
            submitted_index: 0,
            evidence_hash: [0u8; 32],
            nominated_at: 0,
            submissions: 0,
            rejections: 0,
            auto_releases: 0,
        }
    }

    #[test]
    fn review_clock_matures_exactly_once_the_window_elapses() {
        let mut c = dummy_commission();
        assert!(!c.has_pending_submission(), "nothing pending by default");
        assert!(
            !c.review_expired(i64::MAX),
            "an absent submission can never mature into a payable claim"
        );

        c.submitted_at = 1_000;
        c.review_window = 100;
        assert!(c.has_pending_submission());
        assert!(!c.review_expired(1_099), "still inside the review window");
        assert!(c.review_expired(1_100), "the boundary itself is payable");
        assert!(c.review_expired(2_000));

        c.clear_submission();
        assert!(!c.has_pending_submission());
        assert!(!c.review_expired(i64::MAX));
        assert_eq!(c.evidence_hash, [0u8; 32]);
    }

    #[test]
    fn clock_bounds_are_ordered_and_sane_for_agents() {
        // Agents deliver in hours, so the floors have to permit that.
        assert!(MIN_DELIVERY_WINDOW <= DEFAULT_DELIVERY_WINDOW);
        assert!(DEFAULT_DELIVERY_WINDOW <= MAX_DELIVERY_WINDOW);
        assert!(MIN_REVIEW_WINDOW <= DEFAULT_REVIEW_WINDOW);
        assert!(DEFAULT_REVIEW_WINDOW <= MAX_REVIEW_WINDOW);
        assert_eq!(MIN_DELIVERY_WINDOW, 3_600, "one hour must be expressible");
        assert_eq!(MIN_REVIEW_WINDOW, 3_600);
        // The worst case a backer's SOL can be locked is both phases back to back.
        assert_eq!(
            MAX_FUNDING_DURATION + MAX_DELIVERY_WINDOW,
            60 * 86_400,
            "total lock must stay far below the old 180-day ceiling"
        );
    }
}

//! GitStarter escrow — milestone-gated escrow for crowdfunded agent commissions.
//!
//! ## The mechanism
//!
//! Backers pledge native SOL into a per-commission PDA vault. SOL does NOT go
//! to the agent until milestones are accepted.
//!
//! A fixed 1.00% fee is charged for the CONNECTION, not the outcome: it applies
//! once an agent has actually submitted a delivery, and then to every lamport
//! leaving escrow, whether by release or by refund. A commission that never
//! received a delivery refunds in full and costs nothing. This is what stops a
//! creator saving money by refusing work rather than approving it.
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

/// Ceiling on the funding phase.
///
/// The worst-case time a backer's SOL can be held is the sum of every clock:
/// MAX_FUNDING_DURATION + MAX_DELIVERY_WINDOW + MAX_REVIEW_WINDOW +
/// CLAIM_GRACE_WINDOW = 75 days, reached only by choosing every window at its
/// maximum and submitting a delivery immediately before the delivery deadline.
/// Typical settings are days, not months.
pub const MAX_FUNDING_DURATION: i64 = 30 * 86_400;

/// How long the board stays open for work, measured from the moment the goal is
/// met. Nobody has to be chosen for the clock to start: a funded commission is
/// workable by anyone, so the window begins when the money is there.
pub const MIN_WORK_WINDOW: i64 = 3_600;
pub const MAX_WORK_WINDOW: i64 = 30 * 86_400;
pub const DEFAULT_WORK_WINDOW: i64 = 3 * 86_400;

/// How long a creator has to review a submitted delivery before anyone may
/// release it on the agent's behalf. Chosen by the creator at creation time and
/// visible to the agent before they accept, so it is a disclosed term rather
/// than a surprise.
pub const MIN_REVIEW_WINDOW: i64 = 3_600;
pub const MAX_REVIEW_WINDOW: i64 = 14 * 86_400;
pub const DEFAULT_REVIEW_WINDOW: i64 = 2 * 86_400;

/// Ceiling on how many submissions one milestone will accept.
///
/// Competition is the point, so this is deliberately generous. It exists only so
/// that a per-milestone counter cannot be driven past what its type can hold,
/// and so a creator's review queue has a knowable worst case.
pub const MAX_SUBMISSIONS_PER_MILESTONE: u8 = 32;

/// How long a matured, unclaimed delivery stays protected from refunds.
///
/// A submission made late in the delivery phase can mature *after* the delivery
/// deadline, at which point both "anyone may release to the agent" and "backers
/// may refund" are true at once, and whoever transacts first wins. An agent who
/// genuinely delivered should not lose a race to a fast backer, so their claim
/// holds for this long. It is deliberately bounded: an unclaimed milestone must
/// eventually release the escrow, or a silent agent could lock it forever.
pub const CLAIM_GRACE_WINDOW: i64 = 86_400;

pub const SEED_CONFIG: &[u8] = b"config";
pub const SEED_COMMISSION: &[u8] = b"commission";
pub const SEED_VAULT: &[u8] = b"vault";
pub const SEED_PLEDGE: &[u8] = b"pledge";
pub const SEED_SUBMISSION: &[u8] = b"submission";
pub const SEED_INTENT: &[u8] = b"intent";
pub const SEED_HANDLE: &[u8] = b"handle";

/// Account-type tags. A single byte at offset 0 of every account we own.
/// Without this, an attacker can pass a `Pledge` where a `Commission` is
/// expected and have borsh happily decode overlapping bytes into a different
/// meaning.
pub const TAG_CONFIG: u8 = 1;
pub const TAG_COMMISSION: u8 = 2;
pub const TAG_PLEDGE: u8 = 3;
pub const TAG_SUBMISSION: u8 = 4;
pub const TAG_INTENT: u8 = 5;
pub const TAG_HANDLE: u8 = 6;

/// A handle is at most 32 bytes because that is the maximum length of a single
/// PDA seed, and the handle IS the seed. Everything else about this design
/// follows from that choice.
pub const MAX_HANDLE_LEN: usize = 32;
pub const MIN_HANDLE_LEN: usize = 3;

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
    NotSettled = 32,
    /// A submission exists, but an older one on the same milestone has not been
    /// dealt with yet. First delivered, first judged.
    OutOfTurn = 33,
    /// This commission was restricted to one invited agent.
    NotInvited = 34,
    /// The milestone has taken as many submissions as it will accept.
    TooManySubmissions = 35,
    /// The window for doing the work has closed.
    WorkWindowClosed = 36,
    /// Not a name this program will accept: wrong length, a character outside
    /// lower-case ASCII, a leading or trailing hyphen, or a string shaped like a
    /// wallet address.
    BadHandle = 37,
    /// Somebody already holds it. Names are first-come and permanent.
    HandleTaken = 38,
}

/// Base58 as Solana uses it: no 0, O, I or l, precisely so that an address
/// cannot be misread. Used here to refuse names that are shaped like keys.
const BASE58_ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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
    /// Goal met. The work is on the board and anyone may deliver it.
    ///
    /// There is deliberately no "assigned" state between this and Delivered.
    /// Nobody is chosen, so nothing has to happen before work can start.
    Funded,
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
    /// Lamports debited from escrow by refunds, GROSS of the connection fee.
    ///
    /// When `submissions > 0` the backer receives 99% of this and the treasury
    /// takes 1%, so an off-chain consumer must not read this as "what backers
    /// received". It is the amount that left the vault, which is what the
    /// conservation invariant is stated over.
    pub refunded: u64,
    /// Number of distinct pledge accounts and number already fully refunded.
    /// The last refunder receives integer-division dust, so no lamport can remain
    /// permanently stranded in a cancelled vault.
    pub pledger_count: u32,
    pub refunded_pledger_count: u32,
    /// Optional restriction to a single agent.
    ///
    /// A commission is OPEN by default: funded means workable, by anyone, with
    /// no permission step in between. That is the whole point of the board. A
    /// creator who already knows who they want can set this, but it is a
    /// deliberate narrowing of the market rather than the default path.
    pub invited_agent: Pubkey,
    pub has_invite: bool,
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

    // ── work and review ──────────────────────────────────────────────────
    /// Seconds the board stays open for work once the goal is met. Fixed at
    /// creation, so an agent knows the terms before spending anything.
    pub work_window: i64,
    /// Absolute end of the work phase. Zero until the goal is met.
    pub work_deadline: i64,
    /// Seconds a creator has to judge a submission once it becomes the one at
    /// the front of the queue.
    pub review_window: i64,

    // ── the competition ledger ───────────────────────────────────────────
    //
    // Submissions live in their own accounts, so the number of competing agents
    // is not bounded by what fits here. These counters are what make judging
    // order enforceable in constant time.
    /// Submissions ever made against each milestone.
    pub milestone_submitted: [u8; MAX_MILESTONES],
    /// Submissions rejected on each milestone. The submission at the front of
    /// the queue for milestone `i` is the one whose sequence equals this, which
    /// is what makes "first delivered, first judged" checkable in O(1).
    pub milestone_rejected: [u8; MAX_MILESTONES],
    /// Submissions neither released nor rejected, across every milestone.
    pub unresolved_submissions: u32,
    /// When the newest submission landed, so an exit can be blocked while work
    /// is still awaiting judgement without scanning every submission account.
    pub latest_submitted_at: i64,

    /// Counters that make conduct legible. All monotonic, all derived from acts
    /// the parties already took publicly.
    pub submissions: u32,
    pub rejections: u32,
    pub auto_releases: u32,
    /// Agents who said they were working on this. Non-binding by design: the
    /// signal is worth something only because failing to follow it is visible.
    pub intents: u32,
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
        + MAX_MILESTONES
        + MAX_MILESTONES
        + 4
        + 8
        + 4
        + 4
        + 4
        + 4;

    /// Pledged lamports still owed by this commission.
    pub fn escrow_remaining(&self) -> Result<u64, ProgramError> {
        self.total_pledged
            .checked_sub(self.released)
            .and_then(|v| v.checked_sub(self.refunded))
            .ok_or_else(|| EscrowError::MathOverflow.into())
    }

    /// Work that has been delivered and not yet judged blocks every exit.
    ///
    /// Bounded by construction: the newest submission's own review window and
    /// grace period always run out, and once they do anyone may push the queue
    /// forward by releasing whatever matured. So this can delay an exit, never
    /// prevent one.
    pub fn claim_protected(&self, now: i64) -> bool {
        self.unresolved_submissions > 0
            && now
                < self
                    .latest_submitted_at
                    .saturating_add(self.review_window)
                    .saturating_add(CLAIM_GRACE_WINDOW)
    }

    /// The work phase is over once the window set at funding time has run out.
    pub fn work_closed(&self, now: i64) -> bool {
        self.work_deadline > 0 && now >= self.work_deadline
    }

    fn milestone_bit(index: u8) -> u8 {
        1u8 << index
    }

    pub fn milestone_released(&self, index: u8) -> bool {
        self.milestones_done & Self::milestone_bit(index) != 0
    }
}

/// One agent's delivery against one milestone.
///
/// Submissions get their own accounts so that any number of agents can compete
/// for the same milestone without the commission account growing. The rent is
/// paid by the agent who submits and comes back when the submission settles,
/// which also means a spammer funds their own noise.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub enum SubmissionState {
    /// Delivered and awaiting judgement.
    Pending,
    /// Judged good; this is the submission that was paid.
    Released,
    /// Judged not good enough. Public, attributable, and counted.
    Rejected,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Submission {
    pub tag: u8,
    pub commission: Pubkey,
    pub agent: Pubkey,
    pub milestone_index: u8,
    /// Position in this milestone's queue, assigned at submission time.
    ///
    /// The submission that may be judged next is the one whose sequence equals
    /// the milestone's rejected count. That single comparison is what enforces
    /// "first delivered, first judged" without walking a list.
    pub sequence: u8,
    pub submitted_at: i64,
    /// SHA-256 of whatever was delivered. The chain holds the commitment; the
    /// content itself lives off chain, verified against this.
    pub evidence_hash: [u8; 32],
    pub state: SubmissionState,
    pub bump: u8,
}
impl Submission {
    pub const LEN: usize = 1 + 32 + 32 + 1 + 1 + 8 + 32 + 1 + 1;

    /// True once anyone may release this on the agent's behalf.
    ///
    /// The clock runs from this submission's own arrival, so every competitor
    /// gets the same window on their own work rather than inheriting whatever
    /// was left of somebody else's.
    pub fn review_expired(&self, now: i64, review_window: i64) -> bool {
        self.state == SubmissionState::Pending
            && now >= self.submitted_at.saturating_add(review_window)
    }
}

/// A non-binding declaration that an agent is working on a commission.
///
/// The protocol enforces nothing here on purpose: signalling reserves nothing,
/// blocks nobody, and costs only rent. Its value is entirely reputational — it
/// tells other agents how much competition they are walking into, and an agent
/// who signals and never delivers leaves a public record of having done so.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Intent {
    pub tag: u8,
    pub commission: Pubkey,
    pub agent: Pubkey,
    pub signalled_at: i64,
    /// Retracted honestly rather than simply abandoned. Withdrawing is free and
    /// carries no penalty; going silent is what a reputation reader can see.
    pub withdrawn: bool,
    pub bump: u8,
}
impl Intent {
    pub const LEN: usize = 1 + 32 + 32 + 8 + 1 + 1;
}

/// A name, bound to one wallet, permanently.
///
/// This lives on chain rather than in our database for one reason: it is the
/// only piece of identity that cannot be rebuilt by reading the program. A
/// commission, a delivery, a reputation figure — all of those are derivable from
/// chain state by anybody. A name held only in SQLite is a name that disappears
/// with the server, and with it the guarantee that stops somebody inheriting a
/// reputation they did not earn.
///
/// **Uniqueness is the address, not a check.** The PDA is derived from the
/// handle itself, so two wallets cannot hold the same name in the same way that
/// two accounts cannot share an address. There is no constraint here that could
/// be removed by a later edit, and no index that could be dropped.
///
/// **There is deliberately no CloseHandle.** Renaming frees nothing. If a claim
/// could be released, an agent could build a record under one name, move on, and
/// leave that name for a stranger to pick up and be mistaken for — at exactly
/// the moment a creator is deciding whom to trust with escrow. The rent is the
/// price of that guarantee and it is not refundable, which is the point.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct HandleClaim {
    pub tag: u8,
    /// The wallet this name belongs to, for good.
    pub wallet: Pubkey,
    /// Lower-cased, left-aligned, zero-padded. Fixed width because it is a PDA
    /// seed and seeds are raw bytes.
    pub handle: [u8; MAX_HANDLE_LEN],
    pub len: u8,
    pub claimed_at: i64,
    pub bump: u8,
}
impl HandleClaim {
    pub const LEN: usize = 1 + 32 + MAX_HANDLE_LEN + 1 + 8 + 1;
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
        /// Seconds the board stays open for work once funded. Zero selects the
        /// default.
        work_window: i64,
        /// Seconds the creator gets to review a delivery before anyone may
        /// release it. Zero selects the default.
        review_window: i64,
    },

    /// 2. Pledge native SOL into escrow.
    /// Accounts: [backer(s,w)] [config] [commission(w)] [pledge(w)] [vault(w)] [system_program]
    Pledge { amount: u64 },

    /// 3. OPTIONAL: restrict this commission to a single invited agent.
    ///
    /// A commission is open by default and needs nothing from the creator for
    /// work to begin. This exists for the case where a creator already knows
    /// who they want, and is a deliberate narrowing of the market. Passing the
    /// creator's own key clears the restriction and reopens the board.
    /// Accounts: [creator(s)] [commission(w)] [agent]
    InviteAgent,

    /// 4. Pay a submission and close out its milestone.
    ///
    /// The creator may call this at any time. Anyone may call it once that
    /// submission's review window has elapsed, which is what makes a silent
    /// creator pay rather than costing the agent their work.
    ///
    /// The submission must be the one at the front of its milestone's queue, so
    /// a creator cannot quietly skip past earlier deliveries to a favourite.
    /// Accounts: [signer(s)] [commission(w)] [submission(w)] [vault(w)] [agent(w)] [treasury(w)]
    ReleaseMilestone,

    /// 5. Backer withdraws their pro-rata share of whatever was never released.
    ///
    /// Charges the 1% connection fee if any delivery was ever submitted, and
    /// nothing at all if none was.
    /// Accounts: [backer(s,w)] [commission(w)] [pledge(w)] [vault(w)] [treasury(w)]
    Refund,

    /// 6. Terminate. Creator any time before Delivered, or anyone once the
    ///    deadline has passed.
    /// Accounts: [signer(s)] [commission(w)]
    Cancel,

    /// 7. Admin pause switch. Blocks new commissions and new pledges only.
    /// Accounts: [admin(s)] [config(w)]
    SetPaused { paused: bool },

    /// 8. Declare that you are working on this. Non-binding.
    ///
    /// Reserves nothing and blocks nobody: anyone else may still submit, and
    /// signalling confers no priority whatsoever. It exists so agents can see
    /// how much competition they are walking into before spending compute, and
    /// so that saying you will do something and then not doing it is a matter
    /// of public record.
    /// Accounts: [agent(s,w)] [commission(w)] [intent(w)] [system_program]
    SignalIntent,

    /// 9. Retract a declaration of intent, honestly and for free.
    ///
    /// Going quiet and withdrawing look identical to the protocol and very
    /// different to anyone reading a reputation record, which is the point.
    /// Accounts: [agent(s)] [commission(w)] [intent(w)]
    WithdrawIntent,

    /// 10. Deliver work against a milestone. Open to anyone.
    ///
    /// No permission, no claim, no assignment: if the commission is funded and
    /// the work window is open, any agent may submit. Several may compete on
    /// the same milestone, and the first one judged good is paid.
    ///
    /// `evidence_hash` is an opaque 32-byte commitment — a commit id, an
    /// artifact digest, a hash of a URL. The chain stores the commitment and
    /// never the content, so this cannot become a data-availability problem.
    /// Accounts: [agent(s,w)] [commission(w)] [submission(w)] [system_program]
    SubmitDelivery { index: u8, evidence_hash: [u8; 32] },

    /// 11. Creator rejects the submission at the front of a milestone's queue.
    ///
    /// Recorded publicly and counted against the creator. Rejecting advances
    /// the queue, so the next delivery in line becomes judgeable.
    /// Accounts: [creator(s)] [commission(w)] [submission(w)]
    RejectDelivery,

    /// 12. Returns a pledge account's rent once it can never be used again.
    ///
    /// Anyone may send this; the lamports always go to the backer recorded in
    /// the account, so it can be bundled into whatever transaction settles the
    /// commission rather than waiting for that backer to come back and ask.
    ///
    /// A refund already closes the pledge it settles. This covers the other
    /// ending: a commission that shipped, where every lamport was released to
    /// the agent and no backer will ever call Refund, so the account would
    /// otherwise sit on chain holding rent forever.
    /// Accounts: [backer(w)] [commission(w)] [pledge(w)]
    ClosePledge,

    /// 13. Returns the vault's rent reserve to the creator once the escrow is
    ///     empty and no further movement is possible.
    ///
    /// Anyone may call it; the lamports always go to the creator who paid for
    /// the account, so there is nothing to gain by racing it.
    /// Accounts: [signer(s)] [commission(w)] [vault(w)] [creator(w)]
    CloseVault,

    /// 14. Returns a settled submission's rent to the agent who delivered it.
    ///
    /// Losing a race should not cost anything beyond the compute already spent,
    /// so a rejected or superseded submission gives its deposit straight back.
    /// Anyone may send this; it always pays the agent named on the submission.
    /// Accounts: [agent(w)] [commission(w)] [submission(w)]
    CloseSubmission,

    /// 15. Returns an intent's deposit once the commission is settled.
    ///
    /// Anyone may send this; it always pays the agent named on the intent.
    /// Accounts: [agent(w)] [commission(w)] [intent(w)]
    CloseIntent,
    /// 16. Claim a name, permanently, for the signing wallet.
    ///
    /// `handle` must already be lower-cased; the program refuses anything else
    /// rather than normalising it, because the handle is the PDA seed and a
    /// program that quietly accepted "Alice" would create an account at a
    /// different address from "alice" — two live claims on one name, which is
    /// precisely what this exists to prevent.
    ///
    /// There is no matching close or transfer. A name is bound for the life of
    /// the program.
    /// Accounts: [wallet(s,w)] [claim(w)] [system_program]
    ClaimHandle { handle: Vec<u8> },
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

/// Drains a program-owned account to `destination` and blanks it, so the runtime
/// reclaims it when the transaction ends and its rent goes back to whoever paid.
///
/// The data is zeroed rather than merely abandoned. Every load in this program
/// checks a tag byte first, so clearing it means an account closed earlier in a
/// transaction cannot be read back as a live one later in that same transaction.
fn close_account(account: &AccountInfo, destination: &AccountInfo) -> ProgramResult {
    let reclaimed = account.lamports();
    **account.try_borrow_mut_lamports()? = 0;
    **destination.try_borrow_mut_lamports()? = destination
        .lamports()
        .checked_add(reclaimed)
        .ok_or(EscrowError::MathOverflow)?;
    let mut data = account.try_borrow_mut_data()?;
    for byte in data.iter_mut() {
        *byte = 0;
    }
    Ok(())
}

fn load_submission(ai: &AccountInfo, program_id: &Pubkey) -> Result<Submission, ProgramError> {
    assert_owned_by_program(ai, program_id)?;
    let data = ai.try_borrow_data()?;
    if data.is_empty() || data[0] != TAG_SUBMISSION {
        return Err(EscrowError::BadAccountTag.into());
    }
    Submission::try_from_slice(&data).map_err(|_| ProgramError::InvalidAccountData)
}

/// Loads a submission and proves it belongs to this commission.
///
/// The milestone index and agent are read back OUT of the account and used to
/// re-derive its address, so a caller cannot present some other commission's
/// submission, or one whose fields disagree with where it lives.
fn load_submission_for(
    _c: &Commission,
    commission_ai: &AccountInfo,
    submission_ai: &AccountInfo,
    program_id: &Pubkey,
) -> Result<Submission, ProgramError> {
    let submission = load_submission(submission_ai, program_id)?;
    if submission.commission != *commission_ai.key {
        return Err(EscrowError::BadPda.into());
    }
    assert_pda(
        &[
            SEED_SUBMISSION,
            commission_ai.key.as_ref(),
            &[submission.milestone_index],
            submission.agent.as_ref(),
        ],
        program_id,
        submission_ai,
    )?;
    Ok(submission)
}

fn load_intent(ai: &AccountInfo, program_id: &Pubkey) -> Result<Intent, ProgramError> {
    assert_owned_by_program(ai, program_id)?;
    let data = ai.try_borrow_data()?;
    if data.is_empty() || data[0] != TAG_INTENT {
        return Err(EscrowError::BadAccountTag.into());
    }
    Intent::try_from_slice(&data).map_err(|_| ProgramError::InvalidAccountData)
}

/// The one gate that decides whether an agent may work on a commission.
///
/// Deliberately short, because the answer is meant to be short: if the money is
/// there and the clock is running, anyone may work. There is no claim to check,
/// no assignment to look up and no permission to have been granted. The only
/// exception is a commission the creator explicitly narrowed to one agent.
fn assert_workable(c: &Commission, agent: &Pubkey, now: i64) -> ProgramResult {
    if c.status != Status::Funded {
        return Err(EscrowError::BadStatus.into());
    }
    if c.work_closed(now) {
        return Err(EscrowError::WorkWindowClosed.into());
    }
    // A creator who could also be paid would be a one-signature path to draining
    // backers, so they cannot deliver their own commission.
    if *agent == c.creator {
        return Err(EscrowError::SelfDealing.into());
    }
    if c.has_invite && c.invited_agent != *agent {
        return Err(EscrowError::NotInvited.into());
    }
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
            work_window,
            review_window,
        } => create_commission(
            program_id,
            accounts,
            seed,
            goal,
            milestone_bps,
            deadline,
            work_window,
            review_window,
        ),
        Instruction::Pledge { amount } => pledge(program_id, accounts, amount),
        Instruction::InviteAgent => invite_agent(program_id, accounts),
        Instruction::ReleaseMilestone => release_milestone(program_id, accounts),
        Instruction::Refund => refund(program_id, accounts),
        Instruction::Cancel => cancel(program_id, accounts),
        Instruction::SetPaused { paused } => set_paused(program_id, accounts, paused),
        Instruction::SignalIntent => signal_intent(program_id, accounts),
        Instruction::WithdrawIntent => withdraw_intent(program_id, accounts),
        Instruction::SubmitDelivery {
            index,
            evidence_hash,
        } => submit_delivery(program_id, accounts, index, evidence_hash),
        Instruction::RejectDelivery => reject_delivery(program_id, accounts),
        Instruction::ClosePledge => close_pledge(program_id, accounts),
        Instruction::CloseVault => close_vault(program_id, accounts),
        Instruction::CloseSubmission => close_submission(program_id, accounts),
        Instruction::CloseIntent => close_intent(program_id, accounts),
        Instruction::ClaimHandle { handle } => claim_handle(program_id, accounts, handle),
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
    work_window: i64,
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
    let work_window = if work_window == 0 {
        DEFAULT_WORK_WINDOW
    } else {
        work_window
    };
    let review_window = if review_window == 0 {
        DEFAULT_REVIEW_WINDOW
    } else {
        review_window
    };
    if !(MIN_WORK_WINDOW..=MAX_WORK_WINDOW).contains(&work_window)
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
        // Open by default. A creator who wants a specific agent has to say so
        // deliberately, with InviteAgent; the board is the normal path.
        invited_agent: Pubkey::default(),
        has_invite: false,
        status: Status::Funding,
        milestone_count: milestone_bps.len() as u8,
        milestone_bps: bps,
        milestones_done: 0,
        deadline,
        bump: c_bump,
        vault_bump: v_bump,
        work_window,
        work_deadline: 0,
        review_window,
        milestone_submitted: [0u8; MAX_MILESTONES],
        milestone_rejected: [0u8; MAX_MILESTONES],
        unresolved_submissions: 0,
        latest_submitted_at: 0,
        submissions: 0,
        rejections: 0,
        auto_releases: 0,
        intents: 0,
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
        // A settled pledge is a closed chapter. Topping one up would let a stale
        // record from an earlier commission at this address be inflated, so the
        // only thing to do with it is refuse.
        if existing.fully_refunded {
            return Err(EscrowError::NothingToRefund.into());
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
    if c.total_pledged >= c.goal && c.status == Status::Funding {
        c.status = Status::Funded;
        // The work clock starts here, not at some later acceptance, because
        // there is no acceptance: the moment the money is there, the job is on
        // the board and anyone may start. Nothing has to happen in between.
        c.work_deadline = Clock::get()?
            .unix_timestamp
            .checked_add(c.work_window)
            .ok_or(EscrowError::MathOverflow)?;
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

// 3 ── InviteAgent ─────────────────────────────────────────────────
//
// A commission is OPEN by default. This exists only for the creator who already
// knows who they want, and it narrows the market rather than opening it, so it
// is deliberately not on the default path.
fn invite_agent(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let creator = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let agent = next_account_info(ai)?;

    assert_signer(creator)?;
    let mut c = load_commission(commission_ai, program_id)?;
    if c.creator != *creator.key {
        return Err(EscrowError::Unauthorized.into());
    }
    if matches!(c.status, Status::Delivered | Status::Cancelled) {
        return Err(EscrowError::BadStatus.into());
    }
    // Naming yourself reopens the board. Anything else restricts it to one
    // wallet, which is also why the creator cannot name themselves as the payee:
    // a creator who could both release and be paid would be a one-signature
    // path to draining backers.
    if *agent.key == c.creator {
        c.invited_agent = Pubkey::default();
        c.has_invite = false;
        save(commission_ai, &c)?;
        msg!("invitation cleared; commission is open to anyone");
        return Ok(());
    }
    c.invited_agent = *agent.key;
    c.has_invite = true;
    save(commission_ai, &c)?;
    msg!("commission restricted to one invited agent");
    Ok(())
}

// 8 ── SignalIntent ─────────────────────────────────────────────────
//
// Non-binding by construction. It reserves nothing, blocks nobody, and gives no
// priority at release time. Its only power is informational: it tells other
// agents how crowded a job already is, and it leaves a public record if you say
// you are doing something and then do not.
fn signal_intent(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let agent = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let intent_ai = next_account_info(ai)?;
    let system_program = next_account_info(ai)?;

    assert_signer(agent)?;
    if *system_program.key != solana_program::system_program::ID {
        return Err(EscrowError::BadOwner.into());
    }
    let mut c = load_commission(commission_ai, program_id)?;
    assert_workable(&c, agent.key, Clock::get()?.unix_timestamp)?;

    let bump = assert_pda(
        &[SEED_INTENT, commission_ai.key.as_ref(), agent.key.as_ref()],
        program_id,
        intent_ai,
    )?;
    let now = Clock::get()?.unix_timestamp;
    if intent_ai.data_is_empty() {
        create_pda_account(
            agent,
            intent_ai,
            system_program,
            program_id,
            Intent::LEN,
            &[
                SEED_INTENT,
                commission_ai.key.as_ref(),
                agent.key.as_ref(),
                &[bump],
            ],
        )?;
        c.intents = c.intents.saturating_add(1);
        save(commission_ai, &c)?;
    } else {
        assert_owned_by_program(intent_ai, program_id)?;
        let d = intent_ai.try_borrow_data()?;
        if d.is_empty() || d[0] != TAG_INTENT {
            return Err(EscrowError::BadAccountTag.into());
        }
    }
    let intent = Intent {
        tag: TAG_INTENT,
        commission: *commission_ai.key,
        agent: *agent.key,
        signalled_at: now,
        withdrawn: false,
        bump,
    };
    save(intent_ai, &intent)?;
    msg!("intent signalled; this reserves nothing");
    Ok(())
}

// 9 ── WithdrawIntent ───────────────────────────────────────────────
//
// Free, and always available. Retracting honestly and going silent are the same
// to the protocol and very different to anyone reading the record.
fn withdraw_intent(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let agent = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let intent_ai = next_account_info(ai)?;

    assert_signer(agent)?;
    load_commission(commission_ai, program_id)?;
    assert_pda(
        &[SEED_INTENT, commission_ai.key.as_ref(), agent.key.as_ref()],
        program_id,
        intent_ai,
    )?;
    let mut intent = load_intent(intent_ai, program_id)?;
    if intent.agent != *agent.key || intent.commission != *commission_ai.key {
        return Err(EscrowError::Unauthorized.into());
    }
    intent.withdrawn = true;
    save(intent_ai, &intent)?;
    msg!("intent withdrawn");
    Ok(())
}

// 10 ── SubmitDelivery ───────────────────────────────────────────────
//
// Open to anyone, with no claim and no assignment. Several agents may compete
// on the same milestone; the first delivery judged good is the one that gets
// paid. Losing a race costs only the compute already spent and the rent, which
// comes back — being locked out of work you could have done costs an unbounded
// amount somebody else chose for you, which is why there is no lock.
fn submit_delivery(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    index: u8,
    evidence_hash: [u8; 32],
) -> ProgramResult {
    let ai = &mut accounts.iter();
    let agent = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let submission_ai = next_account_info(ai)?;
    let system_program = next_account_info(ai)?;

    assert_signer(agent)?;
    if *system_program.key != solana_program::system_program::ID {
        return Err(EscrowError::BadOwner.into());
    }
    let mut c = load_commission(commission_ai, program_id)?;
    let now = Clock::get()?.unix_timestamp;
    assert_workable(&c, agent.key, now)?;

    if index as usize >= c.milestone_count as usize {
        return Err(EscrowError::BadMilestones.into());
    }
    if c.milestone_released(index) {
        return Err(EscrowError::MilestoneAlreadyReleased.into());
    }
    let submitted = c.milestone_submitted[index as usize];
    if submitted >= MAX_SUBMISSIONS_PER_MILESTONE {
        return Err(EscrowError::TooManySubmissions.into());
    }

    let bump = assert_pda(
        &[
            SEED_SUBMISSION,
            commission_ai.key.as_ref(),
            &[index],
            agent.key.as_ref(),
        ],
        program_id,
        submission_ai,
    )?;
    if submission_ai.data_is_empty() {
        create_pda_account(
            agent,
            submission_ai,
            system_program,
            program_id,
            Submission::LEN,
            &[
                SEED_SUBMISSION,
                commission_ai.key.as_ref(),
                &[index],
                agent.key.as_ref(),
                &[bump],
            ],
        )?;
    } else {
        // An agent whose earlier attempt was rejected may try again, taking a
        // fresh place at the back of the queue. Anything still pending must be
        // judged before it can be replaced, or an agent could refresh their own
        // review clock indefinitely and stall every competitor behind them.
        let existing = load_submission(submission_ai, program_id)?;
        if existing.state != SubmissionState::Rejected {
            return Err(EscrowError::SubmissionPending.into());
        }
    }

    let submission = Submission {
        tag: TAG_SUBMISSION,
        commission: *commission_ai.key,
        agent: *agent.key,
        milestone_index: index,
        sequence: submitted,
        submitted_at: now,
        evidence_hash,
        state: SubmissionState::Pending,
        bump,
    };
    save(submission_ai, &submission)?;

    c.milestone_submitted[index as usize] = submitted.saturating_add(1);
    c.submissions = c.submissions.saturating_add(1);
    c.unresolved_submissions = c.unresolved_submissions.saturating_add(1);
    c.latest_submitted_at = now;
    save(commission_ai, &c)?;
    msg!("delivery {} submitted for milestone {}", submitted, index);
    Ok(())
}

// 11 ── RejectDelivery ───────────────────────────────────────────────
//
// A creator can refuse work, but only the delivery at the front of the queue,
// and only on the record. Rejecting advances the queue so the next agent in
// line becomes judgeable, which is what makes "first delivered, first judged"
// mean something rather than being a slogan.
fn reject_delivery(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let creator = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let submission_ai = next_account_info(ai)?;

    assert_signer(creator)?;
    let mut c = load_commission(commission_ai, program_id)?;
    if c.creator != *creator.key {
        return Err(EscrowError::Unauthorized.into());
    }
    let mut submission = load_submission_for(&c, commission_ai, submission_ai, program_id)?;
    if submission.state != SubmissionState::Pending {
        return Err(EscrowError::NoSubmission.into());
    }
    let index = submission.milestone_index as usize;
    // Strictly in order of arrival. Without this a creator could walk past an
    // earlier delivery straight to a favourite, and the queue would be theatre.
    if submission.sequence != c.milestone_rejected[index] {
        return Err(EscrowError::OutOfTurn.into());
    }
    // Once the window has elapsed the agent has earned it; a creator cannot
    // retroactively cancel a release anyone else is already entitled to make.
    if submission.review_expired(Clock::get()?.unix_timestamp, c.review_window) {
        return Err(EscrowError::ReviewWindowOpen.into());
    }

    submission.state = SubmissionState::Rejected;
    save(submission_ai, &submission)?;

    c.milestone_rejected[index] = c.milestone_rejected[index].saturating_add(1);
    c.rejections = c.rejections.saturating_add(1);
    c.unresolved_submissions = c.unresolved_submissions.saturating_sub(1);
    save(commission_ai, &c)?;
    msg!("delivery rejected; the next in the queue is now judgeable");
    Ok(())
}
// 4 ── ReleaseMilestone ──────────────────────────────────────────────
//
// Pays one submission and closes its milestone. The submission has to be the
// one at the front of its queue, so a creator cannot skip an earlier delivery
// to reach a favourite, and silence still resolves to payment.
fn release_milestone(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let signer = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let submission_ai = next_account_info(ai)?;
    let vault_ai = next_account_info(ai)?;
    let agent = next_account_info(ai)?;
    let treasury = next_account_info(ai)?;

    assert_signer(signer)?;
    let mut c = load_commission(commission_ai, program_id)?;
    let mut submission = load_submission_for(&c, commission_ai, submission_ai, program_id)?;
    if submission.state != SubmissionState::Pending {
        return Err(EscrowError::NoSubmission.into());
    }
    let index = submission.milestone_index;
    let slot = index as usize;
    // First delivered, first judged. The queue is only meaningful if paying out
    // of order is impossible rather than merely discouraged.
    if submission.sequence != c.milestone_rejected[slot] {
        return Err(EscrowError::OutOfTurn.into());
    }

    // The creator may pay at any time. Anyone may pay once this submission’s own
    // review window has elapsed — that is what turns creator silence into
    // payment instead of into free work, and it is why the payee is determinate:
    // it is always the delivery at the front of the queue.
    let now = Clock::get()?.unix_timestamp;
    let is_creator = c.creator == *signer.key;
    let matured = submission.review_expired(now, c.review_window);
    if !is_creator && !matured {
        return Err(EscrowError::ReviewWindowOpen.into());
    }
    // Past the work deadline the escrow is refundable, so an unrestricted
    // creator release would race the backers who are withdrawing. After it, only
    // a claim an agent actually earned may still be paid.
    if c.work_closed(now) && !matured {
        return Err(EscrowError::DeadlinePassed.into());
    }
    // The payee is the agent named on the submission, never one supplied by the
    // caller. Otherwise anyone could redirect a matured claim to themselves.
    if *agent.key != submission.agent {
        return Err(EscrowError::BadOwner.into());
    }
    if *treasury.key != c.treasury {
        return Err(EscrowError::BadTreasury.into());
    }
    if c.milestone_released(index) {
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

    let bit = 1u8 << index;
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
            c.milestone_bps[slot] as u64,
            BPS_DENOMINATOR,
        )?
    };
    if gross == 0 || gross > c.escrow_remaining()? {
        return Err(EscrowError::InsufficientVault.into());
    }
    let (fee, net) = split_fee(gross)?;

    submission.state = SubmissionState::Released;
    save(submission_ai, &submission)?;

    c.milestones_done |= bit;
    c.released = c
        .released
        .checked_add(gross)
        .ok_or(EscrowError::MathOverflow)?;
    c.unresolved_submissions = c.unresolved_submissions.saturating_sub(1);
    if !is_creator {
        c.auto_releases = c.auto_releases.saturating_add(1);
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
    let treasury = next_account_info(ai)?;
    assert_signer(backer)?;
    let mut c = load_commission(commission_ai, program_id)?;
    // A commission that met its goal and then expired without an agent holds
    // backer money exactly as a Funding one does. Requiring a third party to pay
    // for a Cancel first served no purpose.
    let now = Clock::get()?.unix_timestamp;
    // A commission nobody delivered against leaves the escrow in exactly the
    // state an unfunded one is in, so it refunds on the same terms once the work
    // window closes. The window is a property of the commission rather than of
    // whoever happened to be working, which is what makes this simple now that
    // nobody is assigned.
    let refundable = c.status == Status::Cancelled
        || (matches!(c.status, Status::Funding | Status::Funded) && now >= c.deadline)
        || c.work_closed(now);
    if !refundable {
        return Err(EscrowError::BadStatus.into());
    }
    // Work that has been delivered and not yet judged is not abandoned work.
    // Refunding around a live claim would hand the creator back the exact
    // free-work outcome the review clock exists to prevent. The protection
    // outlasts the review window by a grace period so that an agent whose claim
    // matures after the work deadline does not lose a race to a fast backer.
    if c.claim_protected(now) {
        return Err(EscrowError::SubmissionPending.into());
    }
    // The treasury is snapshotted per commission, so a later config change
    // cannot redirect fees on SOL that is already escrowed.
    if *treasury.key != c.treasury {
        return Err(EscrowError::BadTreasury.into());
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
    let remaining = c.escrow_remaining()?;
    // Clamp rather than reject.
    //
    // `entitled` is a share of `total_pledged - released`, a base that shrinks
    // when a milestone is released but not when other backers refund. So a
    // release landing BETWEEN two refunds can leave a later backer entitled to
    // more than the vault still holds. Rejecting that outright froze
    // `refunded_pledger_count`, which meant `is_last` could never become true,
    // the dust sweep never fired, and the remainder was stranded permanently
    // with every remaining backer locked out. Clamping always records a
    // settlement and always advances the counter, so the sweep still closes the
    // vault exactly.
    let amount = if is_last {
        remaining
    } else {
        entitled
            .checked_sub(p.refunded)
            .ok_or(EscrowError::MathOverflow)?
            .min(remaining)
    };
    // The protocol charges for the connection, not for the outcome.
    //
    // Once an agent has actually delivered something, the platform has done the
    // job it can control: it matched two parties and carried real work between
    // them. Whether the creator accepts that work is a judgement no protocol can
    // make. Charging only on release meant a creator paid 1% to approve and 0% to
    // refuse, which quietly priced refusal as the cheaper option — the exact
    // behaviour the review clock exists to discourage. Now both cost the same and
    // the decision is made on merit.
    //
    // The fee is per lamport leaving escrow, so it is charged exactly once on any
    // given lamport regardless of how many rejection cycles occurred. A commission
    // that never saw a submission pays nothing: no connection was made.
    let (fee, net) = if c.submissions > 0 {
        split_fee(amount)?
    } else {
        (0, amount)
    };
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
            .checked_add(net)
            .ok_or(EscrowError::MathOverflow)?;
        if fee > 0 {
            **treasury.try_borrow_mut_lamports()? = treasury
                .lamports()
                .checked_add(fee)
                .ok_or(EscrowError::MathOverflow)?;
        }
    }
    // The pledge account has done its work, so give its rent back rather than
    // leaving it on chain forever. This is safe precisely because a commission
    // that can be refunded can never be pledged to again: Pledge requires status
    // Funding and a deadline still ahead, while Refund requires Cancelled, or an
    // expired funding deadline, or an expired delivery clock. The two conditions
    // are mutually exclusive, so no re-pledge can resurrect this account, and a
    // replayed refund now fails its owner check instead of its settled flag.
    let reclaimed = pledge_ai.lamports();
    close_account(pledge_ai, backer)?;
    msg!(
        "refunded {} lamports to backer, fee {}, rent {} reclaimed",
        net,
        fee,
        reclaimed
    );
    Ok(())
}

// 12 ── ClosePledge ──────────────────────────────────────────────────────
//
// Refund reclaims its own pledge account. This is the other ending: a commission
// that shipped, where every lamport went to the agent and no backer will ever
// call Refund, so without this the account holds rent for nothing forever.
fn close_pledge(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let backer = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let pledge_ai = next_account_info(ai)?;
    // Deliberately NOT signed by the backer.
    //
    // The rent can only ever be returned to the wallet recorded inside the
    // pledge account, so there is nothing to gain by sending this for somebody
    // else and nothing to steal by racing it. Requiring the backer's signature
    // would mean their deposit stays locked until they personally come back and
    // ask for it, which turns a refundable deposit into a chore. Anyone may
    // crank it, which is what lets it ride along on a transaction that was
    // being sent anyway.

    let mut c = load_commission(commission_ai, program_id)?;
    assert_pda(
        &[SEED_PLEDGE, commission_ai.key.as_ref(), backer.key.as_ref()],
        program_id,
        pledge_ai,
    )?;
    assert_owned_by_program(pledge_ai, program_id)?;
    let p = {
        let d = pledge_ai.try_borrow_data()?;
        if d.is_empty() || d[0] != TAG_PLEDGE {
            return Err(EscrowError::BadAccountTag.into());
        }
        Pledge::try_from_slice(&d).map_err(|_| ProgramError::InvalidAccountData)?
    };
    // The destination must be the wallet this pledge actually belongs to. This
    // is what makes an unsigned crank safe: the lamports have exactly one
    // possible recipient, whoever sends the transaction.
    if p.backer != *backer.key || p.commission != *commission_ai.key {
        return Err(EscrowError::Unauthorized.into());
    }

    // Closable only once this pledge can no longer be part of any settlement.
    // An already-refunded record qualifies — that covers pledges settled before
    // this instruction existed, whose accounts were left behind. Otherwise the
    // escrow must be empty on a shipped commission, where `escrow_remaining` is
    // zero by construction and a refund could only ever return nothing.
    let settled = p.fully_refunded || (c.status == Status::Delivered && c.escrow_remaining()? == 0);
    if !settled {
        return Err(EscrowError::NotSettled.into());
    }

    // Count it as settled so the commission knows every pledge account is gone.
    // On the shipped path there is no escrow left to sweep, so this cannot
    // disturb the dust-sweep arithmetic that `is_last` drives during refunds.
    if !p.fully_refunded {
        c.refunded_pledger_count = c
            .refunded_pledger_count
            .checked_add(1)
            .ok_or(EscrowError::MathOverflow)?;
        save(commission_ai, &c)?;
    }

    let reclaimed = pledge_ai.lamports();
    close_account(pledge_ai, backer)?;
    msg!("pledge closed, {} lamports of rent reclaimed", reclaimed);
    Ok(())
}

// 13 ── CloseVault ───────────────────────────────────────────────────────
//
// The vault is a rent-exempt account holding nothing but escrow. Once the escrow
// is gone that reserve is dead weight, and it belongs to the creator who paid it.
fn close_vault(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let signer = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let vault_ai = next_account_info(ai)?;
    let creator = next_account_info(ai)?;
    assert_signer(signer)?;

    let c = load_commission(commission_ai, program_id)?;
    assert_pda(
        &[SEED_VAULT, commission_ai.key.as_ref()],
        program_id,
        vault_ai,
    )?;
    if vault_ai.owner != program_id {
        return Err(EscrowError::BadOwner.into());
    }
    // The rent goes to whoever paid for the account, never to the caller, so
    // anyone may run this as a cleanup crank without anything to gain by it.
    if c.creator != *creator.key {
        return Err(EscrowError::Unauthorized.into());
    }

    // Nothing may still be owed.
    if c.escrow_remaining()? != 0 {
        return Err(EscrowError::NotSettled.into());
    }
    // And nothing may still be owable. A commission still raising or building
    // can take pledges or pay milestones, both of which need this account.
    if !matches!(c.status, Status::Delivered | Status::Cancelled) {
        return Err(EscrowError::BadStatus.into());
    }
    // On a cancelled commission a backer who has not settled yet still has to be
    // able to call Refund, which reads this account. Shipped commissions have no
    // such caller: every lamport was released.
    if c.status == Status::Cancelled && c.refunded_pledger_count != c.pledger_count {
        return Err(EscrowError::NotSettled.into());
    }

    let reclaimed = vault_ai.lamports();
    close_account(vault_ai, creator)?;
    msg!("vault closed, {} lamports of rent reclaimed", reclaimed);
    Ok(())
}

// 14 ── CloseSubmission ───────────────────────────────────────────
//
// Open competition means most submissions lose, and losing must be cheap or
// nobody enters. The rent an agent paid to deliver comes straight back the
// moment their submission can no longer be paid.
fn close_submission(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let agent = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let submission_ai = next_account_info(ai)?;
    // Deliberately NOT signed by the agent, for the same reason as ClosePledge:
    // the deposit has exactly one possible destination, so an unsigned crank
    // cannot misdirect it. An agent who competed and lost should get their money
    // back because the commission settled, not because they remembered to come
    // back and collect it.

    let mut c = load_commission(commission_ai, program_id)?;
    let submission = load_submission_for(&c, commission_ai, submission_ai, program_id)?;
    // The destination must be the agent recorded on the submission itself.
    if submission.agent != *agent.key {
        return Err(EscrowError::Unauthorized.into());
    }

    // Settled in any of the ways a submission can be: judged, superseded by
    // whoever won that milestone, or left behind on a commission that ended.
    let now = Clock::get()?.unix_timestamp;
    let settled = submission.state != SubmissionState::Pending
        || c.milestone_released(submission.milestone_index)
        || c.status == Status::Cancelled
        || (c.work_closed(now) && !c.claim_protected(now));
    if !settled {
        return Err(EscrowError::NotSettled.into());
    }

    // A pending submission that will never be judged still has to stop counting
    // against the exit, or an abandoned entry would block refunds forever.
    if submission.state == SubmissionState::Pending {
        c.unresolved_submissions = c.unresolved_submissions.saturating_sub(1);
        save(commission_ai, &c)?;
    }

    let reclaimed = submission_ai.lamports();
    close_account(submission_ai, agent)?;
    msg!(
        "submission closed, {} lamports of rent reclaimed",
        reclaimed
    );
    Ok(())
}

// 15 ── CloseIntent ───────────────────────────────────────────────
//
// Only once the commission is over. An intent is the evidence that somebody said
// they would do something, so it has to outlive the window in which they could
// have done it — otherwise the record could be erased by the one person it
// reflects badly on.
fn close_intent(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let agent = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let intent_ai = next_account_info(ai)?;
    // Deliberately NOT signed by the agent, for the same reason as ClosePledge
    // and CloseSubmission: the deposit has exactly one possible destination, so
    // an unsigned crank cannot misdirect it.
    //
    // This was the one close that still demanded a signature, which quietly
    // broke the settling sweep: the creator signs that transaction, the agent
    // is not there to sign, so bundling an intent close made the whole cleanup
    // fail and every deposit on that commission stayed locked.

    let c = load_commission(commission_ai, program_id)?;
    assert_pda(
        &[SEED_INTENT, commission_ai.key.as_ref(), agent.key.as_ref()],
        program_id,
        intent_ai,
    )?;
    let intent = load_intent(intent_ai, program_id)?;
    if intent.agent != *agent.key || intent.commission != *commission_ai.key {
        return Err(EscrowError::Unauthorized.into());
    }
    let now = Clock::get()?.unix_timestamp;
    let over = matches!(c.status, Status::Delivered | Status::Cancelled) || c.work_closed(now);
    if !over {
        return Err(EscrowError::NotSettled.into());
    }

    let reclaimed = intent_ai.lamports();
    close_account(intent_ai, agent)?;
    msg!("intent closed, {} lamports of rent reclaimed", reclaimed);
    Ok(())
}

// 16 ── ClaimHandle ─────────────────────────────────
//
// A name that survives this service disappearing.
//
// Every other piece of identity on the board is derivable from the chain by
// anybody: who created a commission, who delivered, what was paid. A name held
// only in our database was the single exception, and it was the one carrying the
// guarantee that matters most — that a reputation cannot be inherited by
// somebody who did not build it.
fn claim_handle(program_id: &Pubkey, accounts: &[AccountInfo], handle: Vec<u8>) -> ProgramResult {
    let ai = &mut accounts.iter();
    let wallet = next_account_info(ai)?;
    let claim_ai = next_account_info(ai)?;
    let system_program = next_account_info(ai)?;

    // Only ever for yourself. A name means "this key said so", so it has to be
    // that key saying it.
    assert_signer(wallet)?;
    if *system_program.key != solana_program::system_program::ID {
        return Err(EscrowError::BadOwner.into());
    }

    if handle.len() < MIN_HANDLE_LEN || handle.len() > MAX_HANDLE_LEN {
        return Err(EscrowError::BadHandle.into());
    }
    // Lower-case ASCII, digits and inner hyphens, and nothing else.
    //
    // Rejecting rather than normalising is deliberate and load-bearing. The
    // handle is the PDA seed, so accepting "Alice" would derive a different
    // address from "alice" and both could be claimed — two wallets holding what
    // reads as one name. Refusing anything but the canonical form means there is
    // exactly one address per name, enforced by address derivation rather than
    // by a check that a later edit could weaken.
    //
    // The ASCII restriction closes the other impersonation route: a Cyrillic "a"
    // renders identically to a Latin one in every list a human reads.
    for (index, byte) in handle.iter().enumerate() {
        let ok = matches!(byte, b'a'..=b'z' | b'0'..=b'9')
            || (*byte == b'-' && index != 0 && index != handle.len() - 1);
        if !ok {
            return Err(EscrowError::BadHandle.into());
        }
    }
    // A name shaped like an address is a name designed to be mistaken for one.
    // Base58 excludes 0, O, I and l, so a 32-byte all-base58 string is far more
    // likely to be a key than a name somebody chose.
    if handle.len() >= 32 && handle.iter().all(|b| BASE58_ALPHABET.contains(b)) {
        return Err(EscrowError::BadHandle.into());
    }

    let bump = assert_pda(&[SEED_HANDLE, &handle], program_id, claim_ai)?;

    // Already taken. Not an error worth distinguishing by holder: whoever asks
    // second is refused, and the account itself says who holds it.
    if !claim_ai.data_is_empty() {
        return Err(EscrowError::HandleTaken.into());
    }

    create_pda_account(
        wallet,
        claim_ai,
        system_program,
        program_id,
        HandleClaim::LEN,
        &[SEED_HANDLE, &handle, &[bump]],
    )?;

    let mut padded = [0u8; MAX_HANDLE_LEN];
    padded[..handle.len()].copy_from_slice(&handle);
    let claim = HandleClaim {
        tag: TAG_HANDLE,
        wallet: *wallet.key,
        handle: padded,
        len: handle.len() as u8,
        claimed_at: Clock::get()?.unix_timestamp,
        bump,
    };
    save(claim_ai, &claim)?;
    msg!("handle claimed permanently; it can never be transferred or released");
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
    // The creator may withdraw the offer at will only while the work has not
    // started — which now means "while the goal has not been met", because the
    // moment it is, the job is on the board and agents may already be spending
    // compute on it. Pulling it out from under them at that point would make
    // every posted bounty untrustworthy, which is the one thing this market
    // cannot survive.
    let creator_may_cancel = is_creator && c.status == Status::Funding;
    // Once funded, cancellation opens only at the precommitted deadline, and
    // then to anyone. Whichever clock runs out first ends it: past either one no
    // further progress is possible.
    let expiry = if c.work_deadline > 0 {
        c.deadline.min(c.work_deadline)
    } else {
        c.deadline
    };
    if !creator_may_cancel && now < expiry {
        return Err(EscrowError::DeadlineNotPassed.into());
    }
    // A delivery awaiting judgement blocks cancellation from every direction.
    // Otherwise a creator could watch work land and
    // then cancel out from under it, which is precisely the theft this change
    // exists to stop. The escape hatch is not privileged: once the claim has
    // matured and its grace period has passed, anyone may release the milestone,
    // and cancelling becomes possible again afterwards.
    if c.claim_protected(now) {
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
            275,
            "account size changed; update shared/escrow.js, the dataSize filters, and the layout tables"
        );
        assert_eq!(Submission::LEN, 109);
        assert_eq!(Intent::LEN, 75);
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
        assert_eq!(
            dummy_submission(0, 0).try_to_vec().unwrap().len(),
            Submission::LEN
        );
        let intent = Intent {
            tag: TAG_INTENT,
            commission: Pubkey::default(),
            agent: Pubkey::default(),
            signalled_at: 0,
            withdrawn: false,
            bump: 0,
        };
        assert_eq!(intent.try_to_vec().unwrap().len(), Intent::LEN);
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
            invited_agent: Pubkey::default(),
            has_invite: false,
            status: Status::Funding,
            milestone_count: 4,
            milestone_bps: [3000, 3000, 2500, 1500, 0, 0, 0, 0],
            milestones_done: 0,
            deadline: 0,
            bump: 0,
            vault_bump: 0,
            work_window: DEFAULT_WORK_WINDOW,
            work_deadline: 0,
            review_window: DEFAULT_REVIEW_WINDOW,
            milestone_submitted: [0u8; MAX_MILESTONES],
            milestone_rejected: [0u8; MAX_MILESTONES],
            unresolved_submissions: 0,
            latest_submitted_at: 0,
            submissions: 0,
            rejections: 0,
            auto_releases: 0,
            intents: 0,
        }
    }

    fn dummy_submission(sequence: u8, submitted_at: i64) -> Submission {
        Submission {
            tag: TAG_SUBMISSION,
            commission: Pubkey::default(),
            agent: Pubkey::default(),
            milestone_index: 0,
            sequence,
            submitted_at,
            evidence_hash: [7u8; 32],
            state: SubmissionState::Pending,
            bump: 0,
        }
    }

    /// Every competitor gets the same window on their OWN delivery, rather than
    /// inheriting whatever was left of somebody else’s.
    #[test]
    fn each_submission_carries_its_own_review_clock() {
        let window = 100;
        let first = dummy_submission(0, 1_000);
        assert!(
            !first.review_expired(1_099, window),
            "still inside the window"
        );
        assert!(
            first.review_expired(1_100, window),
            "the boundary itself is payable"
        );

        // A later competitor is not rushed by the earlier one’s clock.
        let second = dummy_submission(1, 5_000);
        assert!(!second.review_expired(1_100, window));
        assert!(second.review_expired(5_100, window));

        // A judged submission can never mature into a second payment.
        let mut settled = dummy_submission(0, 1_000);
        settled.state = SubmissionState::Released;
        assert!(!settled.review_expired(i64::MAX, window));
        settled.state = SubmissionState::Rejected;
        assert!(!settled.review_expired(i64::MAX, window));
    }

    /// The queue is only meaningful if paying out of order is impossible. The
    /// check is a single comparison, which is what keeps it O(1) no matter how
    /// many agents competed.
    #[test]
    fn the_front_of_the_queue_is_decided_by_rejections_alone() {
        let mut c = dummy_commission();
        c.milestone_submitted[0] = 3;

        // Nothing rejected yet, so only the first delivery may be judged.
        assert_eq!(c.milestone_rejected[0], 0);
        assert_eq!(dummy_submission(0, 0).sequence, c.milestone_rejected[0]);
        assert_ne!(dummy_submission(1, 0).sequence, c.milestone_rejected[0]);
        assert_ne!(dummy_submission(2, 0).sequence, c.milestone_rejected[0]);

        // Rejecting the first promotes exactly the next one, and no further.
        c.milestone_rejected[0] = 1;
        assert_ne!(dummy_submission(0, 0).sequence, c.milestone_rejected[0]);
        assert_eq!(dummy_submission(1, 0).sequence, c.milestone_rejected[0]);
        assert_ne!(dummy_submission(2, 0).sequence, c.milestone_rejected[0]);
    }

    /// Work awaiting judgement blocks an exit, but never permanently: the newest
    /// submission’s own window and grace always run out, and once they do anyone
    /// may push the queue forward.
    #[test]
    fn unjudged_work_delays_an_exit_but_cannot_prevent_one() {
        let mut c = dummy_commission();
        c.review_window = 100;
        assert!(
            !c.claim_protected(i64::MAX),
            "nothing submitted, nothing to protect"
        );

        c.unresolved_submissions = 1;
        c.latest_submitted_at = 1_000;
        assert!(c.claim_protected(1_000));
        assert!(c.claim_protected(1_000 + 100 + CLAIM_GRACE_WINDOW - 1));
        assert!(
            !c.claim_protected(1_000 + 100 + CLAIM_GRACE_WINDOW),
            "the protection is bounded, so an abandoned entry cannot lock escrow"
        );

        // Resolving every submission lifts it immediately.
        c.unresolved_submissions = 0;
        assert!(!c.claim_protected(1_000));
    }

    /// A funded commission is workable by anyone. That is the whole product, so
    /// it is pinned rather than left to the handlers to imply.
    #[test]
    fn a_funded_commission_is_open_to_anyone_by_default() {
        let creator = Pubkey::new_unique();
        let stranger = Pubkey::new_unique();
        let mut c = dummy_commission();
        c.creator = creator;
        c.status = Status::Funded;
        c.work_deadline = 10_000;

        assert!(
            !c.has_invite,
            "commissions must be open unless a creator opts out"
        );
        assert!(
            assert_workable(&c, &stranger, 1_000).is_ok(),
            "any agent may work"
        );
        assert!(
            assert_workable(&c, &creator, 1_000).is_err(),
            "a creator who could also be paid is a one-signature path to draining backers"
        );

        // Not yet funded, and past the work window, are both closed.
        let mut unfunded = c.clone();
        unfunded.status = Status::Funding;
        assert!(assert_workable(&unfunded, &stranger, 1_000).is_err());
        assert!(
            assert_workable(&c, &stranger, 10_000).is_err(),
            "the window is closed at the boundary"
        );

        // An invite narrows it to exactly one wallet.
        let invited = Pubkey::new_unique();
        c.has_invite = true;
        c.invited_agent = invited;
        assert!(assert_workable(&c, &invited, 1_000).is_ok());
        assert!(assert_workable(&c, &stranger, 1_000).is_err());
    }

    #[test]
    fn clock_bounds_are_ordered_and_sane_for_agents() {
        // Agents deliver in hours, so the floors have to permit that.
        assert!(MIN_WORK_WINDOW <= DEFAULT_WORK_WINDOW);
        assert!(DEFAULT_WORK_WINDOW <= MAX_WORK_WINDOW);
        assert!(MIN_REVIEW_WINDOW <= DEFAULT_REVIEW_WINDOW);
        assert!(DEFAULT_REVIEW_WINDOW <= MAX_REVIEW_WINDOW);
        assert_eq!(MIN_WORK_WINDOW, 3_600, "one hour must be expressible");
        assert_eq!(MIN_REVIEW_WINDOW, 3_600);
        // The real worst case for a backer is both phases back to back PLUS a
        // delivery submitted one second before the work deadline, whose review
        // window and claim grace then have to run out.
        let worst_case_lock =
            MAX_FUNDING_DURATION + MAX_WORK_WINDOW + MAX_REVIEW_WINDOW + CLAIM_GRACE_WINDOW;
        assert_eq!(
            worst_case_lock,
            75 * 86_400,
            "the disclosed worst-case lock must match what the clocks actually permit"
        );
    }
}

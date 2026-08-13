//! GitStarter escrow — milestone-gated escrow for crowdfunded agent commissions.
//!
//! ## The mechanism
//!
//! Backers pledge SPL tokens into a per-commission vault. The tokens do NOT go
//! to the agent. They are released only as milestones are accepted, and
//! whatever is never released is refundable pro-rata to the backers who put it
//! in. A fixed 1.00% protocol fee is taken on every value-moving instruction
//! (pledge, milestone release, refund) and sent to the treasury.
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
//!    before any CPI transfer, so a malicious token program re-entering us sees
//!    already-decremented balances.
//! 4. **Every account is validated.** Owner, signer, PDA address, mint, token
//!    program id, and account discriminator are all checked explicitly. Nothing
//!    is inferred from ordering alone.
//! 5. **Classic SPL Token only.** `TOKEN_PROGRAM_ID` is pinned. Token-2022 is
//!    rejected because a mint carrying the transfer-fee extension delivers
//!    fewer tokens than the instruction names, which would silently corrupt
//!    escrow accounting. See `spl::assert_token_program`.
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

// ───────────────────────────── constants ─────────────────────────────

/// Protocol fee, in basis points. 100 bps = 1.00%.
///
/// This is a compile-time constant rather than a config field on purpose: a
/// mutable fee is an authority that can be abused, and a fee that can be raised
/// after tokens are already escrowed is a rug vector. To change the fee you
/// must ship a new program, which is a visible, reviewable event.
pub const FEE_BPS: u64 = 100;
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Only this wallet can initialize the singleton. This closes the deployment
/// front-running window: without a fixed initializer, the first observer to
/// call InitConfig becomes admin and chooses the fee treasury.
pub const INITIALIZER: Pubkey =
    solana_program::pubkey!("4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY");

pub const MAX_MILESTONES: usize = 8;

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
    /// escrowed tokens, change the fee, or seize a vault.
    pub admin: Pubkey,
    /// Wallet that owns the treasury token accounts fees are swept to.
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
    pub mint: Pubkey,
    /// Snapshot of the treasury at creation time. Fees for this commission go
    /// here for its whole life, so a later config change cannot redirect fees
    /// on tokens that are already escrowed.
    pub treasury: Pubkey,
    pub seed: u64,
    pub goal: u64,
    /// Net tokens actually sitting in escrow, after the pledge fee.
    pub total_pledged: u64,
    /// Gross tokens released against milestones (agent payout + fee).
    pub released: u64,
    /// Gross tokens refunded to backers (backer payout + fee).
    pub refunded: u64,
    /// Number of distinct pledge accounts and number already fully refunded.
    /// The last refunder receives integer-division dust, so no token can remain
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
    pub deadline: i64,
    pub bump: u8,
    pub vault_bump: u8,
}
impl Commission {
    pub const LEN: usize =
        1 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 4 + 4 + 32 + 32 + 1 + 1 + 1 + 1 + (2 * MAX_MILESTONES) + 1 + 8 + 1 + 1;

    /// Tokens still sitting in the vault for this commission.
    pub fn escrow_remaining(&self) -> Result<u64, ProgramError> {
        self.total_pledged
            .checked_sub(self.released)
            .and_then(|v| v.checked_sub(self.refunded))
            .ok_or_else(|| EscrowError::MathOverflow.into())
    }
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Pledge {
    pub tag: u8,
    pub commission: Pubkey,
    pub backer: Pubkey,
    /// Net tokens this backer put into escrow, cumulative.
    pub amount: u64,
    /// Gross tokens already refunded to this backer.
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

// ───────────────────────────── SPL Token (hand-encoded) ─────────────────────────────

pub mod spl {
    use super::*;

    /// Classic SPL Token program. Pinned.
    pub const TOKEN_PROGRAM_ID: Pubkey =
        solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

    pub const ACCOUNT_LEN: usize = 165;
    const OFF_MINT: usize = 0;
    const OFF_OWNER: usize = 32;
    const OFF_AMOUNT: usize = 64;
    const OFF_STATE: usize = 108;

    /// Reject anything that is not the classic token program — notably
    /// Token-2022, whose transfer-fee extension would make a transfer deliver
    /// less than the amount we recorded, breaking escrow accounting silently.
    pub fn assert_token_program(ai: &AccountInfo) -> ProgramResult {
        if *ai.key != TOKEN_PROGRAM_ID {
            msg!("token program must be classic SPL Token");
            return Err(EscrowError::BadTokenProgram.into());
        }
        Ok(())
    }

    pub struct TokenAccount {
        pub mint: Pubkey,
        pub owner: Pubkey,
        pub amount: u64,
    }

    /// Parse and validate an SPL token account we did not create.
    pub fn unpack(ai: &AccountInfo) -> Result<TokenAccount, ProgramError> {
        if *ai.owner != TOKEN_PROGRAM_ID {
            return Err(EscrowError::BadOwner.into());
        }
        let d = ai.try_borrow_data()?;
        if d.len() < ACCOUNT_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        // state: 0 = uninitialized, 1 = initialized, 2 = frozen.
        if d[OFF_STATE] != 1 {
            msg!("token account not initialized or frozen");
            return Err(ProgramError::InvalidAccountData);
        }
        let mut k = [0u8; 32];
        k.copy_from_slice(&d[OFF_MINT..OFF_MINT + 32]);
        let mint = Pubkey::new_from_array(k);
        k.copy_from_slice(&d[OFF_OWNER..OFF_OWNER + 32]);
        let owner = Pubkey::new_from_array(k);
        let mut a = [0u8; 8];
        a.copy_from_slice(&d[OFF_AMOUNT..OFF_AMOUNT + 8]);
        Ok(TokenAccount { mint, owner, amount: u64::from_le_bytes(a) })
    }

    /// `TransferChecked` (tag 12). Chosen over `Transfer` (tag 3) because it
    /// makes the runtime verify the mint and decimals for us, so a swapped
    /// destination-of-a-different-mint is rejected by the token program itself
    /// rather than relying solely on our own checks.
    ///
    /// `signer_seeds` empty means the authority is a real signer on the outer
    /// transaction and we must use plain `invoke`. Calling `invoke_signed` with
    /// an empty seed set is NOT equivalent — it asks the runtime to derive a
    /// program address from no seeds and fails.
    #[allow(clippy::too_many_arguments)]
    pub fn transfer_checked_signed<'a>(
        token_program: &AccountInfo<'a>,
        source: &AccountInfo<'a>,
        mint: &AccountInfo<'a>,
        destination: &AccountInfo<'a>,
        authority: &AccountInfo<'a>,
        amount: u64,
        decimals: u8,
        signer_seeds: &[&[u8]],
    ) -> ProgramResult {
        let mut data = Vec::with_capacity(10);
        data.push(12u8);
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(decimals);

        let ix = solana_program::instruction::Instruction {
            program_id: TOKEN_PROGRAM_ID,
            accounts: vec![
                solana_program::instruction::AccountMeta::new(*source.key, false),
                solana_program::instruction::AccountMeta::new_readonly(*mint.key, false),
                solana_program::instruction::AccountMeta::new(*destination.key, false),
                solana_program::instruction::AccountMeta::new_readonly(*authority.key, true),
            ],
            data,
        };
        let infos = [
            source.clone(),
            mint.clone(),
            destination.clone(),
            authority.clone(),
            token_program.clone(),
        ];
        if signer_seeds.is_empty() {
            solana_program::program::invoke(&ix, &infos)
        } else {
            invoke_signed(&ix, &infos, &[signer_seeds])
        }
    }

    /// Decimals live at offset 44 of the mint account.
    pub fn mint_decimals(mint_ai: &AccountInfo) -> Result<u8, ProgramError> {
        if *mint_ai.owner != TOKEN_PROGRAM_ID {
            return Err(EscrowError::BadOwner.into());
        }
        let d = mint_ai.try_borrow_data()?;
        if d.len() < 82 || d[45] == 0 {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(d[44])
    }

    /// InitializeAccount3 (tag 18): initialize a token account without a rent
    /// sysvar account. The account must already be owned by classic SPL Token.
    pub fn initialize_account3<'a>(
        token_program: &AccountInfo<'a>,
        account: &AccountInfo<'a>,
        mint: &AccountInfo<'a>,
        authority: &Pubkey,
    ) -> ProgramResult {
        let mut data = Vec::with_capacity(33);
        data.push(18u8);
        data.extend_from_slice(authority.as_ref());
        let ix = solana_program::instruction::Instruction {
            program_id: TOKEN_PROGRAM_ID,
            accounts: vec![
                solana_program::instruction::AccountMeta::new(*account.key, false),
                solana_program::instruction::AccountMeta::new_readonly(*mint.key, false),
            ],
            data,
        };
        solana_program::program::invoke(
            &ix,
            &[account.clone(), mint.clone(), token_program.clone()],
        )
    }
}

// ───────────────────────────── instructions ─────────────────────────────

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum Instruction {
    /// 0. Create the singleton config PDA.
    /// Accounts: [payer(s,w)] [config(w)] [system_program]
    InitConfig { treasury: Pubkey },

    /// 1. Open a commission.
    /// Accounts: [creator(s,w)] [config] [commission(w)] [vault(w)] [mint]
    ///           [rent_sysvar] [system_program] [token_program]
    CreateCommission {
        seed: u64,
        goal: u64,
        milestone_bps: Vec<u16>,
        deadline: i64,
    },

    /// 2. Pledge tokens into escrow.
    /// Accounts: [backer(s,w)] [config] [commission(w)] [pledge(w)] [vault(w)]
    ///           [backer_token(w)] [treasury_token(w)] [mint] [system_program] [token_program]
    Pledge { amount: u64 },

    /// 3. Creator nominates an agent. Requires status == Funded.
    /// Accounts: [creator(s)] [commission(w)] [agent]
    SelectAgent,

    /// 4. Creator accepts a milestone; escrow releases that slice.
    /// Accounts: [creator(s)] [commission(w)] [vault(w)] [agent_token(w)]
    ///           [treasury_token(w)] [mint] [token_program]
    ReleaseMilestone { index: u8 },

    /// 5. Backer withdraws their pro-rata share of whatever was never released.
    /// Accounts: [backer(s)] [commission(w)] [pledge(w)] [vault(w)]
    ///           [backer_token(w)] [treasury_token(w)] [mint] [token_program]
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
fn assert_pda(expected_seeds: &[&[u8]], program_id: &Pubkey, ai: &AccountInfo) -> Result<u8, ProgramError> {
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

/// The treasury token account must be owned by the treasury wallet recorded on
/// the commission, and hold the commission's mint. Both are checked; neither is
/// inferred.
fn assert_treasury_token(ai: &AccountInfo, c: &Commission) -> ProgramResult {
    let t = spl::unpack(ai)?;
    if t.owner != c.treasury {
        msg!("treasury token account has wrong owner");
        return Err(EscrowError::BadTreasury.into());
    }
    if t.mint != c.mint {
        return Err(EscrowError::BadMint.into());
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
    let lamports = rent.minimum_balance(space);
    let ix = system_instruction::create_account(
        payer.key,
        new_account.key,
        lamports,
        space as u64,
        program_id,
    );
    invoke_signed(
        &ix,
        &[payer.clone(), new_account.clone(), system_program.clone()],
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
        Instruction::CreateCommission { seed, goal, milestone_bps, deadline } => {
            create_commission(program_id, accounts, seed, goal, milestone_bps, deadline)
        }
        Instruction::Pledge { amount } => pledge(program_id, accounts, amount),
        Instruction::SelectAgent => select_agent(program_id, accounts),
        Instruction::ReleaseMilestone { index } => release_milestone(program_id, accounts, index),
        Instruction::Refund => refund(program_id, accounts),
        Instruction::Cancel => cancel(program_id, accounts),
        Instruction::SetPaused { paused } => set_paused(program_id, accounts, paused),
        Instruction::AcceptAgent => accept_agent(program_id, accounts),
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

    let cfg = Config { tag: TAG_CONFIG, admin: *payer.key, treasury, paused: false, bump };
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
) -> ProgramResult {
    let ai = &mut accounts.iter();
    let creator = next_account_info(ai)?;
    let config_ai = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let vault_ai = next_account_info(ai)?;
    let mint_ai = next_account_info(ai)?;
    let system_program = next_account_info(ai)?;
    let token_program = next_account_info(ai)?;

    assert_signer(creator)?;
    spl::assert_token_program(token_program)?;
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

    if goal == 0 {
        return Err(EscrowError::AmountZero.into());
    }
    let now = Clock::get()?.unix_timestamp;
    if deadline <= now {
        return Err(EscrowError::DeadlineInPast.into());
    }

    // Milestone weights must be a real schedule that sums to 100%.
    if milestone_bps.is_empty() || milestone_bps.len() > MAX_MILESTONES {
        return Err(EscrowError::BadMilestones.into());
    }
    let mut sum: u32 = 0;
    for b in &milestone_bps {
        if *b == 0 {
            return Err(EscrowError::BadMilestones.into());
        }
        sum = sum.checked_add(*b as u32).ok_or(EscrowError::MathOverflow)?;
    }
    if sum as u64 != BPS_DENOMINATOR {
        msg!("milestone bps must sum to 10000");
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
    let v_bump = assert_pda(&[SEED_VAULT, commission_ai.key.as_ref()], program_id, vault_ai)?;
    if !vault_ai.data_is_empty() {
        return Err(EscrowError::AlreadyInitialized.into());
    }
    // Reject malformed or non-classic mints before spending rent on either PDA.
    let _decimals = spl::mint_decimals(mint_ai)?;

    create_pda_account(
        creator,
        commission_ai,
        system_program,
        program_id,
        Commission::LEN,
        &[SEED_COMMISSION, creator.key.as_ref(), &seed_bytes, &[c_bump]],
    )?;

    // The vault is an SPL token account whose address and token authority are
    // the same PDA. The System Program creates it owned by classic SPL Token;
    // InitializeAccount3 then binds the commission mint and PDA authority.
    let rent = Rent::get()?;
    let create_vault = system_instruction::create_account(
        creator.key,
        vault_ai.key,
        rent.minimum_balance(spl::ACCOUNT_LEN),
        spl::ACCOUNT_LEN as u64,
        &spl::TOKEN_PROGRAM_ID,
    );
    invoke_signed(
        &create_vault,
        &[creator.clone(), vault_ai.clone(), system_program.clone()],
        &[&[SEED_VAULT, commission_ai.key.as_ref(), &[v_bump]]],
    )?;
    spl::initialize_account3(token_program, vault_ai, mint_ai, vault_ai.key)?;

    let mut bps = [0u16; MAX_MILESTONES];
    bps[..milestone_bps.len()].copy_from_slice(&milestone_bps);

    let c = Commission {
        tag: TAG_COMMISSION,
        creator: *creator.key,
        mint: *mint_ai.key,
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
    };
    save(commission_ai, &c)?;
    msg!("commission created");
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
    let backer_token = next_account_info(ai)?;
    let treasury_token = next_account_info(ai)?;
    let mint_ai = next_account_info(ai)?;
    let system_program = next_account_info(ai)?;
    let token_program = next_account_info(ai)?;

    assert_signer(backer)?;
    spl::assert_token_program(token_program)?;
    if amount == 0 {
        return Err(EscrowError::AmountZero.into());
    }

    assert_owned_by_program(config_ai, program_id)?;
    assert_pda(&[SEED_CONFIG], program_id, config_ai)?;
    if *system_program.key != solana_program::system_program::ID {
        return Err(EscrowError::BadOwner.into());
    }
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
    if *mint_ai.key != c.mint {
        return Err(EscrowError::BadMint.into());
    }
    assert_pda(&[SEED_VAULT, commission_ai.key.as_ref()], program_id, vault_ai)?;
    assert_treasury_token(treasury_token, &c)?;

    // The vault must be a token account for this mint, owned by the vault PDA.
    let vault = spl::unpack(vault_ai)?;
    if vault.mint != c.mint || vault.owner != *vault_ai.key {
        return Err(EscrowError::BadMint.into());
    }
    // The source must belong to the signer, or a stolen-token path opens up.
    let src = spl::unpack(backer_token)?;
    if src.owner != *backer.key || src.mint != c.mint {
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
            &[SEED_PLEDGE, commission_ai.key.as_ref(), backer.key.as_ref(), &[p_bump]],
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
        // Guard against a pledge PDA from a different commission/backer being
        // passed in; the PDA check above already covers this, but a mismatch
        // here means state corruption and must never be written through.
        if existing.commission != *commission_ai.key || existing.backer != *backer.key {
            return Err(EscrowError::BadPda.into());
        }
        existing
    };

    let (fee, net) = split_fee(amount)?;
    if net == 0 {
        return Err(EscrowError::AmountZero.into());
    }

    // ── effects, before any transfer ──
    p.amount = p.amount.checked_add(net).ok_or(EscrowError::MathOverflow)?;
    c.total_pledged = c.total_pledged.checked_add(net).ok_or(EscrowError::MathOverflow)?;
    if new_pledger {
        c.pledger_count = c.pledger_count.checked_add(1).ok_or(EscrowError::MathOverflow)?;
    }
    if c.total_pledged >= c.goal {
        c.status = Status::Funded;
    }
    save(pledge_ai, &p)?;
    save(commission_ai, &c)?;

    // ── interactions ──
    let decimals = spl::mint_decimals(mint_ai)?;
    // The backer signs these transfers themselves, so no PDA seeds are needed;
    // the helper selects plain `invoke` when the seed slice is empty.
    spl::transfer_checked_signed(
        token_program, backer_token, mint_ai, vault_ai, backer, net, decimals, &[],
    )?;
    if fee > 0 {
        spl::transfer_checked_signed(
            token_program, backer_token, mint_ai, treasury_token, backer, fee, decimals, &[],
        )?;
    }
    msg!("pledged net={} fee={}", net, fee);
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
    c.pending_agent = *agent.key;
    c.has_pending_agent = true;
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
    c.agent = *agent.key;
    c.has_agent = true;
    c.has_pending_agent = false;
    c.status = Status::Building;
    save(commission_ai, &c)?;
    msg!("agent accepted");
    Ok(())
}

// 4 ── ReleaseMilestone ──────────────────────────────────────────────
fn release_milestone(program_id: &Pubkey, accounts: &[AccountInfo], index: u8) -> ProgramResult {
    let ai = &mut accounts.iter();
    let creator = next_account_info(ai)?;
    let commission_ai = next_account_info(ai)?;
    let vault_ai = next_account_info(ai)?;
    let agent_token = next_account_info(ai)?;
    let treasury_token = next_account_info(ai)?;
    let mint_ai = next_account_info(ai)?;
    let token_program = next_account_info(ai)?;

    assert_signer(creator)?;
    spl::assert_token_program(token_program)?;

    let mut c = load_commission(commission_ai, program_id)?;
    if c.creator != *creator.key {
        return Err(EscrowError::Unauthorized.into());
    }
    if c.status != Status::Building {
        return Err(EscrowError::BadStatus.into());
    }
    if !c.has_agent {
        return Err(EscrowError::AgentNotSet.into());
    }
    if index as usize >= c.milestone_count as usize {
        return Err(EscrowError::BadMilestones.into());
    }
    let bit = 1u8 << index;
    if c.milestones_done & bit != 0 {
        return Err(EscrowError::MilestoneAlreadyReleased.into());
    }
    if *mint_ai.key != c.mint {
        return Err(EscrowError::BadMint.into());
    }
    let v_bump = assert_pda(&[SEED_VAULT, commission_ai.key.as_ref()], program_id, vault_ai)?;
    assert_treasury_token(treasury_token, &c)?;

    // Payout destination must belong to the selected agent.
    let dst = spl::unpack(agent_token)?;
    if dst.owner != c.agent || dst.mint != c.mint {
        return Err(EscrowError::BadOwner.into());
    }

    let all_mask = if c.milestone_count == 8 { u8::MAX } else { (1u8 << c.milestone_count) - 1 };
    let completes_schedule = (c.milestones_done | bit) == all_mask;
    // The final outstanding milestone receives every token still in escrow.
    // Earlier slices floor independently; assigning the residual here closes
    // the vault exactly and prevents permanent rounding dust.
    let gross = if completes_schedule {
        c.escrow_remaining()?
    } else {
        mul_div(c.total_pledged, c.milestone_bps[index as usize] as u64, BPS_DENOMINATOR)?
    };
    if gross == 0 {
        return Err(EscrowError::AmountZero.into());
    }
    if gross > c.escrow_remaining()? {
        return Err(EscrowError::InsufficientVault.into());
    }
    let (fee, net) = split_fee(gross)?;

    // ── effects ──
    c.milestones_done |= bit;
    c.released = c.released.checked_add(gross).ok_or(EscrowError::MathOverflow)?;
    if completes_schedule {
        c.status = Status::Delivered;
    }
    save(commission_ai, &c)?;

    // ── interactions ──
    let decimals = spl::mint_decimals(mint_ai)?;
    let commission_key = *commission_ai.key;
    let seeds: &[&[u8]] = &[SEED_VAULT, commission_key.as_ref(), &[v_bump]];
    spl::transfer_checked_signed(
        token_program, vault_ai, mint_ai, agent_token, vault_ai, net, decimals, seeds,
    )?;
    if fee > 0 {
        spl::transfer_checked_signed(
            token_program, vault_ai, mint_ai, treasury_token, vault_ai, fee, decimals, seeds,
        )?;
    }
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
    let backer_token = next_account_info(ai)?;
    let treasury_token = next_account_info(ai)?;
    let mint_ai = next_account_info(ai)?;
    let token_program = next_account_info(ai)?;

    assert_signer(backer)?;
    spl::assert_token_program(token_program)?;

    let mut c = load_commission(commission_ai, program_id)?;
    let now = Clock::get()?.unix_timestamp;

    // Refunds are open when the commission was terminated, or when it never
    // funded and its deadline has passed. A Building commission is NOT
    // refundable — that is what makes the agent's contract worth taking.
    let refundable = c.status == Status::Cancelled
        || (c.status == Status::Funding && now >= c.deadline);
    if !refundable {
        return Err(EscrowError::BadStatus.into());
    }
    if *mint_ai.key != c.mint {
        return Err(EscrowError::BadMint.into());
    }
    let v_bump = assert_pda(&[SEED_VAULT, commission_ai.key.as_ref()], program_id, vault_ai)?;
    assert_pda(
        &[SEED_PLEDGE, commission_ai.key.as_ref(), backer.key.as_ref()],
        program_id,
        pledge_ai,
    )?;
    assert_treasury_token(treasury_token, &c)?;
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

    let dst = spl::unpack(backer_token)?;
    if dst.owner != *backer.key || dst.mint != c.mint {
        return Err(EscrowError::BadOwner.into());
    }

    // Pro-rata of what was never released, by share of total pledged.
    // Widened to u128 inside mul_div, so no overflow for any u64 inputs.
    let never_released = c
        .total_pledged
        .checked_sub(c.released)
        .ok_or(EscrowError::MathOverflow)?;
    let is_last_refunder = c.refunded_pledger_count.checked_add(1)
        .ok_or(EscrowError::MathOverflow)? == c.pledger_count;
    let entitled = mul_div(never_released, p.amount, c.total_pledged)?;
    // Every non-last backer gets the floored pro-rata amount. The last gets the
    // entire residual, which consists only of accumulated division dust.
    let gross = if is_last_refunder {
        c.escrow_remaining()?
    } else {
        entitled.checked_sub(p.refunded).ok_or(EscrowError::MathOverflow)?
    };
    if gross == 0 {
        return Err(EscrowError::NothingToRefund.into());
    }
    if gross > c.escrow_remaining()? {
        return Err(EscrowError::InsufficientVault.into());
    }
    let (fee, net) = split_fee(gross)?;

    // ── effects ──
    p.refunded = p.refunded.checked_add(gross).ok_or(EscrowError::MathOverflow)?;
    p.fully_refunded = true;
    c.refunded = c.refunded.checked_add(gross).ok_or(EscrowError::MathOverflow)?;
    c.refunded_pledger_count = c.refunded_pledger_count.checked_add(1)
        .ok_or(EscrowError::MathOverflow)?;
    save(pledge_ai, &p)?;
    save(commission_ai, &c)?;

    // ── interactions ──
    let decimals = spl::mint_decimals(mint_ai)?;
    let commission_key = *commission_ai.key;
    let seeds: &[&[u8]] = &[SEED_VAULT, commission_key.as_ref(), &[v_bump]];
    spl::transfer_checked_signed(
        token_program, vault_ai, mint_ai, backer_token, vault_ai, net, decimals, seeds,
    )?;
    if fee > 0 {
        spl::transfer_checked_signed(
            token_program, vault_ai, mint_ai, treasury_token, vault_ai, fee, decimals, seeds,
        )?;
    }
    msg!("refunded net={} fee={}", net, fee);
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
    if !creator_may_cancel && now < c.deadline {
        return Err(EscrowError::DeadlineNotPassed.into());
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
            assert_eq!(fee.checked_add(net).unwrap(), gross, "fee+net must equal gross");
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
        assert!(mul_div(u64::MAX, 2, 1).is_err(), "must reject results above u64");
        assert!(mul_div(1, 1, 0).is_err(), "must reject zero denominator");
    }

    #[test]
    fn milestone_slices_never_exceed_the_pot() {
        let total: u64 = 1_000_000_007;
        let bps = [3000u64, 3000, 2500, 1500];
        let sum: u64 = bps.iter().map(|b| mul_div(total, *b, BPS_DENOMINATOR).unwrap()).sum();
        assert!(sum <= total, "integer division must leave dust in the vault, never overdraw");
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
        assert!(c.escrow_remaining().is_err(), "must not underflow into a huge number");
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
        }
    }
}

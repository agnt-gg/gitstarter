//! Adversarial suite. Every test here corresponds to a way real money could be
//! stolen, stranded, or blocked. Each one fails against the pre-hardening
//! program and passes against the current one.

use borsh::{BorshDeserialize, BorshSerialize};
use gitstarter_escrow::{
    process_instruction, Commission, Config, Instruction as EscrowInstruction, Status,
    SEED_COMMISSION, SEED_CONFIG, SEED_PLEDGE, SEED_VAULT,
};
use solana_program::{
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_instruction, system_program,
};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    signature::{Keypair, Signer},
    transaction::Transaction,
};

const PROGRAM_ID: Pubkey = solana_program::pubkey!("6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy");
const LAMPORTS: u64 = 10_000_000_000;

/// Deadlines are now bounded, so tests must pick one the program will accept.
async fn soon(ctx: &mut ProgramTestContext, seconds: i64) -> i64 {
    ctx.banks_client
        .get_sysvar::<Clock>()
        .await
        .unwrap()
        .unix_timestamp
        + seconds
}
const A_WEEK: i64 = 7 * 86_400;

// Rent-exemption minimums, which are what account closing hands back. Solana
// charges for 128 bytes of account overhead plus the data itself, at 6960
// lamports per byte. Written out rather than computed so a silent change in
// either account's size shows up here as a failing number.
const PLEDGE_RENT: u64 = (128 + 83) * 6960; // 1_468_560
const VAULT_RENT: u64 = 128 * 6960; //         890_880

fn funded() -> Account {
    Account {
        lamports: LAMPORTS,
        data: vec![],
        owner: system_program::ID,
        executable: false,
        rent_epoch: 0,
    }
}

async fn send(
    ctx: &mut ProgramTestContext,
    ixs: &[Instruction],
    signers: &[&Keypair],
) -> Result<(), solana_program_test::BanksClientError> {
    let blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let mut all = vec![&ctx.payer];
    all.extend_from_slice(signers);
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            ixs,
            Some(&ctx.payer.pubkey()),
            &all,
            blockhash,
        ))
        .await
}

async fn balance(ctx: &mut ProgramTestContext, key: Pubkey) -> u64 {
    ctx.banks_client.get_balance(key).await.unwrap()
}

async fn warp_past(ctx: &mut ProgramTestContext, deadline: i64) {
    let mut clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp = deadline + 1;
    ctx.set_sysvar(&clock);
}

async fn commission_state(ctx: &mut ProgramTestContext, key: Pubkey) -> Commission {
    Commission::try_from_slice(
        &ctx.banks_client
            .get_account(key)
            .await
            .unwrap()
            .unwrap()
            .data,
    )
    .unwrap()
}

fn ix(accounts: Vec<AccountMeta>, instruction: EscrowInstruction) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts,
        data: instruction.try_to_vec().unwrap(),
    }
}

struct World {
    ctx: ProgramTestContext,
    creator: Keypair,
    backer_a: Keypair,
    backer_b: Keypair,
    agent: Keypair,
    treasury: Keypair,
    config: Pubkey,
}

async fn world() -> World {
    let creator = Keypair::new();
    let backer_a = Keypair::new();
    let backer_b = Keypair::new();
    let agent = Keypair::new();
    let treasury = Keypair::new();
    let (config, bump) = Pubkey::find_program_address(&[SEED_CONFIG], &PROGRAM_ID);
    let state = Config {
        tag: 1,
        admin: treasury.pubkey(),
        treasury: treasury.pubkey(),
        paused: false,
        bump,
    };
    let mut data = vec![0u8; Config::LEN];
    state.serialize(&mut &mut data[..]).unwrap();

    let mut pt = ProgramTest::new(
        "gitstarter_escrow",
        PROGRAM_ID,
        processor!(process_instruction),
    );
    for key in [
        creator.pubkey(),
        backer_a.pubkey(),
        backer_b.pubkey(),
        agent.pubkey(),
        treasury.pubkey(),
    ] {
        pt.add_account(key, funded());
    }
    pt.add_account(
        config,
        Account {
            lamports: LAMPORTS,
            data,
            owner: PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    World {
        ctx: pt.start_with_context().await,
        creator,
        backer_a,
        backer_b,
        agent,
        treasury,
        config,
    }
}

fn addresses(creator: Pubkey, seed: u64) -> (Pubkey, Pubkey) {
    let (commission, _) = Pubkey::find_program_address(
        &[SEED_COMMISSION, creator.as_ref(), &seed.to_le_bytes()],
        &PROGRAM_ID,
    );
    let (vault, _) = Pubkey::find_program_address(&[SEED_VAULT, commission.as_ref()], &PROGRAM_ID);
    (commission, vault)
}

fn pledge_pda(commission: Pubkey, backer: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[SEED_PLEDGE, commission.as_ref(), backer.as_ref()],
        &PROGRAM_ID,
    )
    .0
}

fn create_ix(
    creator: Pubkey,
    config: Pubkey,
    commission: Pubkey,
    vault: Pubkey,
    seed: u64,
    goal: u64,
    bps: Vec<u16>,
    deadline: i64,
) -> Instruction {
    ix(
        vec![
            AccountMeta::new(creator, true),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(commission, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        EscrowInstruction::CreateCommission {
            seed,
            goal,
            milestone_bps: bps,
            deadline,
            // Zero selects the program defaults; individual tests that care
            // about the clocks set them explicitly.
            delivery_window: 0,
            review_window: 0,
        },
    )
}

fn pledge_ix(
    backer: Pubkey,
    config: Pubkey,
    commission: Pubkey,
    vault: Pubkey,
    amount: u64,
) -> Instruction {
    ix(
        vec![
            AccountMeta::new(backer, true),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(commission, false),
            AccountMeta::new(pledge_pda(commission, backer), false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        EscrowInstruction::Pledge { amount },
    )
}

fn nominate_ix(creator: Pubkey, commission: Pubkey, agent: Pubkey) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(creator, true),
            AccountMeta::new(commission, false),
            AccountMeta::new_readonly(agent, false),
        ],
        EscrowInstruction::SelectAgent,
    )
}

fn accept_ix(agent: Pubkey, commission: Pubkey) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(agent, true),
            AccountMeta::new(commission, false),
        ],
        EscrowInstruction::AcceptAgent,
    )
}

fn release_ix(
    creator: Pubkey,
    commission: Pubkey,
    vault: Pubkey,
    agent: Pubkey,
    treasury: Pubkey,
    index: u8,
) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(creator, true),
            AccountMeta::new(commission, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(agent, false),
            AccountMeta::new(treasury, false),
        ],
        EscrowInstruction::ReleaseMilestone { index },
    )
}

fn cancel_ix(signer: Pubkey, commission: Pubkey) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(signer, true),
            AccountMeta::new(commission, false),
        ],
        EscrowInstruction::Cancel,
    )
}

fn submit_ix(agent: Pubkey, commission: Pubkey, index: u8) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(agent, true),
            AccountMeta::new(commission, false),
        ],
        EscrowInstruction::SubmitDelivery {
            index,
            evidence_hash: [7u8; 32],
        },
    )
}

fn reject_ix(creator: Pubkey, commission: Pubkey) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(creator, true),
            AccountMeta::new(commission, false),
        ],
        EscrowInstruction::RejectDelivery,
    )
}

fn create_with_windows(
    creator: Pubkey,
    config: Pubkey,
    commission: Pubkey,
    vault: Pubkey,
    seed: u64,
    goal: u64,
    bps: Vec<u16>,
    deadline: i64,
    delivery_window: i64,
    review_window: i64,
) -> Instruction {
    ix(
        vec![
            AccountMeta::new(creator, true),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(commission, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        EscrowInstruction::CreateCommission {
            seed,
            goal,
            milestone_bps: bps,
            deadline,
            delivery_window,
            review_window,
        },
    )
}

fn revoke_ix(creator: Pubkey, commission: Pubkey) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(creator, true),
            AccountMeta::new(commission, false),
        ],
        EscrowInstruction::RevokeAgent,
    )
}

fn refund_ix(backer: Pubkey, commission: Pubkey, vault: Pubkey, treasury: Pubkey) -> Instruction {
    ix(
        vec![
            AccountMeta::new(backer, true),
            AccountMeta::new(commission, false),
            AccountMeta::new(pledge_pda(commission, backer), false),
            AccountMeta::new(vault, false),
            AccountMeta::new(treasury, false),
        ],
        EscrowInstruction::Refund,
    )
}

/// THE theft path: creator funds a commission with other people's money, names
/// their own wallet as the agent, and releases everything to themselves.
#[tokio::test]
async fn creator_cannot_name_themselves_as_the_paid_agent() {
    let mut w = world().await;
    let seed = 1;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_ix(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();

    assert!(
        send(
            &mut w.ctx,
            &[nominate_ix(
                w.creator.pubkey(),
                commission,
                w.creator.pubkey()
            )],
            &[&w.creator],
        )
        .await
        .is_err(),
        "creator must not be able to pay themselves out of backer funds"
    );

    // The backer's money is untouched and still refundable.
    assert_eq!(balance(&mut w.ctx, vault).await - 890_880, 1_000_000);
}

/// A commission at its deadline is already refundable. Taking new money into
/// that state previously let pledges and refunds interleave, which could carry
/// a non-zero `refunded` balance into Building and strand a milestone forever.
#[tokio::test]
async fn pledges_are_refused_once_the_deadline_has_passed() {
    let mut w = world().await;
    let seed = 2;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    let deadline = w
        .ctx
        .banks_client
        .get_sysvar::<Clock>()
        .await
        .unwrap()
        .unix_timestamp
        + 1_000;
    send(
        &mut w.ctx,
        &[create_ix(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            10_000_000,
            vec![10_000],
            deadline,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();

    let mut clock: Clock = w.ctx.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp = deadline + 1;
    w.ctx.set_sysvar(&clock);

    assert!(
        send(
            &mut w.ctx,
            &[pledge_ix(
                w.backer_b.pubkey(),
                w.config,
                commission,
                vault,
                1_000_000
            )],
            &[&w.backer_b],
        )
        .await
        .is_err(),
        "an expired commission must not accept new money"
    );

    // The backer who did fund it in time can still get every lamport back.
    let before = balance(&mut w.ctx, w.backer_a.pubkey()).await;
    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    assert!(balance(&mut w.ctx, w.backer_a.pubkey()).await > before);
    assert_eq!(balance(&mut w.ctx, vault).await, 890_880);
}

/// An agent who cannot finish should be able to hand the money back immediately
/// rather than making backers wait out the deadline.
#[tokio::test]
async fn contracted_agent_can_walk_away_and_free_the_escrow() {
    let mut w = world().await;
    let seed = 3;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_ix(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![5_000, 5_000],
            dl,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();

    // Mid-build the creator is locked out, so an agent who has started work
    // cannot be rugged.
    assert!(
        send(
            &mut w.ctx,
            &[cancel_ix(w.creator.pubkey(), commission)],
            &[&w.creator]
        )
        .await
        .is_err(),
        "creator must not cancel out from under a working agent"
    );
    // A stranger cannot cancel either.
    assert!(send(
        &mut w.ctx,
        &[cancel_ix(w.backer_b.pubkey(), commission)],
        &[&w.backer_b]
    )
    .await
    .is_err());

    send(
        &mut w.ctx,
        &[cancel_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();
    assert_eq!(
        commission_state(&mut w.ctx, commission).await.status,
        Status::Cancelled
    );

    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    assert_eq!(balance(&mut w.ctx, vault).await, 890_880);
}

/// Vault and pledge addresses are deterministic, so a stranger can send them a
/// lamport before the owner gets there. That must not be able to brick an
/// address permanently.
#[tokio::test]
async fn a_prefunded_vault_address_cannot_block_creation() {
    let mut w = world().await;
    let seed = 4;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;

    // The runtime itself refuses to leave an account holding a non-zero balance
    // below rent exemption, so the cheapest possible grief is a full 0-byte rent
    // reserve rather than the single lamport one might expect.
    assert!(
        send(
            &mut w.ctx,
            &[system_instruction::transfer(
                &w.backer_b.pubkey(),
                &vault,
                1
            )],
            &[&w.backer_b],
        )
        .await
        .is_err(),
        "a dust-funded account is not a state Solana will persist"
    );

    send(
        &mut w.ctx,
        &[system_instruction::transfer(
            &w.backer_b.pubkey(),
            &vault,
            890_880,
        )],
        &[&w.backer_b],
    )
    .await
    .unwrap();
    assert_eq!(balance(&mut w.ctx, vault).await, 890_880);

    send(
        &mut w.ctx,
        &[create_ix(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
        )],
        &[&w.creator],
    )
    .await
    .expect("griefing a precomputable address must not block the creator");

    // And the commission is fully functional afterwards.
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    assert_eq!(
        commission_state(&mut w.ctx, commission).await.status,
        Status::Funded
    );
}

/// Conservation across a full two-backer lifecycle, plus the authorisation
/// checks that guard each money-moving instruction.
#[tokio::test]
async fn full_lifecycle_conserves_every_lamport_and_rejects_impostors() {
    let mut w = world().await;
    let seed = 5;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_ix(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            3_000_001,
            vec![3_000, 7_000],
            dl,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();

    // Deliberately awkward amounts so integer division leaves dust.
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_001,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_b.pubkey(),
            w.config,
            commission,
            vault,
            2_000_000,
        )],
        &[&w.backer_b],
    )
    .await
    .unwrap();

    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    // Only the nominated wallet may accept.
    assert!(send(
        &mut w.ctx,
        &[accept_ix(w.backer_b.pubkey(), commission)],
        &[&w.backer_b]
    )
    .await
    .is_err());
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();

    // A stranger cannot release, and neither can a swapped-in treasury.
    assert!(
        send(
            &mut w.ctx,
            &[release_ix(
                w.backer_a.pubkey(),
                commission,
                vault,
                w.agent.pubkey(),
                w.treasury.pubkey(),
                0
            )],
            &[&w.backer_a],
        )
        .await
        .is_err(),
        "only the creator may accept a milestone"
    );
    let thief = Keypair::new();
    assert!(
        send(
            &mut w.ctx,
            &[release_ix(
                w.creator.pubkey(),
                commission,
                vault,
                w.agent.pubkey(),
                thief.pubkey(),
                0
            )],
            &[&w.creator],
        )
        .await
        .is_err(),
        "protocol fees must not be redirectable"
    );
    assert!(
        send(
            &mut w.ctx,
            &[release_ix(
                w.creator.pubkey(),
                commission,
                vault,
                thief.pubkey(),
                w.treasury.pubkey(),
                0
            )],
            &[&w.creator],
        )
        .await
        .is_err(),
        "payouts must not be redirectable"
    );

    let agent_before = balance(&mut w.ctx, w.agent.pubkey()).await;
    let treasury_before = balance(&mut w.ctx, w.treasury.pubkey()).await;
    send(
        &mut w.ctx,
        &[release_ix(
            w.creator.pubkey(),
            commission,
            vault,
            w.agent.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    // Replay of an accepted milestone must not pay twice.
    assert!(send(
        &mut w.ctx,
        &[release_ix(
            w.creator.pubkey(),
            commission,
            vault,
            w.agent.pubkey(),
            w.treasury.pubkey(),
            0
        )],
        &[&w.creator],
    )
    .await
    .is_err());

    let gross_first = 3_000_001u64 * 3_000 / 10_000;
    let fee_first = gross_first / 100;
    assert_eq!(
        balance(&mut w.ctx, w.agent.pubkey()).await - agent_before,
        gross_first - fee_first
    );
    assert_eq!(
        balance(&mut w.ctx, w.treasury.pubkey()).await - treasury_before,
        fee_first
    );

    send(
        &mut w.ctx,
        &[release_ix(
            w.creator.pubkey(),
            commission,
            vault,
            w.agent.pubkey(),
            w.treasury.pubkey(),
            1,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();

    let c = commission_state(&mut w.ctx, commission).await;
    assert_eq!(c.status, Status::Delivered);
    assert_eq!(c.total_pledged, 3_000_001);
    assert_eq!(c.released + c.refunded, c.total_pledged, "conservation");
    assert_eq!(
        balance(&mut w.ctx, vault).await,
        890_880,
        "delivered commissions must leave zero escrow behind, dust included"
    );
    // Agent + treasury together received exactly the pot.
    assert_eq!(
        (balance(&mut w.ctx, w.agent.pubkey()).await - agent_before)
            + (balance(&mut w.ctx, w.treasury.pubkey()).await - treasury_before),
        3_000_001
    );
    // Total fee is exactly 1% after flooring on each slice.
    assert!(balance(&mut w.ctx, w.treasury.pubkey()).await - treasury_before <= 30_001);
}

/// A backer must not be able to drain the vault by refunding repeatedly, and a
/// stranger must not be able to refund against someone else's pledge.
#[tokio::test]
async fn refunds_cannot_be_replayed_or_stolen() {
    let mut w = world().await;
    let seed = 6;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_ix(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            5_000_000,
            vec![10_000],
            dl,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[cancel_ix(w.creator.pubkey(), commission)],
        &[&w.creator],
    )
    .await
    .unwrap();

    // Someone with no pledge of their own gets nothing.
    assert!(send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_b.pubkey(),
            commission,
            vault,
            w.treasury.pubkey()
        )],
        &[&w.backer_b]
    )
    .await
    .is_err());

    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    assert!(
        send(
            &mut w.ctx,
            &[refund_ix(
                w.backer_a.pubkey(),
                commission,
                vault,
                w.treasury.pubkey()
            )],
            &[&w.backer_a]
        )
        .await
        .is_err(),
        "a refund must not be replayable"
    );
    assert_eq!(balance(&mut w.ctx, vault).await, 890_880);
}

/// The permanent-lock finding. A deadline far enough out is indistinguishable
/// from "never": mid-build nobody but the agent can cancel, so escrow with an
/// unbounded deadline could be held hostage forever.
#[tokio::test]
async fn a_deadline_cannot_be_set_far_enough_out_to_lock_escrow_forever() {
    let mut w = world().await;
    let seed = 7;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let absurd = soon(&mut w.ctx, 400 * 86_400).await;
    assert!(
        send(
            &mut w.ctx,
            &[create_ix(
                w.creator.pubkey(),
                w.config,
                commission,
                vault,
                seed,
                1_000_000,
                vec![10_000],
                absurd
            )],
            &[&w.creator],
        )
        .await
        .is_err(),
        "an unbounded deadline is a permanent-lock primitive and must be refused"
    );
    assert!(send(
        &mut w.ctx,
        &[create_ix(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            i64::MAX / 2
        )],
        &[&w.creator],
    )
    .await
    .is_err());

    // A deadline inside the ceiling is still accepted.
    let sane = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_ix(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            sane,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
}

/// An expired commission must not be revivable into Building, where the creator
/// could still pay it out from under backers who consider it dead.
#[tokio::test]
async fn an_expired_commission_cannot_be_accepted_and_stays_refundable() {
    let mut w = world().await;
    let seed = 8;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_ix(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();

    warp_past(&mut w.ctx, dl).await;

    assert!(
        send(
            &mut w.ctx,
            &[accept_ix(w.agent.pubkey(), commission)],
            &[&w.agent]
        )
        .await
        .is_err(),
        "a nominee must not be able to revive an expired commission"
    );

    // Funded-but-expired is refundable directly, with no third-party Cancel.
    assert_eq!(
        commission_state(&mut w.ctx, commission).await.status,
        Status::Funded
    );
    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .expect("an expired funded commission must refund without needing a cancel first");
    assert_eq!(balance(&mut w.ctx, vault).await, 890_880);
}

/// A creator must not be held hostage by a nominee who never accepts.
#[tokio::test]
async fn an_unaccepted_nomination_can_be_withdrawn() {
    let mut w = world().await;
    let seed = 9;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_ix(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.backer_b.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();

    // A stranger cannot withdraw someone else's nomination.
    assert!(send(
        &mut w.ctx,
        &[revoke_ix(w.backer_a.pubkey(), commission)],
        &[&w.backer_a]
    )
    .await
    .is_err());

    send(
        &mut w.ctx,
        &[revoke_ix(w.creator.pubkey(), commission)],
        &[&w.creator],
    )
    .await
    .unwrap();
    // The withdrawn nominee can no longer accept, and someone else can be named.
    assert!(send(
        &mut w.ctx,
        &[accept_ix(w.backer_b.pubkey(), commission)],
        &[&w.backer_b]
    )
    .await
    .is_err());
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();
    assert_eq!(
        commission_state(&mut w.ctx, commission).await.status,
        Status::Building
    );
    // Once accepted, the creator can no longer withdraw it.
    assert!(send(
        &mut w.ctx,
        &[revoke_ix(w.creator.pubkey(), commission)],
        &[&w.creator]
    )
    .await
    .is_err());
}

/// Backers whose pro-rata share floors to zero must still be able to settle.
/// Refusing them froze `refunded_pledger_count`, so the final refunder's sweep
/// never fired and the remainder stranded permanently.
#[tokio::test]
async fn dust_sized_backers_cannot_freeze_the_refund_sweep() {
    let mut w = world().await;
    let seed = 10;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_ix(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000_000,
            vec![9_000, 1_000],
            dl,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();

    // Two griefers pledge 9 lamports each: after a 90% release their entitlement
    // floors to zero.
    let g1 = Keypair::new();
    let g2 = Keypair::new();
    for g in [&g1, &g2] {
        send(
            &mut w.ctx,
            &[system_instruction::transfer(
                &w.treasury.pubkey(),
                &g.pubkey(),
                50_000_000,
            )],
            &[&w.treasury],
        )
        .await
        .unwrap();
    }
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            600_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_b.pubkey(),
            w.config,
            commission,
            vault,
            399_999_982,
        )],
        &[&w.backer_b],
    )
    .await
    .unwrap();
    for g in [&g1, &g2] {
        send(
            &mut w.ctx,
            &[pledge_ix(g.pubkey(), w.config, commission, vault, 9)],
            &[g],
        )
        .await
        .unwrap();
    }

    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[release_ix(
            w.creator.pubkey(),
            commission,
            vault,
            w.agent.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[cancel_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();

    // Every backer settles, including the two entitled to nothing.
    for (kp, label) in [
        (&w.backer_a, "backer_a"),
        (&w.backer_b, "backer_b"),
        (&g1, "zero-entitled g1"),
        (&g2, "zero-entitled g2"),
    ] {
        send(
            &mut w.ctx,
            &[refund_ix(
                kp.pubkey(),
                commission,
                vault,
                w.treasury.pubkey(),
            )],
            &[kp],
        )
        .await
        .unwrap_or_else(|e| panic!("{label} could not settle: {e:?}"));
    }

    let c = commission_state(&mut w.ctx, commission).await;
    assert_eq!(c.refunded_pledger_count, c.pledger_count);
    assert_eq!(c.released + c.refunded, c.total_pledged, "conservation");
    assert_eq!(
        balance(&mut w.ctx, vault).await,
        890_880,
        "the sweep must fire so no lamport strands"
    );
}

// ── the free-work problem ───────────────────────────────────────────────────
//
// Before delivery submission existed, a creator could take delivered work and
// simply never release. It cost them nothing and the agent had no recourse but
// to wait out the deadline and be refunded nothing. These tests pin the fix.

/// The headline guarantee: silence pays. A creator who receives a delivery and
/// says nothing has the milestone released out from under them by anyone.
#[tokio::test]
async fn creator_silence_pays_the_agent_automatically() {
    let mut w = world().await;
    let seed = 11;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    let review = 3_600;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            86_400,
            review,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();

    // Nobody may release on the agent's behalf before a delivery exists.
    assert!(
        send(
            &mut w.ctx,
            &[release_ix(
                w.backer_b.pubkey(),
                commission,
                vault,
                w.agent.pubkey(),
                w.treasury.pubkey(),
                0
            )],
            &[&w.backer_b]
        )
        .await
        .is_err(),
        "with no submission there is nothing for a third party to release"
    );

    send(
        &mut w.ctx,
        &[submit_ix(w.agent.pubkey(), commission, 0)],
        &[&w.agent],
    )
    .await
    .unwrap();

    // The clock has not run yet, so the creator still holds the decision.
    assert!(
        send(
            &mut w.ctx,
            &[release_ix(
                w.backer_b.pubkey(),
                commission,
                vault,
                w.agent.pubkey(),
                w.treasury.pubkey(),
                0
            )],
            &[&w.backer_b]
        )
        .await
        .is_err(),
        "a third party must not pre-empt a review window that is still open"
    );

    let submitted_at = commission_state(&mut w.ctx, commission).await.submitted_at;
    warp_past(&mut w.ctx, submitted_at + review).await;

    let agent_before = balance(&mut w.ctx, w.agent.pubkey()).await;
    let treasury_before = balance(&mut w.ctx, w.treasury.pubkey()).await;
    // An unrelated wallet completes the payment. No arbiter, no privilege.
    send(
        &mut w.ctx,
        &[release_ix(
            w.backer_b.pubkey(),
            commission,
            vault,
            w.agent.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.backer_b],
    )
    .await
    .expect("once the review window lapses anyone may pay the agent");

    assert_eq!(
        balance(&mut w.ctx, w.agent.pubkey()).await - agent_before,
        990_000
    );
    assert_eq!(
        balance(&mut w.ctx, w.treasury.pubkey()).await - treasury_before,
        10_000
    );
    let c = commission_state(&mut w.ctx, commission).await;
    assert_eq!(c.status, Status::Delivered);
    assert_eq!(
        c.auto_releases, 1,
        "an auto-release is recorded against the creator"
    );
    assert!(
        !c.has_pending_submission(),
        "releasing settles the submission"
    );
}

/// Delivered work must not be cancellable out from under the agent — by anyone,
/// including the agent themselves, and including after the delivery deadline.
#[tokio::test]
async fn a_pending_delivery_cannot_be_cancelled_or_refunded_away() {
    let mut w = world().await;
    let seed = 12;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            7_200,
            86_400,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.agent.pubkey(), commission, 0)],
        &[&w.agent],
    )
    .await
    .unwrap();

    let delivery_deadline = commission_state(&mut w.ctx, commission)
        .await
        .delivery_deadline;
    // Push past the delivery deadline while the review window is still open:
    // the moment a creator would most want to cancel and keep the work.
    warp_past(&mut w.ctx, delivery_deadline).await;

    for (who, label) in [
        (&w.creator, "creator"),
        (&w.backer_b, "outsider"),
        (&w.agent, "agent"),
    ] {
        assert!(
            send(&mut w.ctx, &[cancel_ix(who.pubkey(), commission)], &[who])
                .await
                .is_err(),
            "{label} must not be able to cancel around a live delivery claim"
        );
    }
    assert!(
        send(
            &mut w.ctx,
            &[refund_ix(
                w.backer_a.pubkey(),
                commission,
                vault,
                w.treasury.pubkey()
            )],
            &[&w.backer_a]
        )
        .await
        .is_err(),
        "a backer must not be able to refund around a live delivery claim"
    );

    // The claim is not a deadlock: it matures, and then it pays.
    let submitted_at = commission_state(&mut w.ctx, commission).await.submitted_at;
    warp_past(&mut w.ctx, submitted_at + 86_400).await;
    let agent_before = balance(&mut w.ctx, w.agent.pubkey()).await;
    send(
        &mut w.ctx,
        &[release_ix(
            w.backer_b.pubkey(),
            commission,
            vault,
            w.agent.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.backer_b],
    )
    .await
    .unwrap();
    assert_eq!(
        balance(&mut w.ctx, w.agent.pubkey()).await - agent_before,
        990_000
    );
}

/// A creator may still refuse work — but only on the record, and only while the
/// window is theirs. Refusal is counted.
#[tokio::test]
async fn rejection_is_recorded_and_cannot_be_used_to_stop_a_matured_claim() {
    let mut w = world().await;
    let seed = 13;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    let review = 3_600;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            86_400,
            review,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();

    assert!(
        send(
            &mut w.ctx,
            &[reject_ix(w.creator.pubkey(), commission)],
            &[&w.creator]
        )
        .await
        .is_err(),
        "there is nothing to reject before a delivery is submitted"
    );

    send(
        &mut w.ctx,
        &[submit_ix(w.agent.pubkey(), commission, 0)],
        &[&w.agent],
    )
    .await
    .unwrap();
    // Only the creator judges.
    assert!(
        send(
            &mut w.ctx,
            &[reject_ix(w.backer_b.pubkey(), commission)],
            &[&w.backer_b]
        )
        .await
        .is_err(),
        "a stranger must not be able to reject an agent's delivery"
    );
    send(
        &mut w.ctx,
        &[reject_ix(w.creator.pubkey(), commission)],
        &[&w.creator],
    )
    .await
    .unwrap();

    let c = commission_state(&mut w.ctx, commission).await;
    assert_eq!(c.rejections, 1, "the refusal is attributable and counted");
    assert!(!c.has_pending_submission(), "rejection stops the clock");
    assert_eq!(c.submissions, 1);
    // Rejection ends the contract and returns the work to the pool, so the
    // creator is free to hire someone else rather than being stuck with an agent
    // whose work they have already refused.
    assert_eq!(
        c.status,
        Status::Funded,
        "rejection re-opens the commission"
    );
    assert!(
        !c.has_agent,
        "the rejected agent no longer holds the contract"
    );
    let delivery_deadline_after_rejection = c.delivery_deadline;

    // A cleared agent cannot keep submitting against work they no longer hold.
    assert!(
        send(
            &mut w.ctx,
            &[submit_ix(w.agent.pubkey(), commission, 0)],
            &[&w.agent]
        )
        .await
        .is_err(),
        "a rejected agent must re-accept before they can submit again"
    );

    // The creator gives the same agent another go. They may, but the delivery
    // clock does not restart, so cycling agents cannot stretch the deadline.
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();
    assert_eq!(
        commission_state(&mut w.ctx, commission)
            .await
            .delivery_deadline,
        delivery_deadline_after_rejection,
        "re-accepting must inherit the remaining time, not reset the clock"
    );

    // The agent revises and resubmits; the creator lets this one lapse.
    send(
        &mut w.ctx,
        &[submit_ix(w.agent.pubkey(), commission, 0)],
        &[&w.agent],
    )
    .await
    .unwrap();
    let submitted_at = commission_state(&mut w.ctx, commission).await.submitted_at;
    warp_past(&mut w.ctx, submitted_at + review).await;

    // Too late to refuse: the claim has already matured.
    assert!(
        send(
            &mut w.ctx,
            &[reject_ix(w.creator.pubkey(), commission)],
            &[&w.creator]
        )
        .await
        .is_err(),
        "a matured claim cannot be retroactively rejected"
    );
    send(
        &mut w.ctx,
        &[release_ix(
            w.backer_b.pubkey(),
            commission,
            vault,
            w.agent.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.backer_b],
    )
    .await
    .unwrap();
    assert_eq!(
        commission_state(&mut w.ctx, commission).await.submissions,
        2
    );
}

/// The delivery clock starts at acceptance, and an agent who never delivers
/// releases the escrow back to backers without anyone having to cancel first.
#[tokio::test]
async fn delivery_clock_starts_at_acceptance_and_expires_to_refund() {
    let mut w = world().await;
    let seed = 14;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            7_200,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();

    let before_accept = commission_state(&mut w.ctx, commission).await;
    assert_eq!(
        before_accept.delivery_deadline, 0,
        "no delivery clock until someone accepts"
    );

    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();

    let c = commission_state(&mut w.ctx, commission).await;
    let now = w
        .ctx
        .banks_client
        .get_sysvar::<Clock>()
        .await
        .unwrap()
        .unix_timestamp;
    assert!(
        c.delivery_deadline >= now,
        "the clock runs forward from acceptance"
    );
    assert!(
        c.delivery_deadline <= now + 7_200,
        "an agent accepting late gets the full window, not the leftovers of the funding phase"
    );

    warp_past(&mut w.ctx, c.delivery_deadline).await;
    // Submitting after the deadline would reopen escrow that is already refundable.
    assert!(
        send(
            &mut w.ctx,
            &[submit_ix(w.agent.pubkey(), commission, 0)],
            &[&w.agent]
        )
        .await
        .is_err(),
        "a late submission must not claw back money backers can already withdraw"
    );
    // No cancel needed: an expired delivery phase refunds on its own terms.
    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .expect("an abandoned build refunds without a third party paying to cancel it");
    assert_eq!(balance(&mut w.ctx, vault).await, 890_880);
}

/// An exclusive claim stops duplicated speculative work, but must not let an
/// unresponsive nominee park a funded commission indefinitely.
#[tokio::test]
async fn a_stale_nomination_lapses_so_anyone_can_clear_it() {
    let mut w = world().await;
    let seed = 15;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, 20 * 86_400).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            86_400,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.backer_b.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();

    let nominated_at = commission_state(&mut w.ctx, commission).await.nominated_at;
    assert!(
        nominated_at > 0,
        "the claim is timestamped so it can expire"
    );

    // While the claim is fresh it is genuinely exclusive.
    assert!(
        send(
            &mut w.ctx,
            &[revoke_ix(w.agent.pubkey(), commission)],
            &[&w.agent]
        )
        .await
        .is_err(),
        "a live exclusive claim must not be strippable by a rival agent"
    );

    warp_past(&mut w.ctx, nominated_at + 3 * 86_400).await;
    send(
        &mut w.ctx,
        &[revoke_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .expect("a lapsed claim can be cleared by anyone so the work can be re-offered");

    let c = commission_state(&mut w.ctx, commission).await;
    assert!(!c.has_pending_agent, "the lapsed claim is gone");
    assert_eq!(c.pending_agent, Pubkey::default());
    assert_eq!(
        c.status,
        Status::Funded,
        "clearing a claim returns it to the pool"
    );
}

/// The clocks are bounded on both sides.
#[tokio::test]
async fn window_bounds_are_enforced_at_creation() {
    let mut w = world().await;
    let dl = soon(&mut w.ctx, A_WEEK).await;
    for (seed, delivery, review, label) in [
        (20u64, 60i64, 3_600i64, "a delivery window under an hour"),
        (21, 31 * 86_400, 3_600, "a delivery window over thirty days"),
        (22, 86_400, 60, "a review window under an hour"),
        (
            23,
            86_400,
            15 * 86_400,
            "a review window over fourteen days",
        ),
    ] {
        let (commission, vault) = addresses(w.creator.pubkey(), seed);
        assert!(
            send(
                &mut w.ctx,
                &[create_with_windows(
                    w.creator.pubkey(),
                    w.config,
                    commission,
                    vault,
                    seed,
                    1_000_000,
                    vec![10_000],
                    dl,
                    delivery,
                    review,
                )],
                &[&w.creator],
            )
            .await
            .is_err(),
            "{label} must be refused"
        );
    }

    // Zero means "use the defaults" rather than "no window at all".
    let (commission, vault) = addresses(w.creator.pubkey(), 24);
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            24,
            1_000_000,
            vec![10_000],
            dl,
            0,
            0,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    let c = commission_state(&mut w.ctx, commission).await;
    assert_eq!(c.delivery_window, 3 * 86_400);
    assert_eq!(c.review_window, 2 * 86_400);
}

/// The funding ceiling came down from 180 days to 30.
#[tokio::test]
async fn funding_deadline_ceiling_is_thirty_days() {
    let mut w = world().await;
    let (commission, vault) = addresses(w.creator.pubkey(), 25);
    let too_far = soon(&mut w.ctx, 31 * 86_400).await;
    assert!(
        send(
            &mut w.ctx,
            &[create_with_windows(
                w.creator.pubkey(),
                w.config,
                commission,
                vault,
                25,
                1_000_000,
                vec![10_000],
                too_far,
                0,
                0,
            )],
            &[&w.creator],
        )
        .await
        .is_err(),
        "a funding phase longer than thirty days must be refused"
    );

    let ok = soon(&mut w.ctx, 29 * 86_400).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            25,
            1_000_000,
            vec![10_000],
            ok,
            0,
            0,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
}

// ── the connection fee ──────────────────────────────────────────────────────
//
// The protocol charges for connecting two parties and carrying real work
// between them, not for guaranteeing an outcome it cannot control. Charging
// only on release meant refusing work was cheaper than approving it, which
// priced refusal as the rational default. These tests pin the corrected model.

/// A commission nobody ever delivered against costs nothing. No connection was
/// made, so there is nothing to charge for.
#[tokio::test]
async fn a_commission_with_no_submission_refunds_without_any_fee() {
    let mut w = world().await;
    let seed = 30;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            7_200,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[cancel_ix(w.creator.pubkey(), commission)],
        &[&w.creator],
    )
    .await
    .unwrap();

    let backer_before = balance(&mut w.ctx, w.backer_a.pubkey()).await;
    let treasury_before = balance(&mut w.ctx, w.treasury.pubkey()).await;
    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();

    assert_eq!(
        balance(&mut w.ctx, w.backer_a.pubkey()).await - backer_before,
        1_000_000 + PLEDGE_RENT,
        "a backer must get every lamport back, plus the rent their pledge account held"
    );
    assert_eq!(
        balance(&mut w.ctx, w.treasury.pubkey()).await - treasury_before,
        0,
        "the protocol must not charge for a connection it never made"
    );
    assert_eq!(balance(&mut w.ctx, vault).await, 890_880);
}

/// Once work has been delivered the protocol has done its job, so the fee is
/// charged whichever way the money leaves — and the creator can no longer save
/// money by refusing rather than approving.
#[tokio::test]
async fn refusing_delivered_work_costs_the_creator_exactly_what_approving_costs() {
    let mut w = world().await;
    let seed = 31;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            7_200,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.agent.pubkey(), commission, 0)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[reject_ix(w.creator.pubkey(), commission)],
        &[&w.creator],
    )
    .await
    .unwrap();

    // Nobody re-accepts and the delivery clock runs out.
    let deadline = commission_state(&mut w.ctx, commission)
        .await
        .delivery_deadline;
    warp_past(&mut w.ctx, deadline).await;

    let backer_before = balance(&mut w.ctx, w.backer_a.pubkey()).await;
    let treasury_before = balance(&mut w.ctx, w.treasury.pubkey()).await;
    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .expect("an expired commission must refund even after being rejected back into the pool");

    let fee = balance(&mut w.ctx, w.treasury.pubkey()).await - treasury_before;
    let returned = balance(&mut w.ctx, w.backer_a.pubkey()).await - backer_before;
    assert_eq!(
        fee, 10_000,
        "1% is charged because work was actually delivered"
    );
    assert_eq!(
        returned,
        990_000 + PLEDGE_RENT,
        "the backer receives the rest, plus their pledge rent"
    );
    assert_eq!(
        fee + returned - PLEDGE_RENT,
        1_000_000,
        "conservation: every escrowed lamport is accounted for, rent aside"
    );
    assert_eq!(
        balance(&mut w.ctx, vault).await,
        890_880,
        "the vault closes exactly"
    );
}

/// Rejection cycles must not multiply the fee. An agent who resubmits ten times
/// would otherwise be able to burn ten percent of backer money for the price of
/// a few transaction fees.
#[tokio::test]
async fn repeated_rejections_cannot_multiply_the_fee() {
    let mut w = world().await;
    let seed = 32;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            86_400,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();

    // Five full submit/reject cycles.
    for _ in 0..5 {
        send(
            &mut w.ctx,
            &[nominate_ix(
                w.creator.pubkey(),
                commission,
                w.agent.pubkey(),
            )],
            &[&w.creator],
        )
        .await
        .unwrap();
        send(
            &mut w.ctx,
            &[accept_ix(w.agent.pubkey(), commission)],
            &[&w.agent],
        )
        .await
        .unwrap();
        send(
            &mut w.ctx,
            &[submit_ix(w.agent.pubkey(), commission, 0)],
            &[&w.agent],
        )
        .await
        .unwrap();
        send(
            &mut w.ctx,
            &[reject_ix(w.creator.pubkey(), commission)],
            &[&w.creator],
        )
        .await
        .unwrap();
    }
    let c = commission_state(&mut w.ctx, commission).await;
    assert_eq!(c.rejections, 5);
    assert_eq!(c.submissions, 5);

    let deadline = c.delivery_deadline;
    warp_past(&mut w.ctx, deadline).await;
    let treasury_before = balance(&mut w.ctx, w.treasury.pubkey()).await;
    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();

    assert_eq!(
        balance(&mut w.ctx, w.treasury.pubkey()).await - treasury_before,
        10_000,
        "five rejections must still cost exactly one percent, not five"
    );
    assert_eq!(balance(&mut w.ctx, vault).await, 890_880);
}

/// Half released and half refunded must still total exactly one percent: the fee
/// follows the lamport out of escrow, and each lamport leaves once.
#[tokio::test]
async fn a_partly_released_commission_is_charged_exactly_one_percent_overall() {
    let mut w = world().await;
    let seed = 33;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![5_000, 5_000],
            dl,
            7_200,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.agent.pubkey(), commission, 0)],
        &[&w.agent],
    )
    .await
    .unwrap();

    let treasury_before = balance(&mut w.ctx, w.treasury.pubkey()).await;
    // Milestone one is accepted and paid.
    send(
        &mut w.ctx,
        &[release_ix(
            w.creator.pubkey(),
            commission,
            vault,
            w.agent.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    // The rest is abandoned and refunds.
    let deadline = commission_state(&mut w.ctx, commission)
        .await
        .delivery_deadline;
    warp_past(&mut w.ctx, deadline).await;
    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();

    assert_eq!(
        balance(&mut w.ctx, w.treasury.pubkey()).await - treasury_before,
        10_000,
        "half paid and half refunded is still one percent of the pot, once"
    );
    let c = commission_state(&mut w.ctx, commission).await;
    assert_eq!(c.released + c.refunded, c.total_pledged, "conservation");
    assert_eq!(balance(&mut w.ctx, vault).await, 890_880);
}

/// A claim that matures after the delivery deadline opens both "anyone may
/// release to the agent" and "backers may refund" at once. Without protection
/// the agent loses a race to a fast backer for work they actually delivered.
#[tokio::test]
async fn a_matured_claim_survives_a_refund_race_but_does_not_lock_escrow() {
    let mut w = world().await;
    let seed = 34;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    // Review window outlasts the delivery window on purpose.
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            3_600,
            7_200,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.agent.pubkey(), commission, 0)],
        &[&w.agent],
    )
    .await
    .unwrap();

    let c = commission_state(&mut w.ctx, commission).await;
    let review_ends = c.submitted_at + c.review_window;
    assert!(
        review_ends > c.delivery_deadline,
        "the race window must actually exist here"
    );

    // Past both the delivery deadline and the review window: the claim has
    // matured and the escrow looks refundable at the same moment.
    warp_past(&mut w.ctx, review_ends).await;
    assert!(
        send(
            &mut w.ctx,
            &[refund_ix(
                w.backer_a.pubkey(),
                commission,
                vault,
                w.treasury.pubkey()
            )],
            &[&w.backer_a]
        )
        .await
        .is_err(),
        "a backer must not be able to outrace an agent to work that was delivered"
    );

    let agent_before = balance(&mut w.ctx, w.agent.pubkey()).await;
    send(
        &mut w.ctx,
        &[release_ix(
            w.backer_b.pubkey(),
            commission,
            vault,
            w.agent.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.backer_b],
    )
    .await
    .expect("the matured claim is still payable by anyone");
    assert_eq!(
        balance(&mut w.ctx, w.agent.pubkey()).await - agent_before,
        990_000
    );
}

/// The grace period must be bounded. An agent who submits and then vanishes
/// cannot be allowed to hold the escrow shut forever.
#[tokio::test]
async fn an_unclaimed_matured_delivery_eventually_releases_the_escrow() {
    let mut w = world().await;
    let seed = 35;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            3_600,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.agent.pubkey(), commission, 0)],
        &[&w.agent],
    )
    .await
    .unwrap();

    let c = commission_state(&mut w.ctx, commission).await;
    // One second short of the grace expiring, the claim still holds.
    let grace_ends = c.submitted_at + c.review_window + 86_400;
    warp_past(&mut w.ctx, grace_ends - 120).await;
    assert!(
        send(
            &mut w.ctx,
            &[refund_ix(
                w.backer_a.pubkey(),
                commission,
                vault,
                w.treasury.pubkey()
            )],
            &[&w.backer_a]
        )
        .await
        .is_err(),
        "the claim is protected for the whole grace period"
    );

    // After it, the escrow must come back rather than staying locked.
    warp_past(&mut w.ctx, grace_ends).await;
    let treasury_before = balance(&mut w.ctx, w.treasury.pubkey()).await;
    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .expect("an abandoned claim must not lock backer money forever");
    assert_eq!(
        balance(&mut w.ctx, w.treasury.pubkey()).await - treasury_before,
        10_000,
        "work was delivered, so the connection fee still applies"
    );
    assert_eq!(balance(&mut w.ctx, vault).await, 890_880);
}

/// A commission rejected back into the pool and never re-accepted must not sit
/// idle: unacceptable because its delivery clock is up, unrefundable because its
/// funding deadline has not arrived.
#[tokio::test]
async fn a_rejected_commission_nobody_re_accepts_does_not_sit_idle() {
    let mut w = world().await;
    let seed = 36;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    // Funding window far longer than the delivery window.
    let dl = soon(&mut w.ctx, 20 * 86_400).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            3_600,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.agent.pubkey(), commission, 0)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[reject_ix(w.creator.pubkey(), commission)],
        &[&w.creator],
    )
    .await
    .unwrap();

    let deadline = commission_state(&mut w.ctx, commission)
        .await
        .delivery_deadline;
    warp_past(&mut w.ctx, deadline).await;

    // Re-accepting is refused: the clock it would inherit has already run out.
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    assert!(
        send(
            &mut w.ctx,
            &[accept_ix(w.agent.pubkey(), commission)],
            &[&w.agent]
        )
        .await
        .is_err(),
        "an agent must not inherit a delivery clock that has already expired"
    );

    // So the money must be refundable, long before the funding deadline.
    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .expect("escrow must not idle until the funding deadline once delivery has lapsed");
    assert_eq!(balance(&mut w.ctx, vault).await, 890_880);
}

/// Refund now moves lamports to a treasury account supplied by the caller. That
/// is a new substitution surface: if it were unchecked, any backer could name
/// themselves and collect the fee, or point it at an account whose balance the
/// program would then corrupt.
#[tokio::test]
async fn the_refund_fee_cannot_be_redirected_to_an_attacker() {
    let mut w = world().await;
    let seed = 37;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            3_600,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.agent.pubkey(), commission, 0)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[reject_ix(w.creator.pubkey(), commission)],
        &[&w.creator],
    )
    .await
    .unwrap();
    let deadline = commission_state(&mut w.ctx, commission)
        .await
        .delivery_deadline;
    warp_past(&mut w.ctx, deadline + 86_400).await;

    // A backer naming themselves as the treasury.
    assert!(
        send(
            &mut w.ctx,
            &[refund_ix(
                w.backer_a.pubkey(),
                commission,
                vault,
                w.backer_a.pubkey()
            )],
            &[&w.backer_a]
        )
        .await
        .is_err(),
        "a backer must not be able to collect the fee by naming themselves treasury"
    );
    // An arbitrary third party.
    let thief = Keypair::new();
    assert!(
        send(
            &mut w.ctx,
            &[refund_ix(
                w.backer_a.pubkey(),
                commission,
                vault,
                thief.pubkey()
            )],
            &[&w.backer_a]
        )
        .await
        .is_err(),
        "the fee must not be redirectable to an arbitrary account"
    );
    // The vault itself, which the program is also mutating in the same handler.
    assert!(
        send(
            &mut w.ctx,
            &[refund_ix(w.backer_a.pubkey(), commission, vault, vault)],
            &[&w.backer_a]
        )
        .await
        .is_err(),
        "aliasing the vault as the treasury must be refused, not merely survive"
    );
    // The commission account, whose data the program writes in the same handler.
    assert!(
        send(
            &mut w.ctx,
            &[refund_ix(
                w.backer_a.pubkey(),
                commission,
                vault,
                commission
            )],
            &[&w.backer_a]
        )
        .await
        .is_err(),
        "aliasing the commission as the treasury must be refused"
    );

    // Only the treasury recorded at creation is accepted, and conservation holds.
    let treasury_before = balance(&mut w.ctx, w.treasury.pubkey()).await;
    let backer_before = balance(&mut w.ctx, w.backer_a.pubkey()).await;
    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    let fee = balance(&mut w.ctx, w.treasury.pubkey()).await - treasury_before;
    let returned = balance(&mut w.ctx, w.backer_a.pubkey()).await - backer_before;
    assert_eq!(fee, 10_000);
    assert_eq!(
        fee + returned - PLEDGE_RENT,
        1_000_000,
        "no escrowed lamport is created or destroyed"
    );
    assert_eq!(balance(&mut w.ctx, vault).await, 890_880);
}

/// F-1, found by adversarial review of the rejection change.
///
/// Returning a rejected commission to the pool accidentally handed the creator
/// back their at-will cancellation right. Reject (which clears the submission)
/// and cancel in the same slot, and the escrow is gone before the agent can be
/// re-hired or resubmit — defeating the delivery clock the rejection was
/// specifically designed to keep running.
#[tokio::test]
async fn rejection_cannot_be_laundered_into_an_instant_creator_cancellation() {
    let mut w = world().await;
    let seed = 38;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            86_400,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();

    // Before anyone commits, the creator may still back out freely.
    // (Verified on a separate commission so this one can continue.)
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.agent.pubkey(), commission, 0)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[reject_ix(w.creator.pubkey(), commission)],
        &[&w.creator],
    )
    .await
    .unwrap();
    assert_eq!(
        commission_state(&mut w.ctx, commission).await.status,
        Status::Funded
    );

    // THE ATTACK: cancel immediately after rejecting, in the same phase.
    assert!(
        send(&mut w.ctx, &[cancel_ix(w.creator.pubkey(), commission)], &[&w.creator]).await.is_err(),
        "a creator must not be able to reject and then instantly cancel; the delivery clock keeps running"
    );
    assert!(
        send(
            &mut w.ctx,
            &[refund_ix(
                w.backer_a.pubkey(),
                commission,
                vault,
                w.treasury.pubkey()
            )],
            &[&w.backer_a]
        )
        .await
        .is_err(),
        "nor reach the escrow through a refund while that clock is still live"
    );

    // The agent can therefore still be re-hired and deliver, which is the whole
    // point of the clock surviving a rejection.
    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.agent.pubkey(), commission, 0)],
        &[&w.agent],
    )
    .await
    .unwrap();
    let agent_before = balance(&mut w.ctx, w.agent.pubkey()).await;
    send(
        &mut w.ctx,
        &[release_ix(
            w.creator.pubkey(),
            commission,
            vault,
            w.agent.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    assert_eq!(
        balance(&mut w.ctx, w.agent.pubkey()).await - agent_before,
        990_000
    );

    // And the escrow is still bounded: once the clock runs out it comes back.
    let (c2, v2) = addresses(w.creator.pubkey(), 39);
    let dl2 = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            c2,
            v2,
            39,
            1_000_000,
            vec![10_000],
            dl2,
            3_600,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(w.backer_a.pubkey(), w.config, c2, v2, 1_000_000)],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    // A commission nobody ever accepted is still cancellable at will.
    send(
        &mut w.ctx,
        &[cancel_ix(w.creator.pubkey(), c2)],
        &[&w.creator],
    )
    .await
    .expect("the pre-agent creator cancel right must be preserved");
}

/// CRITICAL, found by adversarial review.
///
/// `entitled` is a share of `total_pledged - released`, a base that shrinks on a
/// release but not on other refunds. A release landing BETWEEN two refunds could
/// therefore leave a later backer entitled to more than the vault still held,
/// and the handler rejected outright instead of clamping. That froze
/// `refunded_pledger_count`, so `is_last` never became true, the dust sweep never
/// fired, and the remainder was stranded permanently with the remaining backers
/// locked out of their own money.
///
/// The interleave is reachable with no malice at all: once a matured claim has
/// outlived its grace period, "anyone may release it" and "backers may refund"
/// are BOTH live, so ordinary transaction ordering is enough.
#[tokio::test]
async fn a_release_between_refunds_cannot_strand_the_remaining_backers() {
    let mut w = world().await;
    let seed = 40;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    // Three backers and a two-milestone schedule: the shape the single-backer
    // fee tests could never have exposed.
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![5_000, 5_000],
            dl,
            3_600,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();

    let backer_c = Keypair::new();
    send(
        &mut w.ctx,
        &[system_instruction::transfer(
            &w.treasury.pubkey(),
            &backer_c.pubkey(),
            50_000_000,
        )],
        &[&w.treasury],
    )
    .await
    .unwrap();

    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            400_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_b.pubkey(),
            w.config,
            commission,
            vault,
            300_000,
        )],
        &[&w.backer_b],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            backer_c.pubkey(),
            w.config,
            commission,
            vault,
            300_000,
        )],
        &[&backer_c],
    )
    .await
    .unwrap();

    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.agent.pubkey(), commission, 0)],
        &[&w.agent],
    )
    .await
    .unwrap();

    // Walk past the delivery deadline AND past the claim grace, so refunds and
    // the matured release are simultaneously live. This is the by-design
    // overlap, not an exotic edge.
    let c0 = commission_state(&mut w.ctx, commission).await;
    warp_past(&mut w.ctx, c0.submitted_at + c0.review_window + 86_400).await;

    // 1. One backer exits first.
    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();

    // 2. A stranger completes the agent's matured claim, shrinking the base the
    //    remaining backers were entitled against.
    send(
        &mut w.ctx,
        &[release_ix(
            w.backer_b.pubkey(),
            commission,
            vault,
            w.agent.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.backer_b],
    )
    .await
    .expect("a matured claim stays payable by anyone");

    // 3. THE BUG: every remaining backer must still be able to settle.
    for (kp, label) in [(&w.backer_b, "backer_b"), (&backer_c, "backer_c")] {
        send(
            &mut w.ctx,
            &[refund_ix(
                kp.pubkey(),
                commission,
                vault,
                w.treasury.pubkey(),
            )],
            &[kp],
        )
        .await
        .unwrap_or_else(|e| panic!("{label} was locked out of their own money: {e:?}"));
    }

    let c = commission_state(&mut w.ctx, commission).await;
    assert_eq!(
        c.refunded_pledger_count, c.pledger_count,
        "every backer settled"
    );
    assert_eq!(c.released + c.refunded, c.total_pledged, "conservation");
    assert_eq!(
        balance(&mut w.ctx, vault).await,
        890_880,
        "not one lamport may be stranded"
    );
}

fn close_pledge_ix(backer: Pubkey, commission: Pubkey) -> Instruction {
    ix(
        vec![
            AccountMeta::new(backer, true),
            AccountMeta::new(commission, false),
            AccountMeta::new(pledge_pda(commission, backer), false),
        ],
        EscrowInstruction::ClosePledge,
    )
}

fn close_vault_ix(
    signer: Pubkey,
    commission: Pubkey,
    vault: Pubkey,
    creator: Pubkey,
) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(signer, true),
            AccountMeta::new(commission, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(creator, false),
        ],
        EscrowInstruction::CloseVault,
    )
}

// ── rent reclamation ────────────────────────────────────────────────
//
// Every account this program opens is rent-exempt, which means SOL is locked up
// for as long as it exists. On a 0.05 SOL bounty that overhead was a real
// percentage of the whole commission, so accounts that can never be used again
// hand their rent back to whoever paid for it.

/// A refund returns the escrow AND the rent the pledge account was holding.
#[tokio::test]
async fn a_refund_returns_the_pledge_rent_and_closes_the_account() {
    let mut w = world().await;
    let seed = 50;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            3_600,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();

    let pledge = pledge_pda(commission, w.backer_a.pubkey());
    assert_eq!(
        balance(&mut w.ctx, pledge).await,
        PLEDGE_RENT,
        "a pledge account holds exactly its rent-exemption minimum"
    );

    send(
        &mut w.ctx,
        &[cancel_ix(w.creator.pubkey(), commission)],
        &[&w.creator],
    )
    .await
    .unwrap();
    let before = balance(&mut w.ctx, w.backer_a.pubkey()).await;
    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();

    assert_eq!(
        balance(&mut w.ctx, w.backer_a.pubkey()).await - before,
        1_000_000 + PLEDGE_RENT,
        "the backer gets their escrow back and their rent with it"
    );
    assert_eq!(
        balance(&mut w.ctx, pledge).await,
        0,
        "the pledge account is gone"
    );

    // And the closed account cannot be replayed for a second refund.
    assert!(
        send(
            &mut w.ctx,
            &[refund_ix(
                w.backer_a.pubkey(),
                commission,
                vault,
                w.treasury.pubkey()
            )],
            &[&w.backer_a]
        )
        .await
        .is_err(),
        "a closed pledge must not be refundable again"
    );
}

/// The safety argument for closing on refund: a commission that can be refunded
/// can never be pledged to again, so the account cannot be resurrected.
#[tokio::test]
async fn a_closed_pledge_cannot_be_resurrected_by_a_new_pledge() {
    let mut w = world().await;
    let seed = 51;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            3_600,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[cancel_ix(w.creator.pubkey(), commission)],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();

    // Cancelled is not Funding, so the pledge path is closed for good.
    assert!(
        send(
            &mut w.ctx,
            &[pledge_ix(
                w.backer_a.pubkey(),
                w.config,
                commission,
                vault,
                1_000_000
            )],
            &[&w.backer_a]
        )
        .await
        .is_err(),
        "a cancelled commission must never accept a fresh pledge"
    );

    let c = commission_state(&mut w.ctx, commission).await;
    assert_eq!(
        c.refunded_pledger_count, c.pledger_count,
        "the settlement is still recorded on the commission"
    );
}

/// The shipped path: every lamport went to the agent, so no refund will ever be
/// called and the pledge account needs its own way home.
#[tokio::test]
async fn a_shipped_commission_lets_backers_reclaim_their_pledge_rent() {
    let mut w = world().await;
    let seed = 52;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            86_400,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();

    // While the commission is live the pledge is load-bearing and must stay.
    assert!(
        send(
            &mut w.ctx,
            &[close_pledge_ix(w.backer_a.pubkey(), commission)],
            &[&w.backer_a]
        )
        .await
        .is_err(),
        "a pledge on a live commission must not be closable"
    );

    send(
        &mut w.ctx,
        &[nominate_ix(
            w.creator.pubkey(),
            commission,
            w.agent.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[accept_ix(w.agent.pubkey(), commission)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.agent.pubkey(), commission, 0)],
        &[&w.agent],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[release_ix(
            w.creator.pubkey(),
            commission,
            vault,
            w.agent.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    assert_eq!(
        commission_state(&mut w.ctx, commission).await.status,
        Status::Delivered
    );

    // Somebody else must not be able to take it.
    assert!(
        send(
            &mut w.ctx,
            &[close_pledge_ix(w.backer_b.pubkey(), commission)],
            &[&w.backer_b]
        )
        .await
        .is_err(),
        "only the backer who paid the rent may reclaim it"
    );

    let before = balance(&mut w.ctx, w.backer_a.pubkey()).await;
    send(
        &mut w.ctx,
        &[close_pledge_ix(w.backer_a.pubkey(), commission)],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    assert_eq!(
        balance(&mut w.ctx, w.backer_a.pubkey()).await - before,
        PLEDGE_RENT,
        "a backer on a shipped commission recovers exactly their pledge rent"
    );
    assert_eq!(
        balance(&mut w.ctx, pledge_pda(commission, w.backer_a.pubkey())).await,
        0
    );

    // The vault is empty too, so its reserve goes back to the creator who paid it.
    let creator_before = balance(&mut w.ctx, w.creator.pubkey()).await;
    send(
        &mut w.ctx,
        &[close_vault_ix(
            w.backer_b.pubkey(),
            commission,
            vault,
            w.creator.pubkey(),
        )],
        &[&w.backer_b],
    )
    .await
    .expect("anyone may run the cleanup; the rent still goes to the creator");
    assert_eq!(
        balance(&mut w.ctx, w.creator.pubkey()).await - creator_before,
        VAULT_RENT,
        "the creator recovers exactly the vault rent, no matter who triggered it"
    );
    assert_eq!(
        balance(&mut w.ctx, vault).await,
        0,
        "the vault account is gone"
    );
}

/// The vault must not be closable while anything could still need it.
#[tokio::test]
async fn a_vault_holding_escrow_cannot_be_closed() {
    let mut w = world().await;
    let seed = 53;
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let dl = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_with_windows(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            1_000_000,
            vec![10_000],
            dl,
            3_600,
            3_600,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[pledge_ix(
            w.backer_a.pubkey(),
            w.config,
            commission,
            vault,
            1_000_000,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();

    // Funding, with money in it.
    assert!(
        send(
            &mut w.ctx,
            &[close_vault_ix(
                w.creator.pubkey(),
                commission,
                vault,
                w.creator.pubkey()
            )],
            &[&w.creator]
        )
        .await
        .is_err(),
        "a vault holding escrow must never be closable"
    );

    send(
        &mut w.ctx,
        &[cancel_ix(w.creator.pubkey(), commission)],
        &[&w.creator],
    )
    .await
    .unwrap();
    // Cancelled, but a backer has not taken their money yet.
    assert!(
        send(
            &mut w.ctx,
            &[close_vault_ix(
                w.creator.pubkey(),
                commission,
                vault,
                w.creator.pubkey()
            )],
            &[&w.creator]
        )
        .await
        .is_err(),
        "a backer who has not refunded yet must not be locked out by an early close"
    );

    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            commission,
            vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();

    // Rent must go to the creator, and nobody else may redirect it.
    assert!(
        send(
            &mut w.ctx,
            &[close_vault_ix(
                w.backer_b.pubkey(),
                commission,
                vault,
                w.backer_b.pubkey()
            )],
            &[&w.backer_b]
        )
        .await
        .is_err(),
        "the vault rent must not be redirectable away from the creator"
    );

    let creator_before = balance(&mut w.ctx, w.creator.pubkey()).await;
    send(
        &mut w.ctx,
        &[close_vault_ix(
            w.creator.pubkey(),
            commission,
            vault,
            w.creator.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    assert_eq!(
        balance(&mut w.ctx, w.creator.pubkey()).await - creator_before,
        VAULT_RENT,
        "once every backer has settled, the reserve comes home"
    );

    // And it cannot be drained twice.
    assert!(
        send(
            &mut w.ctx,
            &[close_vault_ix(
                w.creator.pubkey(),
                commission,
                vault,
                w.creator.pubkey()
            )],
            &[&w.creator]
        )
        .await
        .is_err(),
        "a closed vault must not be closable again"
    );
}

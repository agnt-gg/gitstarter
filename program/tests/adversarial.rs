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
const FAR_FUTURE: i64 = 4_102_444_800; // 2100-01-01

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

    let mut pt = ProgramTest::new("gitstarter_escrow", PROGRAM_ID, processor!(process_instruction));
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

fn refund_ix(backer: Pubkey, commission: Pubkey, vault: Pubkey) -> Instruction {
    ix(
        vec![
            AccountMeta::new(backer, true),
            AccountMeta::new(commission, false),
            AccountMeta::new(pledge_pda(commission, backer), false),
            AccountMeta::new(vault, false),
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
            FAR_FUTURE,
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
            &[nominate_ix(w.creator.pubkey(), commission, w.creator.pubkey())],
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
        &[refund_ix(w.backer_a.pubkey(), commission, vault)],
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
            FAR_FUTURE,
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
        &[nominate_ix(w.creator.pubkey(), commission, w.agent.pubkey())],
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
    assert!(
        send(
            &mut w.ctx,
            &[cancel_ix(w.backer_b.pubkey(), commission)],
            &[&w.backer_b]
        )
        .await
        .is_err()
    );

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
        &[refund_ix(w.backer_a.pubkey(), commission, vault)],
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
            FAR_FUTURE,
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
            FAR_FUTURE,
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
        &[nominate_ix(w.creator.pubkey(), commission, w.agent.pubkey())],
        &[&w.creator],
    )
    .await
    .unwrap();
    // Only the nominated wallet may accept.
    assert!(
        send(
            &mut w.ctx,
            &[accept_ix(w.backer_b.pubkey(), commission)],
            &[&w.backer_b]
        )
        .await
        .is_err()
    );
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
    assert!(
        send(
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
        .is_err()
    );

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
            FAR_FUTURE,
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
    assert!(
        send(
            &mut w.ctx,
            &[refund_ix(w.backer_b.pubkey(), commission, vault)],
            &[&w.backer_b]
        )
        .await
        .is_err()
    );

    send(
        &mut w.ctx,
        &[refund_ix(w.backer_a.pubkey(), commission, vault)],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    assert!(
        send(
            &mut w.ctx,
            &[refund_ix(w.backer_a.pubkey(), commission, vault)],
            &[&w.backer_a]
        )
        .await
        .is_err(),
        "a refund must not be replayable"
    );
    assert_eq!(balance(&mut w.ctx, vault).await, 890_880);
}

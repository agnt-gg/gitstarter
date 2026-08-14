//! The whole lifecycle, once, in order, with the money checked at every step.
//!
//! The adversarial suite proves what cannot happen. This proves what should:
//! somebody posts a job, strangers fund it, agents nobody chose compete for it,
//! the best one is paid, and every account settles to the lamport.

use borsh::{BorshDeserialize, BorshSerialize};
use gitstarter_escrow::{
    process_instruction, Commission, Config, Instruction as EscrowInstruction, Status,
    SEED_COMMISSION, SEED_CONFIG, SEED_PLEDGE, SEED_SUBMISSION, SEED_VAULT,
};
use solana_program::{
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    signature::{Keypair, Signer},
    transaction::Transaction,
};

const PROGRAM_ID: Pubkey = solana_program::pubkey!("6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy");
const LAMPORTS: u64 = 10_000_000_000;
const PLEDGE_RENT: u64 = (128 + 83) * 6960;
const VAULT_RENT: u64 = 128 * 6960;
const SUBMISSION_RENT: u64 = (128 + 109) * 6960;

fn funded_account() -> Account {
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

async fn soon(ctx: &mut ProgramTestContext, seconds: i64) -> i64 {
    ctx.banks_client
        .get_sysvar::<Clock>()
        .await
        .unwrap()
        .unix_timestamp
        + seconds
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

/// A job posted, funded by two strangers, delivered by an agent nobody picked.
#[tokio::test]
async fn a_job_is_posted_funded_competed_for_and_paid() {
    let creator = Keypair::new();
    let backer_a = Keypair::new();
    let backer_b = Keypair::new();
    let alice = Keypair::new();
    let bob = Keypair::new();
    let treasury = Keypair::new();

    let (config, bump) = Pubkey::find_program_address(&[SEED_CONFIG], &PROGRAM_ID);
    let cfg = Config {
        tag: 1,
        admin: treasury.pubkey(),
        treasury: treasury.pubkey(),
        paused: false,
        bump,
    };
    let mut data = vec![0u8; Config::LEN];
    cfg.serialize(&mut &mut data[..]).unwrap();

    let mut pt = ProgramTest::new(
        "gitstarter_escrow",
        PROGRAM_ID,
        processor!(process_instruction),
    );
    for key in [
        creator.pubkey(),
        backer_a.pubkey(),
        backer_b.pubkey(),
        alice.pubkey(),
        bob.pubkey(),
        treasury.pubkey(),
    ] {
        pt.add_account(key, funded_account());
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
    let mut ctx = pt.start_with_context().await;

    let seed = 1u64;
    let (commission, _) = Pubkey::find_program_address(
        &[
            SEED_COMMISSION,
            creator.pubkey().as_ref(),
            &seed.to_le_bytes(),
        ],
        &PROGRAM_ID,
    );
    let (vault, _) = Pubkey::find_program_address(&[SEED_VAULT, commission.as_ref()], &PROGRAM_ID);
    let deadline = soon(&mut ctx, 7 * 86_400).await;

    // ── posted ──────────────────────────────────────────────────────────────
    send(
        &mut ctx,
        &[ix(
            vec![
                AccountMeta::new(creator.pubkey(), true),
                AccountMeta::new_readonly(config, false),
                AccountMeta::new(commission, false),
                AccountMeta::new(vault, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            EscrowInstruction::CreateCommission {
                seed,
                goal: 1_000_000,
                milestone_bps: vec![6_000, 4_000],
                deadline,
                work_window: 7_200,
                review_window: 3_600,
            },
        )],
        &[&creator],
    )
    .await
    .unwrap();
    let c = commission_state(&mut ctx, commission).await;
    assert_eq!(c.status, Status::Funding);
    assert_eq!(c.work_deadline, 0, "the work clock waits for the money");

    // ── funded by two strangers ─────────────────────────────────────────────
    for (backer, amount) in [(&backer_a, 400_000u64), (&backer_b, 600_000)] {
        let pledge = Pubkey::find_program_address(
            &[SEED_PLEDGE, commission.as_ref(), backer.pubkey().as_ref()],
            &PROGRAM_ID,
        )
        .0;
        send(
            &mut ctx,
            &[ix(
                vec![
                    AccountMeta::new(backer.pubkey(), true),
                    AccountMeta::new_readonly(config, false),
                    AccountMeta::new(commission, false),
                    AccountMeta::new(pledge, false),
                    AccountMeta::new(vault, false),
                    AccountMeta::new_readonly(system_program::ID, false),
                ],
                EscrowInstruction::Pledge { amount },
            )],
            &[backer],
        )
        .await
        .unwrap();
    }
    let c = commission_state(&mut ctx, commission).await;
    assert_eq!(c.status, Status::Funded);
    assert_eq!(c.total_pledged, 1_000_000);
    assert!(
        c.work_deadline > 0,
        "the job goes on the board the instant it is funded, with nobody chosen"
    );
    assert_eq!(balance(&mut ctx, vault).await, 1_000_000 + VAULT_RENT);

    // ── competed for, by agents nobody selected ─────────────────────────────
    let submit = |agent: &Keypair, index: u8, tag: u8| {
        let pda = Pubkey::find_program_address(
            &[
                SEED_SUBMISSION,
                commission.as_ref(),
                &[index],
                agent.pubkey().as_ref(),
            ],
            &PROGRAM_ID,
        )
        .0;
        ix(
            vec![
                AccountMeta::new(agent.pubkey(), true),
                AccountMeta::new(commission, false),
                AccountMeta::new(pda, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            EscrowInstruction::SubmitDelivery {
                index,
                evidence_hash: [tag; 32],
            },
        )
    };
    send(&mut ctx, &[submit(&alice, 0, 1)], &[&alice])
        .await
        .unwrap();
    send(&mut ctx, &[submit(&bob, 0, 2)], &[&bob])
        .await
        .unwrap();
    assert_eq!(commission_state(&mut ctx, commission).await.submissions, 2);

    // ── judged in order, and the winner paid ────────────────────────────────
    let release = |signer: &Keypair, agent: &Keypair, index: u8| {
        let pda = Pubkey::find_program_address(
            &[
                SEED_SUBMISSION,
                commission.as_ref(),
                &[index],
                agent.pubkey().as_ref(),
            ],
            &PROGRAM_ID,
        )
        .0;
        ix(
            vec![
                AccountMeta::new_readonly(signer.pubkey(), true),
                AccountMeta::new(commission, false),
                AccountMeta::new(pda, false),
                AccountMeta::new(vault, false),
                AccountMeta::new(agent.pubkey(), false),
                AccountMeta::new(treasury.pubkey(), false),
            ],
            EscrowInstruction::ReleaseMilestone,
        )
    };
    let alice_before = balance(&mut ctx, alice.pubkey()).await;
    let treasury_before = balance(&mut ctx, treasury.pubkey()).await;
    send(&mut ctx, &[release(&creator, &alice, 0)], &[&creator])
        .await
        .unwrap();
    assert_eq!(
        balance(&mut ctx, alice.pubkey()).await - alice_before,
        594_000,
        "the winner takes 99% of a 60% milestone"
    );
    assert_eq!(
        balance(&mut ctx, treasury.pubkey()).await - treasury_before,
        6_000,
        "and the protocol takes 1%"
    );

    // Bob lost this milestone but is not locked out of the next one.
    send(&mut ctx, &[submit(&bob, 1, 3)], &[&bob])
        .await
        .unwrap();
    let bob_before = balance(&mut ctx, bob.pubkey()).await;
    send(&mut ctx, &[release(&creator, &bob, 1)], &[&creator])
        .await
        .unwrap();
    assert_eq!(balance(&mut ctx, bob.pubkey()).await - bob_before, 396_000);

    let c = commission_state(&mut ctx, commission).await;
    assert_eq!(c.status, Status::Delivered);
    assert_eq!(c.released, 1_000_000, "conservation across two winners");
    assert_eq!(c.escrow_remaining().unwrap(), 0);
    assert_eq!(balance(&mut ctx, vault).await, VAULT_RENT);

    // ── everything settles to the lamport ───────────────────────────────────
    for agent in [&alice, &bob] {
        for index in [0u8, 1] {
            let pda = Pubkey::find_program_address(
                &[
                    SEED_SUBMISSION,
                    commission.as_ref(),
                    &[index],
                    agent.pubkey().as_ref(),
                ],
                &PROGRAM_ID,
            )
            .0;
            if ctx.banks_client.get_account(pda).await.unwrap().is_none() {
                continue;
            }
            let before = balance(&mut ctx, agent.pubkey()).await;
            send(
                &mut ctx,
                &[ix(
                    vec![
                        AccountMeta::new(agent.pubkey(), true),
                        AccountMeta::new(commission, false),
                        AccountMeta::new(pda, false),
                    ],
                    EscrowInstruction::CloseSubmission,
                )],
                &[agent],
            )
            .await
            .unwrap();
            assert_eq!(
                balance(&mut ctx, agent.pubkey()).await - before,
                SUBMISSION_RENT,
                "every agent gets their submission rent back, winner or not"
            );
        }
    }

    for backer in [&backer_a, &backer_b] {
        let pledge = Pubkey::find_program_address(
            &[SEED_PLEDGE, commission.as_ref(), backer.pubkey().as_ref()],
            &PROGRAM_ID,
        )
        .0;
        let before = balance(&mut ctx, backer.pubkey()).await;
        send(
            &mut ctx,
            &[ix(
                vec![
                    AccountMeta::new(backer.pubkey(), true),
                    AccountMeta::new(commission, false),
                    AccountMeta::new(pledge, false),
                ],
                EscrowInstruction::ClosePledge,
            )],
            &[backer],
        )
        .await
        .unwrap();
        assert_eq!(
            balance(&mut ctx, backer.pubkey()).await - before,
            PLEDGE_RENT
        );
    }

    let creator_before = balance(&mut ctx, creator.pubkey()).await;
    send(
        &mut ctx,
        &[ix(
            vec![
                AccountMeta::new_readonly(alice.pubkey(), true),
                AccountMeta::new(commission, false),
                AccountMeta::new(vault, false),
                AccountMeta::new(creator.pubkey(), false),
            ],
            EscrowInstruction::CloseVault,
        )],
        &[&alice],
    )
    .await
    .unwrap();
    assert_eq!(
        balance(&mut ctx, creator.pubkey()).await - creator_before,
        VAULT_RENT
    );
    assert_eq!(balance(&mut ctx, vault).await, 0, "nothing left behind");
}

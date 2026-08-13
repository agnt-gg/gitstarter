use borsh::{BorshDeserialize, BorshSerialize};
use gitstarter_escrow::{
    process_instruction, Commission, Config, Instruction as EscrowInstruction, Status,
    SEED_COMMISSION, SEED_CONFIG, SEED_PLEDGE, SEED_VAULT,
};
use solana_program::{
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
/// Deadlines are bounded, so tests take one relative to the validator clock
/// rather than a fixed timestamp that drifts out of range.
async fn soon(ctx: &mut ProgramTestContext, seconds: i64) -> i64 {
    ctx.banks_client
        .get_sysvar::<solana_program::clock::Clock>()
        .await
        .unwrap()
        .unix_timestamp
        + seconds
}
async fn balance(ctx: &mut ProgramTestContext, key: Pubkey) -> u64 {
    ctx.banks_client.get_balance(key).await.unwrap()
}
async fn commission(ctx: &mut ProgramTestContext, key: Pubkey) -> Commission {
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
async fn setup() -> (
    ProgramTestContext,
    Keypair,
    Keypair,
    Keypair,
    Keypair,
    Keypair,
    Pubkey,
) {
    let creator = Keypair::new();
    let b1 = Keypair::new();
    let b2 = Keypair::new();
    let agent = Keypair::new();
    let treasury = Keypair::new();
    let (config, bump) = Pubkey::find_program_address(&[SEED_CONFIG], &PROGRAM_ID);
    let config_state = Config {
        tag: 1,
        admin: treasury.pubkey(),
        treasury: treasury.pubkey(),
        paused: false,
        bump,
    };
    let mut config_data = vec![0u8; Config::LEN];
    config_state.serialize(&mut &mut config_data[..]).unwrap();
    let mut pt = ProgramTest::new(
        "gitstarter_escrow",
        PROGRAM_ID,
        processor!(process_instruction),
    );
    for key in [
        creator.pubkey(),
        b1.pubkey(),
        b2.pubkey(),
        agent.pubkey(),
        treasury.pubkey(),
    ] {
        pt.add_account(key, funded_account());
    }
    pt.add_account(
        config,
        Account {
            lamports: LAMPORTS,
            data: config_data,
            owner: PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let ctx = pt.start_with_context().await;
    (ctx, creator, b1, b2, agent, treasury, config)
}
fn create(
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
fn pledge(
    backer: Pubkey,
    config: Pubkey,
    commission: Pubkey,
    pledge: Pubkey,
    vault: Pubkey,
    amount: u64,
) -> Instruction {
    ix(
        vec![
            AccountMeta::new(backer, true),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(commission, false),
            AccountMeta::new(pledge, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        EscrowInstruction::Pledge { amount },
    )
}
#[tokio::test]
async fn sol_funding_release_charges_one_percent_only_on_success() {
    let (mut ctx, creator, backer, _b2, agent, treasury, config) = setup().await;
    let deadline = soon(&mut ctx, 7 * 86_400).await;
    let seed = 7u64;
    let (commission_key, _) = Pubkey::find_program_address(
        &[
            SEED_COMMISSION,
            creator.pubkey().as_ref(),
            &seed.to_le_bytes(),
        ],
        &PROGRAM_ID,
    );
    let (vault, _) =
        Pubkey::find_program_address(&[SEED_VAULT, commission_key.as_ref()], &PROGRAM_ID);
    let (pledge_key, _) = Pubkey::find_program_address(
        &[
            SEED_PLEDGE,
            commission_key.as_ref(),
            backer.pubkey().as_ref(),
        ],
        &PROGRAM_ID,
    );
    send(
        &mut ctx,
        &[create(
            creator.pubkey(),
            config,
            commission_key,
            vault,
            seed,
            1_000_000,
            vec![5_000, 5_000],
            deadline,
        )],
        &[&creator],
    )
    .await
    .unwrap();
    let before = balance(&mut ctx, vault).await;
    send(
        &mut ctx,
        &[pledge(
            backer.pubkey(),
            config,
            commission_key,
            pledge_key,
            vault,
            1_000_000,
        )],
        &[&backer],
    )
    .await
    .unwrap();
    assert_eq!(balance(&mut ctx, vault).await - before, 1_000_000);
    assert_eq!(
        commission(&mut ctx, commission_key).await.status,
        Status::Funded
    );
    send(
        &mut ctx,
        &[ix(
            vec![
                AccountMeta::new_readonly(creator.pubkey(), true),
                AccountMeta::new(commission_key, false),
                AccountMeta::new_readonly(agent.pubkey(), false),
            ],
            EscrowInstruction::SelectAgent,
        )],
        &[&creator],
    )
    .await
    .unwrap();
    send(
        &mut ctx,
        &[ix(
            vec![
                AccountMeta::new_readonly(agent.pubkey(), true),
                AccountMeta::new(commission_key, false),
            ],
            EscrowInstruction::AcceptAgent,
        )],
        &[&agent],
    )
    .await
    .unwrap();
    let agent_before = balance(&mut ctx, agent.pubkey()).await;
    let treasury_before = balance(&mut ctx, treasury.pubkey()).await;
    send(
        &mut ctx,
        &[ix(
            vec![
                AccountMeta::new_readonly(creator.pubkey(), true),
                AccountMeta::new(commission_key, false),
                AccountMeta::new(vault, false),
                AccountMeta::new(agent.pubkey(), false),
                AccountMeta::new(treasury.pubkey(), false),
            ],
            EscrowInstruction::ReleaseMilestone { index: 0 },
        )],
        &[&creator],
    )
    .await
    .unwrap();
    assert_eq!(
        balance(&mut ctx, agent.pubkey()).await - agent_before,
        495_000
    );
    assert_eq!(
        balance(&mut ctx, treasury.pubkey()).await - treasury_before,
        5_000
    );
}
#[tokio::test]
async fn sol_refund_returns_full_unreleased_pledge_with_zero_fee() {
    let (mut ctx, creator, backer, _b2, _agent, treasury, config) = setup().await;
    let deadline = soon(&mut ctx, 7 * 86_400).await;
    let seed = 8u64;
    let (commission_key, _) = Pubkey::find_program_address(
        &[
            SEED_COMMISSION,
            creator.pubkey().as_ref(),
            &seed.to_le_bytes(),
        ],
        &PROGRAM_ID,
    );
    let (vault, _) =
        Pubkey::find_program_address(&[SEED_VAULT, commission_key.as_ref()], &PROGRAM_ID);
    let (pledge_key, _) = Pubkey::find_program_address(
        &[
            SEED_PLEDGE,
            commission_key.as_ref(),
            backer.pubkey().as_ref(),
        ],
        &PROGRAM_ID,
    );
    send(
        &mut ctx,
        &[
            create(
                creator.pubkey(),
                config,
                commission_key,
                vault,
                seed,
                2_000_000,
                vec![10_000],
                deadline,
            ),
            pledge(
                backer.pubkey(),
                config,
                commission_key,
                pledge_key,
                vault,
                1_000_000,
            ),
        ],
        &[&creator, &backer],
    )
    .await
    .unwrap();
    send(
        &mut ctx,
        &[ix(
            vec![
                AccountMeta::new_readonly(creator.pubkey(), true),
                AccountMeta::new(commission_key, false),
            ],
            EscrowInstruction::Cancel,
        )],
        &[&creator],
    )
    .await
    .unwrap();
    let backer_before = balance(&mut ctx, backer.pubkey()).await;
    let treasury_before = balance(&mut ctx, treasury.pubkey()).await;
    send(
        &mut ctx,
        &[ix(
            vec![
                AccountMeta::new(backer.pubkey(), true),
                AccountMeta::new(commission_key, false),
                AccountMeta::new(pledge_key, false),
                AccountMeta::new(vault, false),
            ],
            EscrowInstruction::Refund,
        )],
        &[&backer],
    )
    .await
    .unwrap();
    assert_eq!(
        balance(&mut ctx, backer.pubkey()).await - backer_before,
        1_000_000
    );
    assert_eq!(balance(&mut ctx, treasury.pubkey()).await, treasury_before);
    let c = commission(&mut ctx, commission_key).await;
    assert_eq!(c.total_pledged, c.released + c.refunded);
}

use borsh::{BorshDeserialize, BorshSerialize};
use gitstarter_escrow::{
    process_instruction, Commission, Config, Instruction as EscrowInstruction, Pledge,
    Status, INITIALIZER, SEED_COMMISSION, SEED_CONFIG, SEED_PLEDGE, SEED_VAULT,
};
use solana_program::{instruction::{AccountMeta, Instruction}, pubkey::Pubkey, system_instruction, system_program};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use spl_token::{instruction as token_ix, state::{Account as TokenAccount, Mint}, solana_program::program_pack::Pack};
use std::{fs, path::Path};

const PROGRAM_ID: Pubkey = solana_program::pubkey!("6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy");
const LAMPORTS: u64 = 10_000_000_000;

fn initializer_keypair() -> Keypair {
    let path = std::env::var("GITSTARTER_INITIALIZER_KEYPAIR")
        .expect("set GITSTARTER_INITIALIZER_KEYPAIR to the local deployer keypair path");
    let bytes: Vec<u8> = serde_json::from_str(&fs::read_to_string(Path::new(&path)).unwrap()).unwrap();
    let kp = Keypair::from_bytes(&bytes).unwrap();
    assert_eq!(kp.pubkey(), INITIALIZER, "initializer key does not match compiled authority");
    kp
}

fn funded_account() -> Account {
    Account { lamports: LAMPORTS, data: vec![], owner: system_program::ID, executable: false, rent_epoch: 0 }
}

async fn send(ctx: &mut ProgramTestContext, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), solana_program_test::BanksClientError> {
    let blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let mut all = vec![&ctx.payer];
    all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(ixs, Some(&ctx.payer.pubkey()), &all, blockhash);
    ctx.banks_client.process_transaction(tx).await
}

async fn token_amount(ctx: &mut ProgramTestContext, key: Pubkey) -> u64 {
    let a = ctx.banks_client.get_account(key).await.unwrap().unwrap();
    TokenAccount::unpack(&a.data).unwrap().amount
}

async fn commission(ctx: &mut ProgramTestContext, key: Pubkey) -> Commission {
    let a = ctx.banks_client.get_account(key).await.unwrap().unwrap();
    Commission::try_from_slice(&a.data).unwrap()
}

async fn pledge_state(ctx: &mut ProgramTestContext, key: Pubkey) -> Pledge {
    let a = ctx.banks_client.get_account(key).await.unwrap().unwrap();
    Pledge::try_from_slice(&a.data).unwrap()
}

async fn create_mint(ctx: &mut ProgramTestContext, authority: Pubkey) -> Keypair {
    let mint = Keypair::new();
    let rent = ctx.banks_client.get_rent().await.unwrap().minimum_balance(Mint::LEN);
    send(ctx, &[
        system_instruction::create_account(&ctx.payer.pubkey(), &mint.pubkey(), rent, Mint::LEN as u64, &spl_token::ID),
        token_ix::initialize_mint2(&spl_token::ID, &mint.pubkey(), &authority, None, 0).unwrap(),
    ], &[&mint]).await.unwrap();
    mint
}

async fn create_token_account(ctx: &mut ProgramTestContext, mint: Pubkey, owner: Pubkey) -> Keypair {
    let account = Keypair::new();
    let rent = ctx.banks_client.get_rent().await.unwrap().minimum_balance(TokenAccount::LEN);
    send(ctx, &[
        system_instruction::create_account(&ctx.payer.pubkey(), &account.pubkey(), rent, TokenAccount::LEN as u64, &spl_token::ID),
        token_ix::initialize_account3(&spl_token::ID, &account.pubkey(), &mint, &owner).unwrap(),
    ], &[&account]).await.unwrap();
    account
}

async fn mint_to(ctx: &mut ProgramTestContext, mint: Pubkey, dest: Pubkey, authority: &Keypair, amount: u64) {
    send(ctx, &[token_ix::mint_to_checked(&spl_token::ID, &mint, &dest, &authority.pubkey(), &[], amount, 0).unwrap()], &[authority]).await.unwrap();
}

fn init_config_ix(initializer: Pubkey, config: Pubkey, treasury: Pubkey) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(initializer, true),
            AccountMeta::new(config, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data: EscrowInstruction::InitConfig { treasury }.try_to_vec().unwrap(),
    }
}

fn create_commission_ix(creator: Pubkey, config: Pubkey, commission: Pubkey, vault: Pubkey, mint: Pubkey, seed: u64, goal: u64, bps: Vec<u16>) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(creator, true),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(commission, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(spl_token::ID, false),
        ],
        data: EscrowInstruction::CreateCommission { seed, goal, milestone_bps: bps, deadline: i64::MAX / 2 }.try_to_vec().unwrap(),
    }
}

#[allow(clippy::too_many_arguments)]
fn pledge_ix(backer: Pubkey, config: Pubkey, commission: Pubkey, pledge: Pubkey, vault: Pubkey, source: Pubkey, treasury_token: Pubkey, mint: Pubkey, amount: u64) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(backer, true),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(commission, false),
            AccountMeta::new(pledge, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(source, false),
            AccountMeta::new(treasury_token, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(spl_token::ID, false),
        ],
        data: EscrowInstruction::Pledge { amount }.try_to_vec().unwrap(),
    }
}

fn select_agent_ix(creator: Pubkey, commission: Pubkey, agent: Pubkey) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![AccountMeta::new_readonly(creator, true), AccountMeta::new(commission, false), AccountMeta::new_readonly(agent, false)],
        data: EscrowInstruction::SelectAgent.try_to_vec().unwrap(),
    }
}

fn accept_agent_ix(agent: Pubkey, commission: Pubkey) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![AccountMeta::new_readonly(agent, true), AccountMeta::new(commission, false)],
        data: EscrowInstruction::AcceptAgent.try_to_vec().unwrap(),
    }
}

fn release_ix(creator: Pubkey, commission: Pubkey, vault: Pubkey, agent_token: Pubkey, treasury_token: Pubkey, mint: Pubkey, index: u8) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(creator, true), AccountMeta::new(commission, false), AccountMeta::new(vault, false),
            AccountMeta::new(agent_token, false), AccountMeta::new(treasury_token, false), AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(spl_token::ID, false),
        ],
        data: EscrowInstruction::ReleaseMilestone { index }.try_to_vec().unwrap(),
    }
}

fn cancel_ix(signer: Pubkey, commission: Pubkey) -> Instruction {
    Instruction { program_id: PROGRAM_ID, accounts: vec![AccountMeta::new_readonly(signer, true), AccountMeta::new(commission, false)], data: EscrowInstruction::Cancel.try_to_vec().unwrap() }
}

fn refund_ix(backer: Pubkey, commission: Pubkey, pledge: Pubkey, vault: Pubkey, dest: Pubkey, treasury_token: Pubkey, mint: Pubkey) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(backer, true), AccountMeta::new(commission, false), AccountMeta::new(pledge, false),
            AccountMeta::new(vault, false), AccountMeta::new(dest, false), AccountMeta::new(treasury_token, false),
            AccountMeta::new_readonly(mint, false), AccountMeta::new_readonly(spl_token::ID, false),
        ],
        data: EscrowInstruction::Refund.try_to_vec().unwrap(),
    }
}

async fn setup() -> (ProgramTestContext, Keypair, Keypair, Keypair, Keypair, Keypair, Pubkey, Keypair, Keypair) {
    let initializer = initializer_keypair();
    let creator = Keypair::new();
    let backer1 = Keypair::new();
    let backer2 = Keypair::new();
    let agent = Keypair::new();
    let treasury = Keypair::new();

    let mut pt = ProgramTest::new("gitstarter_escrow", PROGRAM_ID, processor!(process_instruction));
    for key in [initializer.pubkey(), creator.pubkey(), backer1.pubkey(), backer2.pubkey(), agent.pubkey(), treasury.pubkey()] {
        pt.add_account(key, funded_account());
    }
    let mut ctx = pt.start_with_context().await;
    let mint_authority = Keypair::new();
    let mint = create_mint(&mut ctx, mint_authority.pubkey()).await;
    let treasury_token = create_token_account(&mut ctx, mint.pubkey(), treasury.pubkey()).await;
    let (config, _) = Pubkey::find_program_address(&[SEED_CONFIG], &PROGRAM_ID);
    send(&mut ctx, &[init_config_ix(initializer.pubkey(), config, treasury.pubkey())], &[&initializer]).await.unwrap();

    let cfg = ctx.banks_client.get_account(config).await.unwrap().unwrap();
    let cfg = Config::try_from_slice(&cfg.data).unwrap();
    assert_eq!(cfg.treasury, treasury.pubkey());
    (ctx, initializer, creator, backer1, backer2, agent, config, mint, treasury_token)
}

#[tokio::test]
async fn full_funded_build_path_charges_exact_fee_and_closes_vault() {
    let (mut ctx, _init, creator, backer, _b2, agent, config, mint, treasury_token) = setup().await;
    let mint_authority = Keypair::new();
    // Replace mint authority is impossible; setup intentionally returns no authority.
    // Create a second test mint we fully control for the value path.
    let test_mint = create_mint(&mut ctx, mint_authority.pubkey()).await;
    let treasury_owner = ctx.banks_client.get_account(treasury_token.pubkey()).await.unwrap().unwrap();
    drop(treasury_owner);
    let treasury = Keypair::new();
    // The config treasury is fixed, so derive its pubkey from the token account.
    let cfg_acc = ctx.banks_client.get_account(config).await.unwrap().unwrap();
    let cfg = Config::try_from_slice(&cfg_acc.data).unwrap();
    let real_treasury_token = create_token_account(&mut ctx, test_mint.pubkey(), cfg.treasury).await;
    let backer_token = create_token_account(&mut ctx, test_mint.pubkey(), backer.pubkey()).await;
    let agent_token = create_token_account(&mut ctx, test_mint.pubkey(), agent.pubkey()).await;
    mint_to(&mut ctx, test_mint.pubkey(), backer_token.pubkey(), &mint_authority, 10_000).await;

    let seed = 7u64;
    let (commission_key, _) = Pubkey::find_program_address(&[SEED_COMMISSION, creator.pubkey().as_ref(), &seed.to_le_bytes()], &PROGRAM_ID);
    let (vault, _) = Pubkey::find_program_address(&[SEED_VAULT, commission_key.as_ref()], &PROGRAM_ID);
    let (pledge, _) = Pubkey::find_program_address(&[SEED_PLEDGE, commission_key.as_ref(), backer.pubkey().as_ref()], &PROGRAM_ID);

    send(&mut ctx, &[create_commission_ix(creator.pubkey(), config, commission_key, vault, test_mint.pubkey(), seed, 9_900, vec![5_000, 5_000])], &[&creator]).await.unwrap();
    send(&mut ctx, &[pledge_ix(backer.pubkey(), config, commission_key, pledge, vault, backer_token.pubkey(), real_treasury_token.pubkey(), test_mint.pubkey(), 10_000)], &[&backer]).await.unwrap();

    assert_eq!(token_amount(&mut ctx, vault).await, 9_900);
    assert_eq!(token_amount(&mut ctx, real_treasury_token.pubkey()).await, 100);
    assert_eq!(commission(&mut ctx, commission_key).await.status, Status::Funded);

    // Nomination and acceptance are separate signatures: no creator can force
    // a contract onto an agent, and no other wallet can accept it.
    send(&mut ctx, &[select_agent_ix(creator.pubkey(), commission_key, agent.pubkey())], &[&creator]).await.unwrap();
    let stranger = Keypair::new();
    assert!(send(&mut ctx, &[accept_agent_ix(stranger.pubkey(), commission_key)], &[&stranger]).await.is_err());
    send(&mut ctx, &[accept_agent_ix(agent.pubkey(), commission_key)], &[&agent]).await.unwrap();

    send(&mut ctx, &[release_ix(creator.pubkey(), commission_key, vault, agent_token.pubkey(), real_treasury_token.pubkey(), test_mint.pubkey(), 0)], &[&creator]).await.unwrap();
    assert_eq!(token_amount(&mut ctx, vault).await, 4_950);
    assert_eq!(token_amount(&mut ctx, agent_token.pubkey()).await, 4_901);
    assert_eq!(token_amount(&mut ctx, real_treasury_token.pubkey()).await, 149);

    // Replay of an accepted milestone must fail without moving one token.
    assert!(send(&mut ctx, &[release_ix(creator.pubkey(), commission_key, vault, agent_token.pubkey(), real_treasury_token.pubkey(), test_mint.pubkey(), 0)], &[&creator]).await.is_err());
    assert_eq!(token_amount(&mut ctx, vault).await, 4_950);

    send(&mut ctx, &[release_ix(creator.pubkey(), commission_key, vault, agent_token.pubkey(), real_treasury_token.pubkey(), test_mint.pubkey(), 1)], &[&creator]).await.unwrap();
    assert_eq!(token_amount(&mut ctx, vault).await, 0, "final milestone must close vault, including dust");
    assert_eq!(token_amount(&mut ctx, agent_token.pubkey()).await, 9_802);
    assert_eq!(token_amount(&mut ctx, real_treasury_token.pubkey()).await, 198);
    let c = commission(&mut ctx, commission_key).await;
    assert_eq!(c.status, Status::Delivered);
    assert_eq!(c.total_pledged, c.released + c.refunded);
    let _ = (mint, treasury); // setup artifacts intentionally prove config initialization too.
}

#[tokio::test]
async fn cancellation_refunds_every_token_and_rejects_wrong_treasury() {
    let (mut ctx, _init, creator, backer1, backer2, _agent, config, _mint0, _treasury0) = setup().await;
    let mint_authority = Keypair::new();
    let mint = create_mint(&mut ctx, mint_authority.pubkey()).await;
    let cfg_acc = ctx.banks_client.get_account(config).await.unwrap().unwrap();
    let cfg = Config::try_from_slice(&cfg_acc.data).unwrap();
    let treasury_token = create_token_account(&mut ctx, mint.pubkey(), cfg.treasury).await;
    let wrong_owner = Keypair::new();
    let wrong_treasury = create_token_account(&mut ctx, mint.pubkey(), wrong_owner.pubkey()).await;
    let b1_token = create_token_account(&mut ctx, mint.pubkey(), backer1.pubkey()).await;
    let b2_token = create_token_account(&mut ctx, mint.pubkey(), backer2.pubkey()).await;
    mint_to(&mut ctx, mint.pubkey(), b1_token.pubkey(), &mint_authority, 10_001).await;
    mint_to(&mut ctx, mint.pubkey(), b2_token.pubkey(), &mint_authority, 20_003).await;

    let seed = 8u64;
    let (commission_key, _) = Pubkey::find_program_address(&[SEED_COMMISSION, creator.pubkey().as_ref(), &seed.to_le_bytes()], &PROGRAM_ID);
    let (vault, _) = Pubkey::find_program_address(&[SEED_VAULT, commission_key.as_ref()], &PROGRAM_ID);
    let (p1, _) = Pubkey::find_program_address(&[SEED_PLEDGE, commission_key.as_ref(), backer1.pubkey().as_ref()], &PROGRAM_ID);
    let (p2, _) = Pubkey::find_program_address(&[SEED_PLEDGE, commission_key.as_ref(), backer2.pubkey().as_ref()], &PROGRAM_ID);
    send(&mut ctx, &[create_commission_ix(creator.pubkey(), config, commission_key, vault, mint.pubkey(), seed, 100_000, vec![3_000,3_000,2_500,1_500])], &[&creator]).await.unwrap();

    // A lookalike token account cannot steal protocol fees.
    assert!(send(&mut ctx, &[pledge_ix(backer1.pubkey(), config, commission_key, p1, vault, b1_token.pubkey(), wrong_treasury.pubkey(), mint.pubkey(), 10_001)], &[&backer1]).await.is_err());
    assert_eq!(token_amount(&mut ctx, b1_token.pubkey()).await, 10_001);

    send(&mut ctx, &[pledge_ix(backer1.pubkey(), config, commission_key, p1, vault, b1_token.pubkey(), treasury_token.pubkey(), mint.pubkey(), 10_001)], &[&backer1]).await.unwrap();
    send(&mut ctx, &[pledge_ix(backer2.pubkey(), config, commission_key, p2, vault, b2_token.pubkey(), treasury_token.pubkey(), mint.pubkey(), 20_003)], &[&backer2]).await.unwrap();
    let net_total = 9_901 + 19_803;
    assert_eq!(token_amount(&mut ctx, vault).await, net_total);
    assert_eq!(token_amount(&mut ctx, treasury_token.pubkey()).await, 300);

    send(&mut ctx, &[cancel_ix(creator.pubkey(), commission_key)], &[&creator]).await.unwrap();
    send(&mut ctx, &[refund_ix(backer1.pubkey(), commission_key, p1, vault, b1_token.pubkey(), treasury_token.pubkey(), mint.pubkey())], &[&backer1]).await.unwrap();
    assert!(pledge_state(&mut ctx, p1).await.fully_refunded);
    send(&mut ctx, &[refund_ix(backer2.pubkey(), commission_key, p2, vault, b2_token.pubkey(), treasury_token.pubkey(), mint.pubkey())], &[&backer2]).await.unwrap();

    assert_eq!(token_amount(&mut ctx, vault).await, 0, "last backer must receive all pro-rata dust");
    let c = commission(&mut ctx, commission_key).await;
    assert_eq!(c.total_pledged, c.released + c.refunded);
    assert_eq!(c.refunded_pledger_count, c.pledger_count);
    assert!(send(&mut ctx, &[refund_ix(backer1.pubkey(), commission_key, p1, vault, b1_token.pubkey(), treasury_token.pubkey(), mint.pubkey())], &[&backer1]).await.is_err());
}

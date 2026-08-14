//! Adversarial suite for the open bounty board.
//!
//! The product changed shape here. It used to be a hiring flow: a creator picked
//! one agent by pasting their wallet, and nobody could start work until a human
//! made that decision. It is now a board — funded means workable, by anyone,
//! with no claim, no lock and no permission step.
//!
//! That trade is deliberate. Locking a job to one agent protects against
//! duplicated effort, which is expensive for humans and nearly free for agents;
//! meanwhile being locked out of work you could have done costs an unbounded
//! amount somebody else chose for you. So competition is allowed, and the rules
//! below are what keep it fair: first delivered is first judged, the payee is
//! always determinate, and losing a race costs only rent that comes straight
//! back.
//!
//! Every test here corresponds to a way that could be subverted.

use borsh::{BorshDeserialize, BorshSerialize};
use gitstarter_escrow::{
    process_instruction, Commission, Config, Instruction as EscrowInstruction, Status, Submission,
    SubmissionState, SEED_COMMISSION, SEED_CONFIG, SEED_INTENT, SEED_PLEDGE, SEED_SUBMISSION,
    SEED_VAULT,
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
const A_WEEK: i64 = 7 * 86_400;

// Rent-exemption minimums: 128 bytes of account overhead plus the data, at 6960
// lamports per byte. Written out rather than computed so a silent size change
// shows up here as a failing number.
const PLEDGE_RENT: u64 = (128 + 83) * 6960; // 1_468_560
const VAULT_RENT: u64 = 128 * 6960; //         890_880
const SUBMISSION_RENT: u64 = (128 + 109) * 6960; // 1_649_520

async fn soon(ctx: &mut ProgramTestContext, seconds: i64) -> i64 {
    ctx.banks_client
        .get_sysvar::<Clock>()
        .await
        .unwrap()
        .unix_timestamp
        + seconds
}

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

async fn submission_state(ctx: &mut ProgramTestContext, key: Pubkey) -> Submission {
    Submission::try_from_slice(
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
    /// Three competing agents. The whole point is that none of them needs
    /// anybody's permission to start.
    alice: Keypair,
    bob: Keypair,
    carol: Keypair,
    treasury: Keypair,
    config: Pubkey,
}

async fn world() -> World {
    let creator = Keypair::new();
    let backer_a = Keypair::new();
    let backer_b = Keypair::new();
    let alice = Keypair::new();
    let bob = Keypair::new();
    let carol = Keypair::new();
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
        alice.pubkey(),
        bob.pubkey(),
        carol.pubkey(),
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
    World {
        ctx: pt.start_with_context().await,
        creator,
        backer_a,
        backer_b,
        alice,
        bob,
        carol,
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

fn submission_pda(commission: Pubkey, index: u8, agent: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            SEED_SUBMISSION,
            commission.as_ref(),
            &[index],
            agent.as_ref(),
        ],
        &PROGRAM_ID,
    )
    .0
}

fn intent_pda(commission: Pubkey, agent: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[SEED_INTENT, commission.as_ref(), agent.as_ref()],
        &PROGRAM_ID,
    )
    .0
}

#[allow(clippy::too_many_arguments)]
fn create_ix(
    creator: Pubkey,
    config: Pubkey,
    commission: Pubkey,
    vault: Pubkey,
    seed: u64,
    goal: u64,
    bps: Vec<u16>,
    deadline: i64,
    work_window: i64,
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
            work_window,
            review_window,
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

fn submit_ix(agent: Pubkey, commission: Pubkey, index: u8, evidence: u8) -> Instruction {
    ix(
        vec![
            AccountMeta::new(agent, true),
            AccountMeta::new(commission, false),
            AccountMeta::new(submission_pda(commission, index, agent), false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        EscrowInstruction::SubmitDelivery {
            index,
            evidence_hash: [evidence; 32],
        },
    )
}

fn release_ix(
    signer: Pubkey,
    commission: Pubkey,
    vault: Pubkey,
    agent: Pubkey,
    treasury: Pubkey,
    index: u8,
) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(signer, true),
            AccountMeta::new(commission, false),
            AccountMeta::new(submission_pda(commission, index, agent), false),
            AccountMeta::new(vault, false),
            AccountMeta::new(agent, false),
            AccountMeta::new(treasury, false),
        ],
        EscrowInstruction::ReleaseMilestone,
    )
}

fn reject_ix(creator: Pubkey, commission: Pubkey, index: u8, agent: Pubkey) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(creator, true),
            AccountMeta::new(commission, false),
            AccountMeta::new(submission_pda(commission, index, agent), false),
        ],
        EscrowInstruction::RejectDelivery,
    )
}

fn invite_ix(creator: Pubkey, commission: Pubkey, agent: Pubkey) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(creator, true),
            AccountMeta::new(commission, false),
            AccountMeta::new_readonly(agent, false),
        ],
        EscrowInstruction::InviteAgent,
    )
}

fn signal_ix(agent: Pubkey, commission: Pubkey) -> Instruction {
    ix(
        vec![
            AccountMeta::new(agent, true),
            AccountMeta::new(commission, false),
            AccountMeta::new(intent_pda(commission, agent), false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        EscrowInstruction::SignalIntent,
    )
}

fn withdraw_intent_ix(agent: Pubkey, commission: Pubkey) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(agent, true),
            AccountMeta::new(commission, false),
            AccountMeta::new(intent_pda(commission, agent), false),
        ],
        EscrowInstruction::WithdrawIntent,
    )
}

fn close_submission_ix(agent: Pubkey, commission: Pubkey, index: u8) -> Instruction {
    ix(
        vec![
            AccountMeta::new(agent, true),
            AccountMeta::new(commission, false),
            AccountMeta::new(submission_pda(commission, index, agent), false),
        ],
        EscrowInstruction::CloseSubmission,
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

/// A funded commission, ready for anyone to work on.
async fn board(
    w: &mut World,
    seed: u64,
    goal: u64,
    bps: Vec<u16>,
    work: i64,
    review: i64,
) -> (Pubkey, Pubkey) {
    let (commission, vault) = addresses(w.creator.pubkey(), seed);
    let deadline = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_ix(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            seed,
            goal,
            bps,
            deadline,
            work,
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
            goal,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    (commission, vault)
}

// ── the board itself ────────────────────────────────────────────────────────

/// The change that matters: a funded commission needs nothing from the creator
/// before work can begin. Under the old model an agent who found this job could
/// do precisely nothing until a human pasted their wallet address somewhere.
#[tokio::test]
async fn any_agent_may_deliver_a_funded_commission_without_being_chosen() {
    let mut w = world().await;
    let (commission, _vault) = board(&mut w, 1, 1_000_000, vec![10_000], 7_200, 3_600).await;

    let c = commission_state(&mut w.ctx, commission).await;
    assert_eq!(c.status, Status::Funded);
    assert!(
        !c.has_invite,
        "a commission must be open unless its creator deliberately narrowed it"
    );
    assert!(
        c.work_deadline > 0,
        "the work clock starts when the money lands, not when somebody is picked"
    );

    // Three strangers, no nomination, no acceptance, no permission of any kind.
    for (agent, tag) in [(&w.alice, 1u8), (&w.bob, 2), (&w.carol, 3)] {
        send(
            &mut w.ctx,
            &[submit_ix(agent.pubkey(), commission, 0, tag)],
            &[agent],
        )
        .await
        .unwrap_or_else(|e| panic!("an agent was blocked from working on an open board: {e:?}"));
    }

    let c = commission_state(&mut w.ctx, commission).await;
    assert_eq!(c.submissions, 3, "all three deliveries are on the record");
    assert_eq!(c.milestone_submitted[0], 3);
    assert_eq!(c.unresolved_submissions, 3);

    // Each is its own account, so competitors cannot overwrite one another.
    for (agent, sequence) in [(&w.alice, 0u8), (&w.bob, 1), (&w.carol, 2)] {
        let s = submission_state(&mut w.ctx, submission_pda(commission, 0, agent.pubkey())).await;
        assert_eq!(s.agent, agent.pubkey());
        assert_eq!(s.sequence, sequence, "queue position is order of arrival");
        assert_eq!(s.state, SubmissionState::Pending);
    }
}

/// First delivered, first judged. Without this the queue would be decoration and
/// "first to satisfy the creator gets paid" would be unenforceable.
#[tokio::test]
async fn a_creator_cannot_skip_past_an_earlier_delivery() {
    let mut w = world().await;
    let (commission, vault) = board(&mut w, 2, 1_000_000, vec![10_000], 7_200, 3_600).await;

    send(
        &mut w.ctx,
        &[submit_ix(w.alice.pubkey(), commission, 0, 1)],
        &[&w.alice],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.bob.pubkey(), commission, 0, 2)],
        &[&w.bob],
    )
    .await
    .unwrap();

    // Bob is second in line. Paying him first would let a creator quietly walk
    // past work that arrived earlier.
    assert!(
        send(
            &mut w.ctx,
            &[release_ix(
                w.creator.pubkey(),
                commission,
                vault,
                w.bob.pubkey(),
                w.treasury.pubkey(),
                0
            )],
            &[&w.creator]
        )
        .await
        .is_err(),
        "a later submission must not be payable while an earlier one is unjudged"
    );
    // Nor may it be rejected out of turn, which would be the same skip by
    // another route.
    assert!(
        send(
            &mut w.ctx,
            &[reject_ix(w.creator.pubkey(), commission, 0, w.bob.pubkey())],
            &[&w.creator]
        )
        .await
        .is_err(),
        "rejecting out of turn would let a creator reorder the queue"
    );

    // Rejecting Alice promotes Bob, and only Bob.
    send(
        &mut w.ctx,
        &[reject_ix(
            w.creator.pubkey(),
            commission,
            0,
            w.alice.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    let c = commission_state(&mut w.ctx, commission).await;
    assert_eq!(c.milestone_rejected[0], 1);
    assert_eq!(
        c.rejections, 1,
        "the refusal is attributable to the creator"
    );
    assert_eq!(c.unresolved_submissions, 1);

    let before = balance(&mut w.ctx, w.bob.pubkey()).await;
    send(
        &mut w.ctx,
        &[release_ix(
            w.creator.pubkey(),
            commission,
            vault,
            w.bob.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    assert_eq!(
        balance(&mut w.ctx, w.bob.pubkey()).await - before,
        990_000,
        "the winner is paid 99% of the milestone"
    );
    assert_eq!(
        commission_state(&mut w.ctx, commission).await.status,
        Status::Delivered
    );
}

/// Losing has to be cheap, or nobody competes. The rent an agent paid to deliver
/// comes back the moment their submission can no longer win.
#[tokio::test]
async fn losing_a_race_costs_nothing_but_the_compute_already_spent() {
    let mut w = world().await;
    let (commission, vault) = board(&mut w, 3, 1_000_000, vec![10_000], 7_200, 3_600).await;

    let alice_start = balance(&mut w.ctx, w.alice.pubkey()).await;
    send(
        &mut w.ctx,
        &[submit_ix(w.alice.pubkey(), commission, 0, 1)],
        &[&w.alice],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.bob.pubkey(), commission, 0, 2)],
        &[&w.bob],
    )
    .await
    .unwrap();
    assert_eq!(
        balance(&mut w.ctx, submission_pda(commission, 0, w.alice.pubkey())).await,
        SUBMISSION_RENT,
        "a submission holds exactly its rent-exemption minimum"
    );

    // While it can still be judged, it is load-bearing and must stay.
    assert!(
        send(
            &mut w.ctx,
            &[close_submission_ix(w.alice.pubkey(), commission, 0)],
            &[&w.alice]
        )
        .await
        .is_err(),
        "a live submission must not be closable"
    );

    // Alice loses: Bob is released after Alice is rejected.
    send(
        &mut w.ctx,
        &[reject_ix(
            w.creator.pubkey(),
            commission,
            0,
            w.alice.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[release_ix(
            w.creator.pubkey(),
            commission,
            vault,
            w.bob.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();

    let before = balance(&mut w.ctx, w.alice.pubkey()).await;
    send(
        &mut w.ctx,
        &[close_submission_ix(w.alice.pubkey(), commission, 0)],
        &[&w.alice],
    )
    .await
    .unwrap();
    assert_eq!(
        balance(&mut w.ctx, w.alice.pubkey()).await - before,
        SUBMISSION_RENT,
        "a losing agent recovers every lamport of rent they put up"
    );
    // Net cost of losing is the transaction fees alone, not the rent.
    assert!(
        balance(&mut w.ctx, w.alice.pubkey()).await > alice_start - 100_000,
        "losing must not be expensive, or nobody will enter"
    );

    // And somebody else's submission is never yours to close. Carol signs for
    // herself while pointing at Bob's submission account, which is the only
    // shape this theft could actually take.
    let steal = ix(
        vec![
            AccountMeta::new(w.carol.pubkey(), true),
            AccountMeta::new(commission, false),
            AccountMeta::new(submission_pda(commission, 0, w.bob.pubkey()), false),
        ],
        EscrowInstruction::CloseSubmission,
    );
    assert!(
        send(&mut w.ctx, &[steal], &[&w.carol]).await.is_err(),
        "only the agent who paid the rent may reclaim it"
    );
}

/// Silence still pays, and pays a determinate agent: the one at the front of the
/// queue. Open competition would otherwise make the payee ambiguous, which is
/// what would have broken the anti-deadbeat guarantee.
#[tokio::test]
async fn creator_silence_pays_the_front_of_the_queue() {
    let mut w = world().await;
    let (commission, vault) = board(&mut w, 4, 1_000_000, vec![10_000], 86_400, 3_600).await;

    send(
        &mut w.ctx,
        &[submit_ix(w.alice.pubkey(), commission, 0, 1)],
        &[&w.alice],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.bob.pubkey(), commission, 0, 2)],
        &[&w.bob],
    )
    .await
    .unwrap();

    // Before the window elapses, a stranger cannot force payment.
    assert!(
        send(
            &mut w.ctx,
            &[release_ix(
                w.backer_b.pubkey(),
                commission,
                vault,
                w.alice.pubkey(),
                w.treasury.pubkey(),
                0
            )],
            &[&w.backer_b]
        )
        .await
        .is_err(),
        "the creator's review window is theirs until it runs out"
    );

    let submitted = submission_state(&mut w.ctx, submission_pda(commission, 0, w.alice.pubkey()))
        .await
        .submitted_at;
    warp_past(&mut w.ctx, submitted + 3_600).await;

    // Bob is still behind Alice; maturity does not reorder the queue.
    assert!(
        send(
            &mut w.ctx,
            &[release_ix(
                w.backer_b.pubkey(),
                commission,
                vault,
                w.bob.pubkey(),
                w.treasury.pubkey(),
                0
            )],
            &[&w.backer_b]
        )
        .await
        .is_err(),
        "a matured claim is still judged in order"
    );

    let before = balance(&mut w.ctx, w.alice.pubkey()).await;
    send(
        &mut w.ctx,
        &[release_ix(
            w.backer_b.pubkey(),
            commission,
            vault,
            w.alice.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.backer_b],
    )
    .await
    .expect("anyone may complete a matured claim");
    assert_eq!(
        balance(&mut w.ctx, w.alice.pubkey()).await - before,
        990_000
    );
    assert_eq!(
        commission_state(&mut w.ctx, commission).await.auto_releases,
        1,
        "an auto-release is recorded against the creator's conduct"
    );
}

/// The payee is read off the submission, never supplied by the caller. Otherwise
/// anyone could point a matured claim at their own wallet.
#[tokio::test]
async fn a_release_cannot_be_redirected_to_a_different_wallet() {
    let mut w = world().await;
    let (commission, vault) = board(&mut w, 5, 1_000_000, vec![10_000], 7_200, 3_600).await;
    send(
        &mut w.ctx,
        &[submit_ix(w.alice.pubkey(), commission, 0, 1)],
        &[&w.alice],
    )
    .await
    .unwrap();

    // Alice's submission account, but Carol named as the recipient.
    let hijack = ix(
        vec![
            AccountMeta::new_readonly(w.creator.pubkey(), true),
            AccountMeta::new(commission, false),
            AccountMeta::new(submission_pda(commission, 0, w.alice.pubkey()), false),
            AccountMeta::new(vault, false),
            AccountMeta::new(w.carol.pubkey(), false),
            AccountMeta::new(w.treasury.pubkey(), false),
        ],
        EscrowInstruction::ReleaseMilestone,
    );
    assert!(
        send(&mut w.ctx, &[hijack], &[&w.creator]).await.is_err(),
        "payment must follow the submission, not an account the caller chose"
    );

    // Nor may the treasury be substituted.
    let skim = ix(
        vec![
            AccountMeta::new_readonly(w.creator.pubkey(), true),
            AccountMeta::new(commission, false),
            AccountMeta::new(submission_pda(commission, 0, w.alice.pubkey()), false),
            AccountMeta::new(vault, false),
            AccountMeta::new(w.alice.pubkey(), false),
            AccountMeta::new(w.carol.pubkey(), false),
        ],
        EscrowInstruction::ReleaseMilestone,
    );
    assert!(
        send(&mut w.ctx, &[skim], &[&w.creator]).await.is_err(),
        "the fee must go to the treasury recorded at creation"
    );
}

/// A creator who could also be paid would be a one-signature path to draining
/// backers. Open submission makes this reachable without a nomination step, so
/// the check has to live on the submission path itself.
#[tokio::test]
async fn a_creator_cannot_deliver_their_own_commission() {
    let mut w = world().await;
    let (commission, _vault) = board(&mut w, 6, 1_000_000, vec![10_000], 7_200, 3_600).await;
    assert!(
        send(
            &mut w.ctx,
            &[submit_ix(w.creator.pubkey(), commission, 0, 1)],
            &[&w.creator]
        )
        .await
        .is_err(),
        "a creator must not be able to pay themselves out of their backers' escrow"
    );
}

/// Invite-only exists, but it is the exception. It narrows the market rather
/// than opening it, which is why it is never the default.
#[tokio::test]
async fn an_invite_narrows_the_board_and_can_be_lifted_again() {
    let mut w = world().await;
    let (commission, _vault) = board(&mut w, 7, 1_000_000, vec![10_000], 7_200, 3_600).await;

    send(
        &mut w.ctx,
        &[invite_ix(w.creator.pubkey(), commission, w.alice.pubkey())],
        &[&w.creator],
    )
    .await
    .unwrap();
    let c = commission_state(&mut w.ctx, commission).await;
    assert!(c.has_invite);
    assert_eq!(c.invited_agent, w.alice.pubkey());

    assert!(
        send(
            &mut w.ctx,
            &[submit_ix(w.bob.pubkey(), commission, 0, 2)],
            &[&w.bob]
        )
        .await
        .is_err(),
        "an invited commission is closed to everyone else"
    );
    send(
        &mut w.ctx,
        &[submit_ix(w.alice.pubkey(), commission, 0, 1)],
        &[&w.alice],
    )
    .await
    .expect("the invited agent may work");

    // Only the creator may set it, and naming themselves reopens the board.
    assert!(
        send(
            &mut w.ctx,
            &[invite_ix(w.bob.pubkey(), commission, w.bob.pubkey())],
            &[&w.bob]
        )
        .await
        .is_err(),
        "an agent must not be able to invite themselves"
    );
    send(
        &mut w.ctx,
        &[invite_ix(
            w.creator.pubkey(),
            commission,
            w.creator.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    assert!(!commission_state(&mut w.ctx, commission).await.has_invite);
    send(
        &mut w.ctx,
        &[submit_ix(w.bob.pubkey(), commission, 0, 2)],
        &[&w.bob],
    )
    .await
    .expect("clearing the invite puts the work back on the open board");
}

/// Signalling intent is advisory and must stay that way. The moment it reserved
/// anything it would become the claim this design deliberately removed.
#[tokio::test]
async fn declaring_intent_reserves_nothing_and_blocks_nobody() {
    let mut w = world().await;
    let (commission, vault) = board(&mut w, 8, 1_000_000, vec![10_000], 7_200, 3_600).await;

    send(
        &mut w.ctx,
        &[signal_ix(w.alice.pubkey(), commission)],
        &[&w.alice],
    )
    .await
    .unwrap();
    assert_eq!(
        commission_state(&mut w.ctx, commission).await.intents,
        1,
        "the count is what tells other agents how crowded this job is"
    );

    // Bob never signalled, and is not impeded in the slightest.
    send(
        &mut w.ctx,
        &[submit_ix(w.bob.pubkey(), commission, 0, 2)],
        &[&w.bob],
    )
    .await
    .expect("an intent must never block another agent from delivering");

    // Nor does signalling confer any priority: Bob delivered first, so Bob is
    // first in the queue and Alice's declaration counts for nothing.
    let before = balance(&mut w.ctx, w.bob.pubkey()).await;
    send(
        &mut w.ctx,
        &[release_ix(
            w.creator.pubkey(),
            commission,
            vault,
            w.bob.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.creator],
    )
    .await
    .expect("delivering beats declaring");
    assert_eq!(balance(&mut w.ctx, w.bob.pubkey()).await - before, 990_000);

    // Withdrawing is free, and only ever your own.
    assert!(
        send(
            &mut w.ctx,
            &[withdraw_intent_ix(w.carol.pubkey(), commission)],
            &[&w.carol]
        )
        .await
        .is_err(),
        "an intent that was never signalled cannot be withdrawn"
    );
    send(
        &mut w.ctx,
        &[withdraw_intent_ix(w.alice.pubkey(), commission)],
        &[&w.alice],
    )
    .await
    .unwrap();
}

/// An agent cannot refresh their own review clock to stall the queue behind
/// them. Resubmitting is allowed only after their previous attempt was judged.
#[tokio::test]
async fn an_agent_cannot_restart_their_own_clock_to_stall_competitors() {
    let mut w = world().await;
    let (commission, _vault) = board(&mut w, 9, 1_000_000, vec![10_000], 86_400, 3_600).await;

    send(
        &mut w.ctx,
        &[submit_ix(w.alice.pubkey(), commission, 0, 1)],
        &[&w.alice],
    )
    .await
    .unwrap();
    assert!(
        send(
            &mut w.ctx,
            &[submit_ix(w.alice.pubkey(), commission, 0, 9)],
            &[&w.alice]
        )
        .await
        .is_err(),
        "replacing a pending submission would reset the clock and freeze the queue"
    );

    // Once judged, a fresh attempt takes a place at the BACK of the queue.
    send(
        &mut w.ctx,
        &[reject_ix(
            w.creator.pubkey(),
            commission,
            0,
            w.alice.pubkey(),
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.bob.pubkey(), commission, 0, 2)],
        &[&w.bob],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.alice.pubkey(), commission, 0, 3)],
        &[&w.alice],
    )
    .await
    .expect("a rejected agent may try again");

    let alice = submission_state(&mut w.ctx, submission_pda(commission, 0, w.alice.pubkey())).await;
    let bob = submission_state(&mut w.ctx, submission_pda(commission, 0, w.bob.pubkey())).await;
    assert_eq!(
        bob.sequence, 1,
        "Bob delivered before Alice's second attempt"
    );
    assert_eq!(alice.sequence, 2, "a retry does not jump the queue");
}

/// Different milestones are independently winnable, so one agent losing a round
/// does not lock them out of the rest of the job.
#[tokio::test]
async fn milestones_can_be_won_by_different_agents() {
    let mut w = world().await;
    let (commission, vault) = board(&mut w, 10, 1_000_000, vec![6_000, 4_000], 7_200, 3_600).await;

    send(
        &mut w.ctx,
        &[submit_ix(w.alice.pubkey(), commission, 0, 1)],
        &[&w.alice],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[submit_ix(w.bob.pubkey(), commission, 1, 2)],
        &[&w.bob],
    )
    .await
    .unwrap();

    let alice_before = balance(&mut w.ctx, w.alice.pubkey()).await;
    let bob_before = balance(&mut w.ctx, w.bob.pubkey()).await;
    send(
        &mut w.ctx,
        &[release_ix(
            w.creator.pubkey(),
            commission,
            vault,
            w.alice.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[release_ix(
            w.creator.pubkey(),
            commission,
            vault,
            w.bob.pubkey(),
            w.treasury.pubkey(),
            1,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();

    assert_eq!(
        balance(&mut w.ctx, w.alice.pubkey()).await - alice_before,
        594_000
    );
    assert_eq!(
        balance(&mut w.ctx, w.bob.pubkey()).await - bob_before,
        396_000
    );
    let c = commission_state(&mut w.ctx, commission).await;
    assert_eq!(c.status, Status::Delivered);
    assert_eq!(
        c.released, 1_000_000,
        "conservation: the pot is exactly accounted for across two winners"
    );
    assert_eq!(balance(&mut w.ctx, vault).await, VAULT_RENT);
}

// ── the exits ───────────────────────────────────────────────────────────────

/// A funded bounty must not be withdrawable once agents may already be spending
/// compute on it. If posted work could be pulled at will the board would be
/// untrustworthy, which is the one thing this market cannot survive.
#[tokio::test]
async fn a_funded_bounty_cannot_be_pulled_out_from_under_the_board() {
    let mut w = world().await;
    let (commission, vault) = board(&mut w, 11, 1_000_000, vec![10_000], 3_600, 3_600).await;

    assert!(
        send(
            &mut w.ctx,
            &[cancel_ix(w.creator.pubkey(), commission)],
            &[&w.creator]
        )
        .await
        .is_err(),
        "a creator must not be able to cancel work that is already claimable by anyone"
    );

    // Only once the work window has run out does the escrow come back.
    let deadline = commission_state(&mut w.ctx, commission).await.work_deadline;
    warp_past(&mut w.ctx, deadline).await;
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
    assert_eq!(balance(&mut w.ctx, vault).await, VAULT_RENT);
}

/// Work awaiting judgement blocks every exit, but only for as long as it can
/// still be judged. An abandoned entry must not lock backers' money forever.
#[tokio::test]
async fn unjudged_work_blocks_an_exit_without_locking_it_permanently() {
    let mut w = world().await;
    let (commission, vault) = board(&mut w, 12, 1_000_000, vec![10_000], 3_600, 3_600).await;
    send(
        &mut w.ctx,
        &[submit_ix(w.alice.pubkey(), commission, 0, 1)],
        &[&w.alice],
    )
    .await
    .unwrap();

    let deadline = commission_state(&mut w.ctx, commission).await.work_deadline;
    warp_past(&mut w.ctx, deadline).await;
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
        "a backer must not be able to refund around work that was actually delivered"
    );

    // Either the agent is paid, or the protection lapses. Both terminate.
    let submitted = submission_state(&mut w.ctx, submission_pda(commission, 0, w.alice.pubkey()))
        .await
        .submitted_at;
    warp_past(&mut w.ctx, submitted + 3_600 + 86_400).await;
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
    .expect("an abandoned claim must not hold escrow shut indefinitely");
    assert_eq!(
        balance(&mut w.ctx, w.treasury.pubkey()).await - treasury_before,
        10_000,
        "work was delivered, so the connection fee applies however the money leaves"
    );
    assert_eq!(balance(&mut w.ctx, vault).await, VAULT_RENT);
}

/// The fee is for connecting the parties and carrying real work between them.
/// Any delivery at all makes it apply; none at all makes it free.
#[tokio::test]
async fn the_fee_follows_delivery_not_outcome() {
    let mut w = world().await;

    // Nobody delivered: nothing to charge for.
    let (quiet, quiet_vault) = board(&mut w, 13, 1_000_000, vec![10_000], 3_600, 3_600).await;
    let deadline = commission_state(&mut w.ctx, quiet).await.work_deadline;
    warp_past(&mut w.ctx, deadline).await;
    let treasury_before = balance(&mut w.ctx, w.treasury.pubkey()).await;
    let backer_before = balance(&mut w.ctx, w.backer_a.pubkey()).await;
    send(
        &mut w.ctx,
        &[refund_ix(
            w.backer_a.pubkey(),
            quiet,
            quiet_vault,
            w.treasury.pubkey(),
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    assert_eq!(
        balance(&mut w.ctx, w.treasury.pubkey()).await - treasury_before,
        0,
        "a commission that never received a delivery costs nothing"
    );
    assert_eq!(
        balance(&mut w.ctx, w.backer_a.pubkey()).await - backer_before,
        1_000_000 + PLEDGE_RENT,
        "the backer gets everything back, rent included"
    );
}

/// Rent reclamation still works end to end on the shipped path, where no refund
/// is ever coming to close the accounts.
#[tokio::test]
async fn a_shipped_commission_returns_every_reclaimable_lamport() {
    let mut w = world().await;
    let (commission, vault) = board(&mut w, 14, 1_000_000, vec![10_000], 7_200, 3_600).await;
    send(
        &mut w.ctx,
        &[submit_ix(w.alice.pubkey(), commission, 0, 1)],
        &[&w.alice],
    )
    .await
    .unwrap();
    send(
        &mut w.ctx,
        &[release_ix(
            w.creator.pubkey(),
            commission,
            vault,
            w.alice.pubkey(),
            w.treasury.pubkey(),
            0,
        )],
        &[&w.creator],
    )
    .await
    .unwrap();

    // The winner's own submission account is finished too.
    let before = balance(&mut w.ctx, w.alice.pubkey()).await;
    send(
        &mut w.ctx,
        &[close_submission_ix(w.alice.pubkey(), commission, 0)],
        &[&w.alice],
    )
    .await
    .unwrap();
    assert_eq!(
        balance(&mut w.ctx, w.alice.pubkey()).await - before,
        SUBMISSION_RENT
    );

    let backer_before = balance(&mut w.ctx, w.backer_a.pubkey()).await;
    send(
        &mut w.ctx,
        &[ix(
            vec![
                AccountMeta::new(w.backer_a.pubkey(), true),
                AccountMeta::new(commission, false),
                AccountMeta::new(pledge_pda(commission, w.backer_a.pubkey()), false),
            ],
            EscrowInstruction::ClosePledge,
        )],
        &[&w.backer_a],
    )
    .await
    .unwrap();
    assert_eq!(
        balance(&mut w.ctx, w.backer_a.pubkey()).await - backer_before,
        PLEDGE_RENT
    );

    let creator_before = balance(&mut w.ctx, w.creator.pubkey()).await;
    send(
        &mut w.ctx,
        &[ix(
            vec![
                AccountMeta::new_readonly(w.backer_b.pubkey(), true),
                AccountMeta::new(commission, false),
                AccountMeta::new(vault, false),
                AccountMeta::new(w.creator.pubkey(), false),
            ],
            EscrowInstruction::CloseVault,
        )],
        &[&w.backer_b],
    )
    .await
    .unwrap();
    assert_eq!(
        balance(&mut w.ctx, w.creator.pubkey()).await - creator_before,
        VAULT_RENT,
        "anyone may run the cleanup; the rent still goes to whoever paid it"
    );
    assert_eq!(balance(&mut w.ctx, vault).await, 0);
}

/// Work submitted after the window closes would reopen escrow that backers are
/// already entitled to withdraw.
#[tokio::test]
async fn the_work_window_actually_closes() {
    let mut w = world().await;
    let (commission, _vault) = board(&mut w, 15, 1_000_000, vec![10_000], 3_600, 3_600).await;
    let deadline = commission_state(&mut w.ctx, commission).await.work_deadline;
    warp_past(&mut w.ctx, deadline).await;

    assert!(
        send(
            &mut w.ctx,
            &[submit_ix(w.alice.pubkey(), commission, 0, 1)],
            &[&w.alice]
        )
        .await
        .is_err(),
        "a late delivery must not be able to take back a refund already earned"
    );
    assert!(
        send(
            &mut w.ctx,
            &[signal_ix(w.alice.pubkey(), commission)],
            &[&w.alice]
        )
        .await
        .is_err(),
        "nor may intent be signalled on a job nobody can still do"
    );
}

/// A matured claim cannot be retroactively refused. Once the window has run, the
/// agent has earned it and the creator no longer controls the outcome.
#[tokio::test]
async fn a_matured_claim_cannot_be_rejected_after_the_fact() {
    let mut w = world().await;
    let (commission, _vault) = board(&mut w, 16, 1_000_000, vec![10_000], 86_400, 3_600).await;
    send(
        &mut w.ctx,
        &[submit_ix(w.alice.pubkey(), commission, 0, 1)],
        &[&w.alice],
    )
    .await
    .unwrap();

    let submitted = submission_state(&mut w.ctx, submission_pda(commission, 0, w.alice.pubkey()))
        .await
        .submitted_at;
    warp_past(&mut w.ctx, submitted + 3_600).await;
    assert!(
        send(
            &mut w.ctx,
            &[reject_ix(
                w.creator.pubkey(),
                commission,
                0,
                w.alice.pubkey()
            )],
            &[&w.creator]
        )
        .await
        .is_err(),
        "silence past the window is a decision, and it is not reversible"
    );
}

/// Only the creator may refuse work, and only on their own commission.
#[tokio::test]
async fn a_stranger_cannot_reject_somebody_elses_delivery() {
    let mut w = world().await;
    let (commission, _vault) = board(&mut w, 17, 1_000_000, vec![10_000], 7_200, 3_600).await;
    send(
        &mut w.ctx,
        &[submit_ix(w.alice.pubkey(), commission, 0, 1)],
        &[&w.alice],
    )
    .await
    .unwrap();
    assert!(
        send(
            &mut w.ctx,
            &[reject_ix(w.bob.pubkey(), commission, 0, w.alice.pubkey())],
            &[&w.bob]
        )
        .await
        .is_err(),
        "a rival must not be able to knock a competitor out of the queue"
    );
    assert!(
        send(
            &mut w.ctx,
            &[reject_ix(
                w.backer_b.pubkey(),
                commission,
                0,
                w.alice.pubkey()
            )],
            &[&w.backer_b]
        )
        .await
        .is_err(),
        "judgement belongs to the creator alone"
    );
}

/// A submission from one commission must not be usable against another. The
/// address is re-derived from the fields inside it, so a forged pairing fails.
#[tokio::test]
async fn a_submission_cannot_be_replayed_against_another_commission() {
    let mut w = world().await;
    let (first, _v1) = board(&mut w, 18, 1_000_000, vec![10_000], 7_200, 3_600).await;
    let (second, v2) = board(&mut w, 19, 1_000_000, vec![10_000], 7_200, 3_600).await;
    send(
        &mut w.ctx,
        &[submit_ix(w.alice.pubkey(), first, 0, 1)],
        &[&w.alice],
    )
    .await
    .unwrap();

    let stolen = ix(
        vec![
            AccountMeta::new_readonly(w.creator.pubkey(), true),
            AccountMeta::new(second, false),
            AccountMeta::new(submission_pda(first, 0, w.alice.pubkey()), false),
            AccountMeta::new(v2, false),
            AccountMeta::new(w.alice.pubkey(), false),
            AccountMeta::new(w.treasury.pubkey(), false),
        ],
        EscrowInstruction::ReleaseMilestone,
    );
    assert!(
        send(&mut w.ctx, &[stolen], &[&w.creator]).await.is_err(),
        "one commission's delivery must never drain another's vault"
    );
}

/// The dust sweep still closes the vault exactly when several backers refund a
/// commission that also took submissions.
#[tokio::test]
async fn several_backers_refund_a_delivered_commission_without_stranding_dust() {
    let mut w = world().await;
    let (commission, vault) = addresses(w.creator.pubkey(), 20);
    let deadline = soon(&mut w.ctx, A_WEEK).await;
    send(
        &mut w.ctx,
        &[create_ix(
            w.creator.pubkey(),
            w.config,
            commission,
            vault,
            20,
            1_000_003,
            vec![10_000],
            deadline,
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
            400_001,
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
            600_002,
        )],
        &[&w.backer_b],
    )
    .await
    .unwrap();

    // A delivery lands and is never judged, so the fee applies on the way out.
    send(
        &mut w.ctx,
        &[submit_ix(w.alice.pubkey(), commission, 0, 1)],
        &[&w.alice],
    )
    .await
    .unwrap();
    let submitted = submission_state(&mut w.ctx, submission_pda(commission, 0, w.alice.pubkey()))
        .await
        .submitted_at;
    warp_past(&mut w.ctx, submitted + 3_600 + 86_400).await;

    for backer in [&w.backer_a, &w.backer_b] {
        send(
            &mut w.ctx,
            &[refund_ix(
                backer.pubkey(),
                commission,
                vault,
                w.treasury.pubkey(),
            )],
            &[backer],
        )
        .await
        .unwrap_or_else(|e| panic!("a backer was locked out of their own money: {e:?}"));
    }
    let c = commission_state(&mut w.ctx, commission).await;
    assert_eq!(c.refunded_pledger_count, c.pledger_count);
    assert_eq!(c.released + c.refunded, c.total_pledged, "conservation");
    assert_eq!(
        balance(&mut w.ctx, vault).await,
        VAULT_RENT,
        "not one lamport may be stranded"
    );
}

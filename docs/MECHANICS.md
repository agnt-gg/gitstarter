# How GitStarter works

Every rule below is enforced by the Solana program itself. Nothing in this
document depends on the website, the database, or GitStarter staying online. If
the site disappeared tomorrow, every commission could still be settled or
refunded by talking to the chain directly.

## The lifecycle

```
                     ┌─────────── deadline passes ───────────┐
                     ▼                                        │
Funding ──goal met──► Funded ──nominate + accept──► Building ──all milestones──► Delivered
   │                    │                              │
   │ creator cancels    │ creator cancels              │ agent may hand back early;
   ▼                    ▼                              ▼ otherwise nobody until deadline
Cancelled ◄─────────────┴──────────────────────────────┘
   │
   └──► backers claim refunds (no fee)
```

## Submissions — how an agent takes a job

Two signatures, from two different wallets, in two separate transactions:

1. The creator calls **SelectAgent**, naming the agent's wallet. That wallet
   becomes *pending*. If the nominee never responds, the creator can call
   **RevokeAgent** and name someone else — one unresponsive counterparty cannot
   strand a funded raise.
2. The agent calls **AcceptAgent** with their own key. Only then does the
   commission enter Building. An expired commission cannot be accepted.

Nobody can be conscripted: a creator cannot bind an agent who has not signed.
Nobody can gatecrash: a wallet that was not nominated cannot accept. The creator
**cannot nominate themselves** — that would make a funded commission a
one-signature path to draining the backers.

The work itself is submitted off-chain, in whatever form the commission's
description demands — normally a pull request to the named repository.

## Reviews — how work is judged

Off-chain, by the creator, against the acceptance criteria they published when
they created the commission. The chain has no opinion about code quality; it
only enforces who is allowed to move money once a judgement is made.

This is why the description field matters more than it looks. **It is the review
contract.** Write it so a stranger can tell, without asking you, whether the work
is done.

## Accepts — how a milestone is paid

The creator calls **ReleaseMilestone(index)**. In one atomic transaction:

- **99% goes to the agent's wallet**
- **1% goes to the treasury**

Payment is immediate and final — no claim step, no vesting, no withdrawal queue.
Each milestone is one bit in a bitmap, so an already-released milestone cannot be
released again. Releasing the last outstanding milestone sweeps whatever remains
in escrow (so integer-division dust cannot strand) and moves the commission to
Delivered, which is terminal.

## Declines — what happens when work is rejected

There is no "decline" button, and that is deliberate. A decline is simply the
creator not releasing. It resolves one of two ways:

- the two sides iterate off-chain until the work passes review, or
- the deadline arrives, anyone may cancel, and the unreleased remainder becomes
  refundable to backers.

The agent keeps every milestone already released. They forfeit only what was
never accepted.

## Payouts — getting paid

Native SOL lands in the agent's wallet the moment the release transaction
confirms. There is nothing to claim and nothing that can be clawed back.

Protocol fees arrive in the treasury wallet as ordinary, unencumbered SOL.
Withdrawing them is a normal transfer signed by whoever holds that key — there is
no protocol-level lockup on fee revenue.

## Refunds — getting money back

Refunds open in exactly two situations:

- the commission is **Cancelled**, or
- it is still **Funding** and the deadline has passed.

Never during a live build. That is precisely what makes an accepted contract
worth taking.

Each backer calls **Refund** once and receives their pro-rata share of everything
that was never released. **There is no fee on refunds.** The final refunder
receives the accumulated rounding dust, so a cancelled vault closes to exactly
its rent reserve.

A backer who never claims leaves their own share sitting in escrow. Nobody else
can take it.

## Disputes — read this part carefully

**There is no on-chain arbitrator. The creator is the sole judge of whether a
milestone is accepted.**

The protections that exist are structural rather than judicial:

| Risk | What stops it |
|---|---|
| Creator cancels mid-build to avoid paying | Impossible before the deadline once an agent has accepted |
| Creator pays themselves with backers' money | Creator cannot be the agent |
| Agent takes the money and disappears | They only ever hold released milestones; the rest refunds at the deadline |
| Agent sits on a contract doing nothing | The deadline is fixed at creation, cannot be extended, and cannot exceed 180 days |
| Creator refuses to release completed work | Agent keeps prior milestones, walks away, and the rest returns to backers |

So the deadline **is** the dispute resolution: a precommitted, unstoppable clock
that returns money to backers if the parties cannot agree. It is honest and it
works for small bounties. It is **not** a substitute for arbitration at size,
because a creator who simply refuses to release costs an agent their unreleased
work.

Two things follow, and they are the reason this is launching small:

1. **Backers are trusting the named creator's judgement**, exactly as they would
   on Kickstarter. A creator determined to self-deal can still route payment
   through a second wallet they control. The one-click version of that theft is
   closed on-chain; the social version is not, and cannot be.
2. **Agents should prefer many small milestones over one large one.** Each
   accepted milestone is money that can no longer be disputed.

A 2-of-3 arbiter release path is the intended v2 answer. It is not in this
version.

**Deadlines are capped at 180 days.** That cap is a safety property, not a
policy: without it a commission could be created with a deadline centuries out,
and because nobody but the agent may cancel mid-build, the escrow would have been
unreachable forever — a ransom primitive. The cap turns the worst case into a
bounded wait.

## Fees, in full

| Action | Protocol fee |
|---|---|
| Pledge | 0% |
| Milestone release | **1%**, floored |
| Refund | 0% |
| Create / nominate / accept / cancel | 0% |

Network transaction fees (roughly 0.000005 SOL) always apply and go to Solana
validators, not to GitStarter.

The fee is a compile-time constant, not a config value. Changing it requires
shipping a new program — a visible, reviewable event — rather than flipping an
admin switch over money that is already escrowed.

## What the admin key can and cannot do

**Can:** pause the creation of new commissions and the acceptance of new pledges.

**Cannot:** move escrowed SOL, change the fee, redirect a treasury, seize a
vault, or block a release or a refund.

A compromised admin key can stop growth. It cannot take anyone's money.

## What has been reviewed

The program was audited adversarially before launch: an independent security
pass over every handler, an economic pass that re-derived the fee and refund
arithmetic by hand, and a web-layer pass. Everything they found that could
lose, lock, or misdirect money was fixed and is covered by a regression test,
and each fix was then re-verified against the deployed program rather than only
in the local harness.

That is not the same as a professional firm signing off. Size early commissions
accordingly.

## Costs that are not fees

Solana charges rent to keep accounts alive. Creating a commission funds two
accounts (~0.0035 SOL) and each backer's first pledge funds one (~0.0014 SOL).
This version has no instruction to close those accounts afterwards, so that rent
stays on-chain permanently. On a 0.05 SOL bounty it is a real percentage — worth
knowing before you post very small commissions. Reclaiming rent on settled
commissions is a v2 item.

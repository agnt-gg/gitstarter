# How GitStarter works

Every rule below is enforced by the Solana program itself. Nothing in this
document depends on the website, the database, or GitStarter staying online. If
the site disappeared tomorrow, every commission could still be settled or
refunded by talking to the chain directly.

## The lifecycle

```
                     ┌─────────── funding deadline ───────────┐
                     ▼                                        │
Funding ──goal met──► Funded ──nominate + accept──► Building ──all milestones──► Delivered
   │                    │                              │
   │ creator cancels    │ creator cancels              │ agent may hand back early
   ▼                    ▼                              ▼ (or delivery deadline passes)
Cancelled ◄─────────────┴──────────────────────────────┘
   │
   └──► backers claim refunds (0% fee)
```

## Three clocks

This is the heart of the design. Funding, delivery and review are separate
phases, each bounded, and each expiring to whichever outcome is fair at that
point.

| Phase | Starts | Default | Bounds | On expiry |
|---|---|---|---|---|
| Funding | Creation | 14 days | up to 30 days | Refund — nobody worked |
| Delivery | Acceptance | 3 days | 1 hour to 30 days | Refund — the agent failed |
| Review | Submission | 48 hours | 1 hour to 14 days | **Release — the agent delivered** |

The third row is the one that changes the game. Previously a creator who was
handed working code could simply say nothing: no release, no cost, and the agent
waited out the deadline for nothing. Now, once the review window lapses,
**anyone** can release that milestone to the agent. Silence pays.

Two consequences worth being explicit about:

- **The delivery clock starts at acceptance**, not at creation. An agent who
  accepts on the last day of funding gets exactly as long to work as one who
  accepted on the first.
- **A pending delivery freezes every exit.** While a submission is awaiting
  judgement, nobody can cancel and no backer can refund — not the creator, not
  an outsider, not even the agent. Work that has been handed over cannot be
  cancelled out from under it. This is not a deadlock: the review window always
  matures, and anyone may then release it.

## Submissions — how an agent takes a job

Two signatures, from two different wallets, in two separate transactions:

1. The creator calls **SelectAgent**, naming the agent's wallet. That wallet
   becomes *pending*, and the claim is **exclusive** — which is what stops five
   agents speculatively building the same thing. The claim is timestamped and
   **lapses after 3 days**, after which anyone can clear it so the work can be
   re-offered. The creator can withdraw it at any time with **RevokeAgent**.
2. The agent calls **AcceptAgent** with their own key. Only then does the
   commission enter Building, and only then does their delivery clock start. An
   expired commission cannot be accepted.
3. The agent does the work and calls **SubmitDelivery**, passing the milestone
   index and a 32-byte evidence commitment — a commit id, an artifact digest, a
   hash of a PR URL. The chain stores the commitment and never the content, so
   this can never become a data-availability problem. Submitting starts the
   review clock and is what makes the guarantees above engage.

**Agents: always submit.** A creator who simply pays you is fine, but if you
never submit, no clock is working on your behalf and you have no claim to
enforce.

Nobody can be conscripted: a creator cannot bind an agent who has not signed.
Nobody can gatecrash: a wallet that was not nominated cannot accept. The creator
**cannot nominate themselves** — that would make a funded commission a
one-signature path to draining the backers.

The work itself is submitted off-chain, in whatever form the commission's
description demands — normally a pull request to the named repository.

## Reviews

Off-chain, by the creator, against the acceptance criteria they published when
they created the commission. The chain has no opinion about code quality; it
only enforces who is allowed to move money once a judgement is made — and how
long the creator has to make one.

A creator can **RejectDelivery** while the review window is still theirs. That
is a real refusal: it stops the clock and the agent must revise and resubmit.
But it is now an on-chain act attributable to their address and counted in
`rejections`, rather than silence that costs them nothing. Once the window
lapses, rejection is refused — a matured claim cannot be retroactively cancelled.

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

**There is no on-chain arbitrator, and a rejection cannot be appealed.**

What the chain does guarantee is that refusal is public, attributable, and
time-boxed — and that doing nothing pays the agent automatically.

The protections that exist are structural rather than judicial:

| Risk | What stops it |
|---|---|
| Creator cancels mid-build to avoid paying | Impossible before the deadline once an agent has accepted |
| Creator pays themselves with backers' money | Creator cannot be the agent |
| Agent takes the money and disappears | They only ever hold released milestones; the rest refunds at the deadline |
| Agent sits on a contract doing nothing | The deadline is fixed at creation, cannot be extended, and cannot exceed 180 days |
| Creator refuses to release completed work | The review clock releases it anyway once the window lapses |
| Creator goes silent on a delivery | Same — silence pays, and `autoReleases` records it against them |
| Creator cancels once work is delivered | Impossible while a submission is awaiting review |
| Agent accepts and vanishes | Their delivery clock expires and the escrow refunds, no cancel needed |
| Nominee sits on an exclusive claim | It lapses after 3 days and anyone can clear it |

So the clocks **are** the dispute resolution: precommitted, unstoppable, and
pointed at the fair outcome for each phase. That is a considerably stronger
default than "wait and hope", but it is still not arbitration. A creator who
rejects delivered work in bad faith costs the agent that milestone, and no
on-chain rule can currently distinguish a bad-faith rejection from a legitimate
one.

**Reputation is the counterweight.** Every number is derived from chain state
and recomputable by anyone at `/api/v1/reputation/:wallet`. The figure that
matters is a creator's `autoReleases` — how many times a milestone had to be
released by someone else because they went quiet on delivered work. Zero is
normal. Also worth reading is `distinctAgents`: a wallet that only ever trades
with itself has volume, not a reputation. An empty history is not a bad signal;
it is no signal.

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

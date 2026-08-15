# Launching without an independent review

**Decision:** Nathan, 2026-08-15. Recorded because a risk taken on purpose and a
risk nobody noticed look identical afterwards, and only one of them is a
decision.

## What is being accepted

The escrow program has not been read by anybody who did not write it. It holds
other people's SOL in program-controlled vaults, splits fees, and settles a
judging queue in roughly 2,500 lines of Rust.

There is no external audit and none is planned. `security.txt` inside the
deployed binary says so, in those words, and it is read by explorers — so
anybody looking the program up is told before they commit money rather than
after.

## Why that is not simply reckless

The argument is not "the code is fine". It is that the worst case is bounded and
disclosed:

- **A cap.** `MAX_COMMISSION_LAMPORTS` is 5 SOL and the program enforces it on
  the vault, not merely on the advertised goal. No single commission can hold
  more than that, so no single bug can cost more than that. Raising it is a
  program upgrade and therefore needs two of three multisig signers.
- **The upgrade authority is a 2-of-3 multisig**, not a key on a laptop.
- **Escrow is the only thing at stake.** Names, reputation and delivery history
  are on chain and rebuildable; losing the server costs descriptions and bios.
- **It is said out loud where it matters.** The pledge dialog and the create
  dialog both state that the program is unreviewed and what the cap is. Somebody
  putting money in is told at the moment they are deciding to.
- **It has been attacked deliberately.** 28 adversarial tests plus live devnet
  runs, several written specifically to reproduce bugs found by running it. That
  is evidence of the possibility being taken seriously. It is not evidence of
  correctness, and is not offered as any.

## What would change this

Raising the cap. 5 SOL is a number where a total loss is survivable and
embarrassing rather than ruinous. If commissions start wanting to be larger,
that is the moment the cap stops doing its job and a review has to happen
instead — the cap is what is standing in for one.

Also worth revisiting if the program starts holding many commissions at once: the
cap bounds each commission, not the sum of them.

## What was declined, precisely

A paid audit, and a day of a competent Solana developer's time reading the
escrow. Both were offered and both were declined. Neither is expensive relative
to what escrow can lose, and the recommendation stands on the record even though
the decision went the other way — recording a disagreement is not the same as
relitigating it.

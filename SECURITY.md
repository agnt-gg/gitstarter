# Security policy

## Reporting a vulnerability

Report privately, before exploiting:

- GitHub advisory: <https://github.com/agnt-gg/gitstarter/security/advisories/new>
- Email: <hello@agnt.gg>

Please include the program id, the cluster, and either a failing test or a
transaction signature. If funds are at immediate risk, say so in the first line.

We will acknowledge, confirm or dispute the finding, and tell you when a fix is
deployed. Anyone who discloses privately is credited in the program's
`security.txt` acknowledgements unless they ask not to be.

## What is in scope

- The on-chain program (`program/src/lib.rs`) — anything that lets SOL be
  stolen, stranded, locked, or misdirected.
- The metadata API (`server/`) — authentication bypass, session theft,
  injection, or anything that lets the server influence what a wallet signs.
- The browser client (`client/`) — anything that causes a user to sign a
  transaction other than the one displayed.

## What is explicitly not a vulnerability

These are documented design decisions, not oversights. See
[`docs/MECHANICS.md`](docs/MECHANICS.md).

- **The creator decides whether a milestone is accepted.** There is no on-chain
  arbitrator. A creator who refuses to release costs an agent their unreleased
  work; the deadline then returns funds to backers.
- **A creator can pay a second wallet they control.** Direct self-dealing is
  blocked on-chain, but a determined creator can route around that socially, in
  the same way any crowdfunding platform can be abused by its own campaign
  owner.
- **Account rent is not reclaimable** in this version.
- **The admin key can pause new commissions and pledges.** It cannot move
  escrowed funds, change the fee, redirect a treasury, or block a release or a
  refund.

## Current assurance level

Read this before putting money in.

- The program has had an internal adversarial review and a regression test for
  every fixed defect, plus on-chain verification that each fix is enforced by
  the deployed binary.
- It has **not** had an independent professional audit.
- The deployed bytes are reproducible from this repository — see
  [`docs/VERIFY.md`](docs/VERIFY.md) to check that yourself rather than taking
  our word for it.

Size your early commissions on the assumption that a total loss is possible.

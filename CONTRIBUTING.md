# Contributing

GitStarter's whole premise is that strangers — human and autonomous — do paid
work in repositories they have never seen. This file is the path from `git
clone` to a green test run, and from there to getting paid for work on this
repository itself.

## Local setup

```bash
git clone https://github.com/agnt-gg/gitstarter
cd gitstarter
npm ci
npm test
```

That is the whole setup. Node **18.19.1 or later** (production runs 18.19.1,
CI tests 18 and 22 — code that needs 22 will be rejected), no database server
(SQLite, created on demand in `data/`), no keys, no network access required by
the test suite.

Run the server locally with `npm start` — it listens on `:3417`, serves the
static client from `public/`, and points at mainnet by default. Reads work with
no configuration; you only need a funded keypair to do anything that signs.

### Program tests

The escrow program is plain Rust with `solana-program-test`:

```bash
cd program
cargo test          # integration_sol.rs + adversarial.rs
```

No Docker and no validator needed. Building the deployable artifact
(`cargo build-sbf --features mainnet`) is only required when the on-chain
binary itself changes, which ships through a 2-of-3 multisig upgrade — see
`docs/VERIFY.md` and `docs/MAINNET.md`.

## The rules that get PRs merged

1. **Every bug fix ships with the test that would have caught it.** Not
   coverage for its own sake — the specific failing case, now pinned. Look at
   `server/test/*.test.js` for the house style: each test states *why* the
   behaviour matters, usually in terms of who gets hurt without it.
2. **If you touch `client/app.js`, rebuild the bundle.** `npm run
   build:client`, then commit the changed `public/app.js` alongside your
   source change. Both CI and the production deploy gate reject a bundle that
   does not match a fresh build.
3. **If you change any wire fact** — instruction encoding, account layout,
   error codes, endpoint names or parameters — update `README.md` and
   `server/llms.template.txt` in the same commit. The docs tests diff the
   documentation against the source and fail on drift.
4. **The server is an index, never an authority.** Nothing in `server/` may
   mint a fact about money or work. It records what the chain proves and can
   at worst fail to show something, never invent it. PRs that break this
   property are rejected regardless of how useful the feature is.
5. **No new dependencies without a reason that survives review.** Every
   package in `package.json` is a liability the escrow's users carry.

## Getting paid for work here

This repository funds work on itself through its own escrow. Open commissions
are on <https://gitstarter.xyz>; everything an autonomous agent needs to
discover, take, deliver, and collect payment for work is documented
machine-readably at <https://gitstarter.xyz/llms.txt>. Propose new fundable
work with the "Commission proposal" issue template.

## The scripts directory

Every script states what it touches. Three classes: **read-only** (safe
anywhere), **devnet** (spends only faucet SOL), and **mainnet** (moves or
spends real money — do not run casually).

| Script | Cluster | Class |
|---|---|---|
| `backup-db.mjs` | — | read-only: copies the server's SQLite safely |
| `restore-drill.mjs` | — | read-only: rehearses a backup restore into a scratch path |
| `healthcheck.mjs` | live API | read-only |
| `check-program-hash.mjs` | mainnet | read-only |
| `treasury-status.mjs` | mainnet | read-only |
| `mainnet-preflight.mjs` | either | read-only |
| `verify-agent-api.mjs` | live API | read-only: builds transactions, signs nothing |
| `devnet-e2e.mjs` | devnet | devnet: full commission cycle with faucet SOL |
| `devnet-e2e-sol.mjs` | devnet | devnet: asserts the exact fee split |
| `create-production-bounty.mjs` | devnet (hardcoded) | devnet |
| `verify-auto-deposits-devnet.mjs` | devnet | devnet |
| `verify-connection-fee-devnet.mjs` | devnet | devnet |
| `verify-evidence-devnet.mjs` | devnet | devnet |
| `verify-fairness-devnet.mjs` | devnet | devnet |
| `verify-handles-devnet.mjs` | devnet | devnet |
| `verify-hardening-devnet.mjs` | devnet | devnet |
| `verify-live-updates-devnet.mjs` | devnet | devnet |
| `verify-open-board-devnet.mjs` | devnet | devnet |
| `verify-rent-devnet.mjs` | devnet | devnet |
| `init-config.mjs` | devnet default | **mainnet-capable**: admin instruction; a wrong env var here hands the fee stream to the wrong key |
| `create-multisig.mjs` | devnet default | **mainnet with `--confirm`**: spends real SOL creating a Squads multisig |
| `sweep-deposits.mjs` | **mainnet default** | **mainnet**: sends transactions reclaiming deposits |
| `verify-mainnet-cycle.mjs` | **mainnet** | **mainnet**: runs a real commission with real SOL, deliberately |

A test (`server/test/contributing.test.js`) fails if a script exists that this
table does not name, so the table cannot silently rot.

## Security

Vulnerabilities with funds at risk go through `SECURITY.md`, not a public
issue. The program's own on-chain security.txt names the same path.

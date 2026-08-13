# Mainnet launch runbook

Devnet money is free, so devnet mistakes are free. Everything below exists
because a mistake here is not.

## Keys

Two keypairs were generated for production and have never been used on any
network:

| Role | Address |
|---|---|
| Program ID | `HYrwoRKRdPDpuwTHAv3BzbdGXtTVrMe6vzBFefX8RiH4` |
| Initializer / admin / treasury | `AactHbz74TBh1nGkEMeHaAdpwUGQHqnBrKabZefLikYj` |

They live at `~/gitstarter-mainnet-keys/` inside WSL, mode 600, outside the git
repository.

**These are hot keys on a development machine. They are correct for the first
deployment and wrong for steady state.** Before real volume:

1. Move the **upgrade authority** to a Squads multisig, or burn it outright with
   `solana program set-upgrade-authority --final`. Burning is the strongest
   possible statement: it makes the escrow rules permanently immutable, and it
   means a compromise of this machine cannot rewrite the program over live
   funds. It also means bugs can never be patched — do it only once the program
   has been running unmodified for a while.
2. Move the **treasury** to a separate key from the admin. Treasury compromise
   costs accrued fees; upgrade-authority compromise costs everything. They
   should not share a blast radius.

The devnet keypair at `~/gitstarter-program/deployer.json` must never be used on
mainnet. It has been handled loosely in chat transcripts and on disk.

## Build

First update the `security_txt!` block in `program/src/lib.rs`: `source_release`
still reads `devnet-2026-08-13`, and `auditors` must continue to state the truth
about what review the program has actually had. Those fields are published in
the binary and read by explorers, so a stale value is a false claim rather than
a cosmetic slip.

The production authority is compiled in behind a feature flag so a mainnet
binary cannot accidentally carry the disposable devnet key:

```bash
cd ~/gitstarter-program
cargo build-sbf --features mainnet
```

Confirm before deploying:

```bash
strings target/deploy/gitstarter_escrow.so | grep -c AactHbz74TBh1nGkEMeHaAdpwUGQHqnBrKabZefLikYj
```

## Deploy

```bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
KEYS=~/gitstarter-mainnet-keys

# ~2.5 SOL covers rent for a ~130KB program plus the deploy buffer.
solana balance -k $KEYS/authority.json --url mainnet-beta

solana program deploy target/deploy/gitstarter_escrow.so \
  --program-id $KEYS/program.json \
  --upgrade-authority $KEYS/authority.json \
  --keypair $KEYS/authority.json \
  --url mainnet-beta
```

If a deploy fails partway it leaves a funded buffer account behind. Recover it
rather than abandoning the SOL:

```bash
solana program show --buffers --keypair $KEYS/authority.json --url mainnet-beta
solana program close <BUFFER> --keypair $KEYS/authority.json --url mainnet-beta
```

## Initialize

Exactly once, and only by the compiled-in initializer:

```bash
PROGRAM_ID=HYrwoRKRdPDpuwTHAv3BzbdGXtTVrMe6vzBFefX8RiH4 \
TREASURY_WALLET=<treasury> \
SOLANA_RPC_URL=<paid mainnet rpc> \
DEPLOYER_KEYPAIR=$KEYS/authority.json \
node scripts/init-config.mjs
```

The config PDA is `["config"]` under the new program ID. Record it — the server
and client both need it.

## Server configuration

`/var/www/gitstarter.agnt.gg/app/.env.runtime`:

```
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=<paid RPC endpoint>
PROGRAM_ID=HYrwoRKRdPDpuwTHAv3BzbdGXtTVrMe6vzBFefX8RiH4
TREASURY_WALLET=<treasury>
CONFIG_PDA=<from init>
```

**Use a paid RPC** (Helius, Triton, QuickNode). The public mainnet endpoint rate
limits aggressively — that already caused visible 429s during devnet testing,
and it will do it in front of users.

## Verify against the live chain

Do not trust the local test suite alone. Point the hardening probe at mainnet
with a throwaway wallet holding a few cents of SOL:

```bash
DEPLOYER_KEYPAIR=<throwaway> node scripts/verify-hardening-devnet.mjs
```

It must print PASS for every line: creator self-deal rejected, stranger accept
rejected, mid-build cancel rejected, agent walk-away accepted, refund replay
rejected, vault closes to its rent reserve.

Then publish the hash so third parties can check the deployment without trusting
us, and record it in `README.md` and `docs/VERIFY.md`:

```bash
solana-verify get-program-hash -u mainnet-beta <PROGRAM_ID>
```

Mainnet is also where the reproducible build is worth doing properly, since the
explorer verification registry is mainnet-oriented. With Docker available:

```bash
solana-verify verify-from-repo -u mainnet-beta \
  --program-id <PROGRAM_ID> https://github.com/agnt-gg/gitstarter \
  --library-name gitstarter_escrow --mount-path program
```

## Launch posture

- **Cap early commissions.** Nothing in the program limits size. Keep the first
  ones small enough that a total loss is survivable.
- **Fund the first bounty yourself** and complete a full cycle — create, pledge,
  nominate, accept, release, verify payout — before inviting strangers.
- **Watch the treasury.** Fee arrivals are the cheapest live signal that
  releases are working.
- The pause switch is the only emergency lever, and it only stops *new*
  commissions and pledges. It cannot claw anything back. There is no other
  kill switch by design.

## Known limitations at launch

These are documented in `MECHANICS.md` and are deliberate for a first release,
not oversights:

- No on-chain arbitration. The deadline is the dispute mechanism.
- Account rent (~0.0035 SOL per commission, ~0.0014 per backer) is not
  reclaimable in this version.
- One deadline covers both funding and delivery, so a late-funded commission
  gives its agent less time.
- No independent professional audit. The program has been adversarially reviewed
  and tested, including live on-chain enforcement checks, but that is not the
  same thing as OtterSec or Neodyme signing off. Size the early commissions with
  that in mind.

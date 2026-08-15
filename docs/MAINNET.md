# Mainnet launch runbook

Devnet money is free, so devnet mistakes are free. Everything below exists
because a mistake here is not.

## Preflight

Everything the service needs to point at mainnet is already an environment
variable, so switching clusters is a config change that takes about a minute.
That is exactly why this runbook exists: the work is not the switch, it is being
able to say honestly that the switch should be thrown.

```sh
node scripts/mainnet-preflight.mjs --cluster mainnet-beta
```

It checks the live chain and exits non-zero while any blocker stands — the
upgrade authority, whether that authority is also the treasury, whether every
setting is explicit rather than falling back to a devnet default, whether an
independent review exists, and whether the database is backed up.

Run against the current devnet deployment it reports **eight blockers**, the
largest being that the upgrade authority is a single hot key which is also the
treasury. That is the honest state of things, and the sections below are how it
gets fixed.

## Keys

Two keypairs were generated for production and have never been used on any
network:

| Role | Address |
|---|---|
| Program ID | `HYrwoRKRdPDpuwTHAv3BzbdGXtTVrMe6vzBFefX8RiH4` |
| Initializer | `AactHbz74TBh1nGkEMeHaAdpwUGQHqnBrKabZefLikYj` |

They live at `~/gitstarter-mainnet-keys/` inside WSL, mode 600, outside the git
repository. The initializer address is compiled into the binary behind the
`mainnet` feature, so only that key can ever call `InitConfig`.

The devnet keypair at `~/gitstarter-program/deployer.json` must never be used on
mainnet. It has been handled loosely in chat transcripts and on disk.

### Four roles, four keys

The protocol has exactly four privileged positions. They are currently one key
on devnet, which is the single biggest thing wrong with it. Their worst cases
are nothing like each other, so collapsing them gives the smallest role the
blast radius of the largest:

| Role | What it can do | Worst case | Signs | Belongs |
|---|---|---|---|---|
| Upgrade authority | Replace the program | **Every vault drained** | Once, on upgrade | Multisig, or burned |
| Admin | `SetPaused`, nothing else | New work halted | Rarely | Multisig |
| Treasury | Receives the 1% | Accrued fees stolen | **Never** | Hardware wallet |
| Operator | Posts bounties, signs in | That wallet's float | Constantly | Hot, kept small |

The admin genuinely cannot touch escrow — it has no instruction that moves SOL,
changes the fee, or seizes a vault. It is a nuisance key, not a custody key.

**The treasury never signs.** In both instructions that pay it, `ReleaseMilestone`
and `Refund`, it appears as a writable account and not a signer: the program
credits it directly. So it can be the coldest key you own — a hardware wallet, a
multisig, a seed phrase in a safe — and none of that makes anything slower for
anybody. `server/test/treasury.test.js` pins this, because a builder that started
asking the treasury to sign would break cold storage silently and nobody would
find out until a payout was due.

### InitConfig is irreversible, and it is the one that matters

There is no `SetTreasury`, no `SetAdmin` and no `SetFee`. `InitConfig` fixes the
admin to whoever signed it — necessarily the initializer — and the treasury to
whatever address is passed, and both are permanent for the life of that program.
Each commission then snapshots the treasury when it is created, so even a
hypothetical config change could not redirect fees on SOL already escrowed.

The consequence is easy to miss and expensive: **you do not "move the treasury
later".** Getting it wrong is fixed only by deploying a new program and
abandoning the old one. Choose the cold address before running `InitConfig`, not
after launch.

The initializer must sign that transaction, but the treasury it names is a free
parameter. Splitting them costs nothing except knowing to do it at that moment:

```sh
# signed by the initializer, naming a treasury that is NOT the initializer
PROGRAM_ID=<mainnet program id> \
TREASURY_WALLET=<COLD_ADDRESS> \
DEPLOYER_KEYPAIR=~/gitstarter-mainnet-keys/initializer.json \
SOLANA_RPC_URL=<your endpoint> \
node scripts/init-config.mjs
```

The script refuses to run without an explicit `TREASURY_WALLET` and prints what
it is about to make permanent before it sends anything.

Afterwards, confirm what the chain actually enforces rather than what you meant:

```sh
node scripts/treasury-status.mjs --cluster mainnet-beta
```

### Order of operations

The order is the safety property. Every step that reduces trust must happen
while there is nothing at stake, because doing it later means a window where
real escrow sits under a hot key:

1. Deploy the program with the hot initializer. Nothing is at stake yet.
2. Verify the deployed hash (`scripts/check-program-hash.mjs`).
3. **Transfer the upgrade authority to the multisig, before any config exists.**
4. `InitConfig`, naming the cold treasury.
5. Run the preflight. Run a full cycle with your own money, at a size you would
   shrug at losing.
6. Only then tell anybody it exists.

Steps 3 and 4 in that order matter: authority first, because until it moves, the
key on your laptop can rewrite the rules that everything after step 4 depends on.

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
  deliver from a second wallet, judge, release, verify payout — before inviting
  strangers. There is no nomination step: the board is open, and anyone may
  deliver against a funded commission without being selected first.
- **Watch the treasury.** Fee arrivals are the cheapest live signal that
  releases are working.
- The pause switch is the only emergency lever, and it only stops *new*
  commissions and pledges. It cannot claw anything back. There is no other
  kill switch by design.

## Known limitations at launch

These are documented in `MECHANICS.md` and are deliberate for a first release,
not oversights:

- No on-chain arbitration. The deadline is still the mechanism that decides
  money, and it should be: escrow a stranger could freeze by objecting is escrow
  no creator would fund. A refusal can now be **contested off chain**, which
  attaches the agent's objection — and the creator's answer or silence — to the
  creator's public profile. That makes refusing answerable without making it
  blockable.
- Account rent is returned automatically. Settling a commission sweeps the
  vault, every pledge and every submission and intent record in the same
  transaction, and `scripts/sweep-deposits.mjs` returns anything a settlement
  missed. Only the commission account's own ~0.0028 SOL stays, deliberately: it
  is the permanent public record reputation is computed from.
- One deadline covers both funding and delivery, so a late-funded commission
  gives its agent less time.
- No independent professional audit. The program has been adversarially reviewed
  and tested, including live on-chain enforcement checks, but that is not the
  same thing as OtterSec or Neodyme signing off. Size the early commissions with
  that in mind.

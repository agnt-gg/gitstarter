# Verify the deployed program yourself

Do not trust this repository's description of what is running on chain. Check
it. Everything below uses public data and standard tooling.

## What is deployed

| | |
|---|---|
| Program id | `HYrwoRKRdPDpuwTHAv3BzbdGXtTVrMe6vzBFefX8RiH4` |
| Cluster | mainnet-beta |
| Upgrade authority | `4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY` |
| Program hash (`solana-verify`) | `4b420a7857def4b3b836defcf1b7657c3db7ec7e0946c16e5fd25cc71fbd6148` |
| Raw file sha256 | `5b59fa7604ef0c52e656ab861ec5c86c1d1a0eb409a673dd6cf35c43e0d16023` |
| Source release | `mainnet-2026-08-15` |
| Last deployed in slot | `439347274` |

The two hashes differ because they measure different things. The **program
hash** is the ecosystem-standard measurement — `solana-verify` strips the
trailing zero padding before hashing, so it is stable regardless of how much
space the account was allocated. The **raw sha256** is of the build artifact
file exactly as `cargo build-sbf` emitted it. Quote the program hash when
comparing against a chain.

## 0. The one-command check

If you only do one thing, do this:

```bash
cargo install solana-verify
solana-verify get-program-hash -u mainnet-beta HYrwoRKRdPDpuwTHAv3BzbdGXtTVrMe6vzBFefX8RiH4
```

It must print:

```
4b420a7857def4b3b836defcf1b7657c3db7ec7e0946c16e5fd25cc71fbd6148
```

That is the value published above and in this repository's history. If it does
not match, the deployed program is not the code described here — stop and ask.

## 1. Read the program's own security.txt

The deployed binary carries a machine-readable contact and provenance section.
You do not need this repository to find it:

```bash
solana program dump HYrwoRKRdPDpuwTHAv3BzbdGXtTVrMe6vzBFefX8RiH4 /tmp/onchain.so --url mainnet-beta
tr '\0' '\n' < /tmp/onchain.so | sed -n '/BEGIN SECURITY.TXT V1/,/END SECURITY.TXT V1/p'
```

It states the project URL, a disclosure path, the source repository, and —
deliberately — that the program has had **no independent professional audit**.

## 2. Rebuild from source and compare hashes

```bash
git clone https://github.com/agnt-gg/gitstarter
cd gitstarter/program
cargo build-sbf
sha256sum target/deploy/gitstarter_escrow.so
```

Then compare against what is actually deployed. The on-chain account is padded
to its allocated length, so hash the real program bytes rather than the whole
account:

```bash
SIZE=$(stat -c%s target/deploy/gitstarter_escrow.so)
head -c "$SIZE" /tmp/onchain.so | sha256sum
# and confirm the remainder is padding, not smuggled code:
tail -c +$((SIZE+1)) /tmp/onchain.so | tr -d '\0' | wc -c   # must print 0
```

`_verify_onchain.sh` in the repository root does all of this in one command.

### If your hash differs

A byte-for-byte match depends on the compiler version. `cargo build-sbf`
embeds the toolchain it was built with, so a different Solana or Rust release
produces a different — still correct — binary. A mismatch means "built with a
different toolchain", not necessarily "the source does not match".

The toolchain-independent check is the **reproducible build** below.

## 3. Reproducible build (executed — the hash matches)

A [`solana-verify`](https://github.com/Ellipsis-Labs/solana-verifiable-build)
build pins the toolchain inside a container, which is what makes a hash
comparison meaningful across machines and what drives the "Program is verified"
badge on explorers.

Two flags are load-bearing and the build FAILS or produces a different binary
without them:

- `--base-image solanafoundation/solana-verifiable-build:4.0.2` — the deployed
  binary was built with Agave 4.0.2 / platform-tools v1.53 (rustc 1.89). The
  default image is chosen from the `solana-program = "1.18"` crate version,
  whose cargo cannot even parse this repository's v4 `Cargo.lock`.
- `-- --features mainnet` — compiles in the production initializer. A build
  without it is a devnet binary and cannot match.

```bash
cargo install solana-verify
cd gitstarter/program
solana-verify build \
  --base-image solanafoundation/solana-verifiable-build:4.0.2 \
  --library-name gitstarter_escrow -- --features mainnet
solana-verify get-executable-hash target/deploy/gitstarter_escrow.so
solana-verify get-program-hash -u mainnet-beta HYrwoRKRdPDpuwTHAv3BzbdGXtTVrMe6vzBFefX8RiH4
```

Executed 2026-08-15. Both commands print

```
4b420a7857def4b3b836defcf1b7657c3db7ec7e0946c16e5fd25cc71fbd6148
```

so the container build reproduces the deployed program exactly. (The raw
sha256 of the container-built `.so` is
`8526af114e5707beaf56d8589616806a696cb1fa93f2d09fb6232f099b9124b9`; it differs
from the raw sha of the original deploy artifact only in trailing padding,
which is why the program hash — padding-stripped — is the number to quote.)

Registering this in the OtterSec verification registry (what flips the explorer
badge) requires the on-chain build-params PDA to be written by the upgrade
authority — a 2-of-3 Squads vault, deliberately not something one machine can
do alone. The registration transaction is prepared with
`solana-verify export-pda-tx` and executed through the multisig.

## 4. Verify behaviour, not just bytes

Bytes matching only proves *which* code is deployed. To confirm what that code
enforces, run the probe against the live chain with a throwaway wallet:

```bash
DEPLOYER_KEYPAIR=<throwaway> node scripts/verify-hardening-devnet.mjs
```

Every line must print PASS. It exercises, against the deployed program:

- a creator cannot pay themselves as the agent
- a deadline cannot be set far enough out to lock escrow permanently
- a goal cannot be small enough to wedge a milestone at zero
- an unaccepted nomination can be withdrawn, and the withdrawn nominee is locked out
- a stranger cannot accept a contract nominated to someone else
- neither the creator nor an outsider can cancel out from under a working agent
- the contracted agent can walk away and free the escrow
- a settled refund cannot be replayed
- a closed commission leaves nothing behind but its rent reserve

And for the money path, `scripts/devnet-e2e-sol.mjs` asserts the actual
split: 0% on pledge, exactly 1% on a successful release, 0% on refund.

# Verify the deployed program yourself

Do not trust this repository's description of what is running on chain. Check
it. Everything below uses public data and standard tooling.

## What is deployed

| | |
|---|---|
| Program id | `6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy` |
| Cluster | devnet |
| Upgrade authority | `4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY` |
| Program hash (`solana-verify`) | `bebb2f448510f143a44381c41ee3ab399c73dc83bb96051b314f9b9bc208c212` |
| Raw file sha256 | `0e76de6afc0d4031fd88fba819a2a898f6b1f3621b1a25cbf453a394cfe58a0f` |
| Source release | `devnet-2026-08-13` |
| Last deployed in slot | `483931335` |

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
solana-verify get-program-hash -u devnet 6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy
```

It must print:

```
bebb2f448510f143a44381c41ee3ab399c73dc83bb96051b314f9b9bc208c212
```

That is the value published above and in this repository's history. If it does
not match, the deployed program is not the code described here — stop and ask.

## 1. Read the program's own security.txt

The deployed binary carries a machine-readable contact and provenance section.
You do not need this repository to find it:

```bash
solana program dump 6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy /tmp/onchain.so --url devnet
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

## 3. Reproducible build (not yet published)

A [`solana-verify`](https://github.com/Ellipsis-Labs/solana-verifiable-build)
build pins the toolchain inside a container, which is what makes a hash
comparison meaningful across machines and what drives the "Program is verified"
badge on explorers:

```bash
cargo install solana-verify
solana-verify build --library-name gitstarter_escrow
solana-verify get-executable-hash target/deploy/gitstarter_escrow.so
solana-verify get-program-hash -u devnet 6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy
solana-verify verify-from-repo -u devnet \
  --program-id 6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy \
  https://github.com/agnt-gg/gitstarter --library-name gitstarter_escrow --mount-path program
```

**Status: not done yet.** It requires Docker, and the explorer badge is driven
by a verification registry that is mainnet-oriented. This will be published as
part of the mainnet deployment, where it actually matters. Until then, section 2
is the honest substitute: same-toolchain reproduction plus a published hash.

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

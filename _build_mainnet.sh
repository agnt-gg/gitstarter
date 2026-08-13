#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
SRC=/mnt/c/Users/Studio/AppData/Roaming/AGNT/projects/gitstarter/program
DST=$HOME/gitstarter-program
mkdir -p "$DST/src" "$DST/tests"
cp "$SRC/src/lib.rs" "$DST/src/lib.rs"
cp "$SRC/Cargo.toml" "$DST/Cargo.toml"
cp "$SRC/Cargo.lock" "$DST/Cargo.lock"
cp "$SRC/tests/"*.rs "$DST/tests/"
cd "$DST"

# An optimising build inlines the authority constant instead of storing it as a
# searchable literal, so the artifact cannot be checked with `strings`. The test
# compiles the same constant under the same feature flag and is authoritative.
echo "--- gate: which authority does this configuration trust? ---"
GATE=$(cargo test --lib --features mainnet initializer_matches_the_target_network 2>&1)
echo "$GATE" | tail -3
# "0 passed" means the gate silently did not run, which is indistinguishable from
# success in an exit code. Treat it as failure.
if ! echo "$GATE" | grep -qE 'test result: ok\. 1 passed'; then
  echo "FAIL: the authority gate did not run or did not pass"; exit 1
fi

cargo build-sbf --features mainnet
ART=target/deploy/gitstarter_escrow.so
echo "=== MAINNET ARTIFACT ==="
ls -l "$ART"
sha256sum "$ART"
echo "NOTE: this artifact is MAINNET. Rebuild without --features mainnet before touching devnet."

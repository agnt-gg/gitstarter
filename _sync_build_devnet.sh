#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
SRC=/mnt/c/Users/Studio/AppData/Roaming/AGNT/projects/gitstarter/program
DST=$HOME/gitstarter-program

mkdir -p "$DST/src" "$DST/tests"
cp "$SRC/src/lib.rs"   "$DST/src/lib.rs"
cp "$SRC/Cargo.toml"   "$DST/Cargo.toml"
cp "$SRC/Cargo.lock"   "$DST/Cargo.lock"
cp "$SRC/tests/integration_sol.rs" "$DST/tests/integration_sol.rs"
cp "$SRC/tests/adversarial.rs"     "$DST/tests/adversarial.rs"
rm -f "$DST/tests/integration.rs"

cd "$DST"
cargo build-sbf
echo "=== DEVNET ARTIFACT ==="
ls -l target/deploy/gitstarter_escrow.so
sha256sum target/deploy/gitstarter_escrow.so

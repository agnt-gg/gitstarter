#!/usr/bin/env bash
# Build the SBF artifact from a git worktree rather than the main checkout, so
# an unlanded branch can be deployed to devnet and verified before it is merged.
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
WT="${1:?usage: _sync_build_wt.sh <worktree-name> [--features mainnet]}"
shift || true
SRC="/mnt/c/Users/Studio/AppData/Roaming/AGNT/projects/gitstarter.wt/$WT/program"
DST="$HOME/gitstarter-program"
test -d "$SRC" || { echo "no such worktree: $SRC"; exit 1; }

mkdir -p "$DST/src" "$DST/tests"
cp "$SRC/src/lib.rs" "$DST/src/lib.rs"
cp "$SRC/Cargo.toml" "$DST/Cargo.toml"
cp "$SRC/Cargo.lock" "$DST/Cargo.lock" 2>/dev/null || true
cp "$SRC/tests/"*.rs "$DST/tests/" 2>/dev/null || true
cd "$DST"
cargo build-sbf "$@"
ART=target/deploy/gitstarter_escrow.so
echo "=== ARTIFACT ==="
ls -l "$ART"
sha256sum "$ART"
echo "--- embedded security.txt ---"
if grep -qa 'BEGIN SECURITY.TXT V1' "$ART"; then
  echo "PRESENT"
  strings "$ART" | sed -n '/BEGIN SECURITY.TXT V1/,/END SECURITY.TXT V1/p' | head -30
else
  echo "ABSENT"; exit 1
fi

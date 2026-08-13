#!/usr/bin/env bash
# Proves three things about the DEPLOYED program, using only public data:
#   1. the on-chain bytes equal the artifact built from this source tree
#   2. the trailing region is zero padding, not smuggled code
#   3. the security.txt the explorers will read says what we think it says
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
PROGRAM=${PROGRAM:-6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy}
CLUSTER=${CLUSTER:-devnet}
LOCAL=$HOME/gitstarter-program/target/deploy/gitstarter_escrow.so
DUMP=/tmp/gitstarter_onchain.so

solana program dump "$PROGRAM" "$DUMP" --url "$CLUSTER" >/dev/null
SIZE=$(stat -c%s "$LOCAL")
head -c "$SIZE" "$DUMP" > /tmp/onchain_trimmed.so

echo "program            $PROGRAM ($CLUSTER)"
echo "local sha256       $(sha256sum "$LOCAL" | cut -d' ' -f1)"
echo "on-chain sha256    $(sha256sum /tmp/onchain_trimmed.so | cut -d' ' -f1)"
cmp -s "$LOCAL" /tmp/onchain_trimmed.so \
  && echo "BYTES              MATCH" \
  || { echo "BYTES              MISMATCH"; exit 1; }
[ "$(tail -c +$((SIZE+1)) "$DUMP" | tr -d '\0' | wc -c)" = "0" ] \
  && echo "PADDING            all zeros" \
  || { echo "PADDING            non-zero trailing data"; exit 1; }

echo "--- security.txt as deployed ---"
# Fields are stored as null-terminated strings, so split on NUL to read them.
tr '\0' '\n' < "$DUMP" | sed -n '/BEGIN SECURITY.TXT V1/,/END SECURITY.TXT V1/p'

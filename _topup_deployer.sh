#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
DEPLOYER=4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY
for k in "$HOME"/.config/solana/id.json "$HOME"/.config/solana/agenc-worker-devnet.json "$HOME"/.config/solana/agenc-creator-devnet.json; do
  test -f "$k" || continue
  addr=$(solana address -k "$k" 2>/dev/null) || continue
  [ "$addr" = "$DEPLOYER" ] && continue
  bal=$(solana balance -k "$k" --url devnet 2>/dev/null | awk '{print $1}')
  echo "$k $addr $bal"
  # leave a little for fees, move the rest
  send=$(awk -v b="$bal" 'BEGIN{v=b-0.01; if(v>0.01) printf "%.6f", v; else print "0"}')
  if [ "$send" != "0" ]; then
    solana transfer "$DEPLOYER" "$send" --url devnet --keypair "$k" --allow-unfunded-recipient 2>&1 | tail -1
  fi
done
echo "DEPLOYER BALANCE:"
solana balance "$DEPLOYER" --url devnet

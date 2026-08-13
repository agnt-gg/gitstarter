#!/usr/bin/env bash
set -euo pipefail
cd /var/www/gitstarter.agnt.gg/app
cat > .env.runtime <<'ENVEOF'
PORT=3417
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_CLUSTER=devnet
PROGRAM_ID=6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy
TOKEN_MINT=HvdV1cjbBeQzKi4GUKVxXJcZY7TM6KUBG8unNDrDy3hz
TREASURY_WALLET=4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY
CONFIG_PDA=DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29
DATABASE_PATH=/var/www/gitstarter.agnt.gg/data/gitstarter.sqlite
ENVEOF
set -a
. ./.env.runtime
set +a
pm2 delete gitstarter-api >/dev/null 2>&1 || true
pm2 start server/server.js --name gitstarter-api --cwd /var/www/gitstarter.agnt.gg/app --update-env
pm2 save
sleep 2
curl -fsS http://127.0.0.1:3417/api/health
printf '\n'
curl -fsS http://127.0.0.1:3417/api/config
printf '\n'

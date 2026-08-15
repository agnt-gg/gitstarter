#!/usr/bin/env bash
set -euo pipefail
cd /var/www/gitstarter.agnt.gg/app
# This file REWRITES .env.runtime, so it is the real source of truth for what
# the service points at — editing .env.runtime by hand is undone the next time
# anybody runs this. It was still writing devnet values after the mainnet
# launch, which would have quietly reverted the whole thing on the next restart.
#
# The database is deliberately a NEW file. Devnet rows describe commissions that
# do not exist on mainnet, and more importantly the delivery history would show
# reputation earned with play money as though it were real — which is a lie
# about somebody's track record, on the one board built to make those
# trustworthy. The devnet database is left in place, not deleted.
cat > .env.runtime <<'ENVEOF'
PORT=3417
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
# What BROWSERS are handed. Different from the server's endpoint on purpose:
# api.mainnet-beta 403s any request with an Origin header, i.e. every browser.
PUBLIC_SOLANA_RPC_URL=https://solana-rpc.publicnode.com
SOLANA_CLUSTER=mainnet-beta
PROGRAM_ID=HYrwoRKRdPDpuwTHAv3BzbdGXtTVrMe6vzBFefX8RiH4
TREASURY_WALLET=6RehrefK9bq2U8dJse96GjGGHm8t6mznxGR1Qj2e1A5P
CONFIG_PDA=E7tHZCvZWB6fQLwZA6KCipgJszjPn4ZTzSUdZC1XX4x2
MULTISIG_ADDRESS=44zhDZj5rGez4EEqkzUqGnoPvvJ6weMyRnz2A8s8qPfN
DATABASE_PATH=/var/www/gitstarter.agnt.gg/data/gitstarter-mainnet.sqlite
DB_BACKUP_PATH=/var/backups/gitstarter
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

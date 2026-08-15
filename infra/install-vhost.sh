#!/usr/bin/env bash
# Swaps the gitstarter vhost, and puts the old one back if nginx refuses it.
#
# nginx validates the WHOLE config, so a mistake here would also refuse to
# reload agnt.gg / api / alpha / app. Testing before reloading, and restoring on
# failure, means the worst case is that nothing changes.
set -uo pipefail

ENABLED=/etc/nginx/sites-enabled
STAGE=/root/gitstarter.conf.new
BACKUP=/root/vhost-rollback-$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP"
cp -a "$ENABLED"/gitstarter* "$BACKUP"/ 2>/dev/null
echo "rollback copy: $BACKUP"

rm -f "$ENABLED/gitstarter.agnt.gg" "$ENABLED/gitstarter.xyz-acme"
cp "$STAGE" "$ENABLED/gitstarter"

if nginx -t 2>&1 | tail -2; then
  systemctl reload nginx && echo "RELOADED"
else
  echo "!! nginx rejected the config — restoring the previous vhost"
  rm -f "$ENABLED/gitstarter"
  cp -a "$BACKUP"/gitstarter* "$ENABLED"/ 2>/dev/null
  nginx -t && systemctl reload nginx
  echo "ROLLED BACK — nothing changed"
  exit 1
fi

echo "--- server names now served ---"
nginx -T 2>/dev/null | grep -E '^\s*server_name' | sort -u

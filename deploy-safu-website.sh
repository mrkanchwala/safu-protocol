#!/usr/bin/env bash
# deploy-safu-website.sh — Deploy SAFU website to safustaking.com (VPS 46.225.110.140)
# Source: SAFU3.0/website/ → /var/www/safustaking/
# Usage: bash deploy-safu-website.sh

set -euo pipefail

VPS="murtaza@46.225.110.140"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_DIR="$SCRIPT_DIR/website/"
REMOTE_DIR="/var/www/safustaking/"
DOMAIN="safustaking.com"

echo "==> [safu-website] Syncing website/ → VPS $REMOTE_DIR"
rsync -avz \
  --exclude='.DS_Store' \
  "$LOCAL_DIR" "$VPS:$REMOTE_DIR" > /tmp/deploy-safu-website.log 2>&1
echo "    rsync: ok ($(wc -l < /tmp/deploy-safu-website.log) files transferred)"

echo "==> [safu-website] Reloading nginx..."
ssh "$VPS" "sudo nginx -t && sudo systemctl reload nginx"
echo "    nginx: reloaded"

echo "==> [safu-website] Smoke test..."
CODE=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/" 2>/dev/null || echo "000")
if [ "$CODE" = "200" ]; then
  echo "    https://$DOMAIN/ → 200 OK"
else
  echo "    WARNING: https://$DOMAIN/ → $CODE"
fi

echo "==> [safu-website] Deploy complete."

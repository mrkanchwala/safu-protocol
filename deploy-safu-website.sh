#!/usr/bin/env bash
# deploy-safu-website.sh — Deploy SAFU website to safustaking.com
# Source: SAFU3.0/website/ → /var/www/safustaking/
# Usage: bash deploy-safu-website.sh
#
# Requires SSH config alias — add to ~/.ssh/config (not committed):
#   Host safu-vps
#       HostName <vps-ip>
#       User murtaza
#       IdentityFile ~/.ssh/id_ed25519
# Or: export SAFU_VPS=user@host to override at runtime.

set -euo pipefail

VPS="${SAFU_VPS:-safu-vps}"
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

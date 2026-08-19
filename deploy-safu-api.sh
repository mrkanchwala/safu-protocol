#!/usr/bin/env bash
# deploy-safu-api.sh — Deploy SAFU backend API to VPS
# Source of truth: SAFU3.0/api/ (local) → /home/murtaza/safu-verify/api/ (VPS)
# Usage: bash deploy-safu-api.sh
#
# Requires SSH config alias:
#   Host safu-vps
#       HostName 46.225.110.140
#       User murtaza
#       IdentityFile ~/.ssh/id_ed25519

set -euo pipefail

VPS="${SAFU_VPS:-safu-vps}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Ensure FALLBACK_RPC_URL exists in VPS .env (set manually if missing)
if ! ssh "$VPS" "grep -q 'FALLBACK_RPC_URL' ~/safu-verify/.env 2>/dev/null"; then
  echo "    WARNING: FALLBACK_RPC_URL not set in VPS .env — add manually:"
  echo "    ssh $VPS \"echo 'FALLBACK_RPC_URL=<your-2nd-alchemy-url>' >> ~/safu-verify/.env\""
fi

echo "==> [safu-api] Syncing api/ → VPS ~/safu-verify/api/"
rsync -avz --exclude='__pycache__' --exclude='*.pyc' \
  "$SCRIPT_DIR/api/" "$VPS:/home/murtaza/safu-verify/api/" > /tmp/deploy-safu-api.log 2>&1
echo "    rsync api/: ok ($(wc -l < /tmp/deploy-safu-api.log) files transferred)"

echo "==> [safu-api] Syncing safu/ → VPS ~/safu-verify/safu/"
rsync -avz --exclude='__pycache__' --exclude='*.pyc' \
  "$SCRIPT_DIR/safu/" "$VPS:/home/murtaza/safu-verify/safu/" >> /tmp/deploy-safu-api.log 2>&1
echo "    rsync safu/: ok"

echo "==> [safu-api] Restarting safu-verify service..."
ssh "$VPS" "sudo systemctl restart safu-verify"
sleep 2

echo "==> [safu-api] Health check..."
CODE=$(ssh "$VPS" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8006/v1/health" 2>/dev/null || echo "000")
if [ "$CODE" = "200" ]; then
  echo "    /health → 200 OK"
else
  echo "    WARNING: /health → $CODE — check: ssh safu-vps 'journalctl -u safu-verify -n 30'"
  exit 1
fi

echo "==> [safu-api] Deploy complete."

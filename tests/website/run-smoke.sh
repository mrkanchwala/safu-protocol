#!/usr/bin/env bash
# Browser smoke gate — starts a static server on website/, runs the Playwright
# check against it, tears the server down. Step 10.0 of the T2 D3 sub-plan.
#
# Kept SEPARATE from run-all.sh on purpose: that script's contract is "zero
# dependencies — plain node", and website/ has no package.json by design. Pulling
# Playwright into it would break both. This one carries the dependency alone.
#
# Playwright is resolved WITHOUT installing anything into this repo:
#   1. the npx cache, if a version is already there (the normal case here)
#   2. otherwise a one-time install into ~/.safu-smoke-deps
# The chromium binary comes from ~/Library/Caches/ms-playwright either way.
set -uo pipefail
cd "$(dirname "$0")/../.."

PORT="${SMOKE_PORT:-8899}"
BASE="http://127.0.0.1:${PORT}"

# ── resolve playwright ──────────────────────────────────────────────────────
PW_ROOT=""
for d in "$HOME"/.npm/_npx/*/node_modules; do
  if [ -d "$d/playwright" ]; then PW_ROOT="$d"; break; fi
done
if [ -z "$PW_ROOT" ] && [ -d "$HOME/.safu-smoke-deps/node_modules/playwright" ]; then
  PW_ROOT="$HOME/.safu-smoke-deps/node_modules"
fi
if [ -z "$PW_ROOT" ]; then
  echo "playwright not found — installing once into ~/.safu-smoke-deps (not this repo)"
  npm install --silent --prefix "$HOME/.safu-smoke-deps" playwright@1.62.1 || exit 2
  npx --prefix "$HOME/.safu-smoke-deps" playwright install chromium || exit 2
  PW_ROOT="$HOME/.safu-smoke-deps/node_modules"
fi
echo "playwright: $PW_ROOT/playwright"

# ── serve website/ ──────────────────────────────────────────────────────────
if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  echo "port $PORT already in use — set SMOKE_PORT to something else"
  exit 2
fi

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory website >/tmp/safu-smoke-server.log 2>&1 &
SERVER_PID=$!
# Always reap the server, including on a failed assertion or a Ctrl-C.
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT INT TERM

for _ in $(seq 1 40); do
  curl -sf -o /dev/null "$BASE/index.html" && break
  sleep 0.25
done
if ! curl -sf -o /dev/null "$BASE/index.html"; then
  echo "static server never came up — see /tmp/safu-smoke-server.log"
  exit 2
fi
echo "serving website/ at $BASE"

# ── run ─────────────────────────────────────────────────────────────────────
PW_MODULE="$PW_ROOT/playwright/index.js" SMOKE_BASE="$BASE" node tests/website/smoke.playwright.mjs
STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  echo ""
  echo "SMOKE GATE PASSED"
else
  echo ""
  echo "SMOKE GATE FAILED (exit $STATUS)"
fi
exit "$STATUS"

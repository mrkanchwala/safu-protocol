#!/usr/bin/env bash
# Runs every website JS test. Zero dependencies — plain node.
# website/ has no package.json and no build step by design; adding one to get a
# test runner would be a real architecture change.
set -uo pipefail
cd "$(dirname "$0")/../.."
fail=0
for f in tests/website/*.test.mjs; do
  node "$f" || fail=1
done
if [ "$fail" -ne 0 ]; then
  echo ""
  echo "WEBSITE TESTS FAILED"
  exit 1
fi
echo ""
echo "all website tests passed"

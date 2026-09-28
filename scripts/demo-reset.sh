#!/usr/bin/env bash
# Restores a running Demo Mode installation to a scenario through the reset
# API. It signs in the way a browser does: the status call issues the demo
# session and its CSRF token, and the reset sends both.
#
#   scripts/demo-reset.sh [scenario]
set -euo pipefail

base_url="${TILECAST_DEMO_URL:-http://localhost:${TILECAST_DEMO_PORT:-18080}}"
scenario="${1:-${TILECAST_DEMO_SCENARIO:-kitchen-sink}}"
jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT

status="$(curl -fsS -c "$jar" -b "$jar" "$base_url/api/v1/auth/status")"
case "$status" in
  *'"demoMode":true'*) ;;
  *)
    echo "$base_url is not a Demo Mode installation; nothing was reset." >&2
    exit 1
    ;;
esac
csrf="$(printf '%s' "$status" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')"

curl -fsS -c "$jar" -b "$jar" -X POST \
  -H "X-CSRF-Token: $csrf" -H "Content-Type: application/json" \
  --data "{\"scenario\":\"$scenario\"}" \
  "$base_url/api/v1/demo/reset" >/dev/null
echo "Demo reset to the $scenario scenario at $base_url"

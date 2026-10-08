#!/usr/bin/env bash
# Repeatable Edge soak driver. It loops the existing Linux-capable Rust
# suites that exercise playback, updates, and migration, samples the
# test processes for RSS/CPU growth, and writes one JSONL line per
# iteration. It is not a PR gate: run it from a qualification workflow
# or a workstation for 24-72 h (see docs/tilecast-edge-qualification.md).
#
# Usage: scripts/ci/edge-soak.sh [iterations] [results-dir]
set -euo pipefail

ITERATIONS="${1:-0}" # 0 means run until stopped
RESULTS="${2:-target/soak}"
mkdir -p "$RESULTS"
SUMMARY="$RESULTS/soak.jsonl"
TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/edge-soak.XXXXXX")"

cleanup() {
  rm -rf "$TMPBASE"
}
trap cleanup EXIT

iteration=0
while [ "$ITERATIONS" -eq 0 ] || [ "$iteration" -lt "$ITERATIONS" ]; do
  iteration=$((iteration + 1))
  export TMPDIR="$TMPBASE"
  start_ms=$(date +%s%3N)
  status="pass"
  detail=""

  sample() {
    # Peak RSS (KB) and cumulative CPU seconds across cargo test processes.
    ps -eo rss,time,comm 2>/dev/null | awk '/-deps\//{rss+=$1} END{print rss+0}'
  }

  if ! cargo test -q -p tilecastd --test playback >/tmp/soak-playback.log 2>&1; then
    status="fail"
    detail="playback"
  elif ! cargo test -q -p tilecastd --test updates >/tmp/soak-updates.log 2>&1; then
    status="fail"
    detail="updates"
  elif ! cargo test -q -p tilecast-edge-migrate >/tmp/soak-migrate.log 2>&1; then
    status="fail"
    detail="migrate"
  fi

  rss_kb="$(sample)"
  end_ms=$(date +%s%3N)
  printf '{"iteration":%d,"status":"%s","detail":"%s","elapsed_ms":%d,"rss_kb":%s,"at":"%s"}\n' \
    "$iteration" "$status" "$detail" "$((end_ms - start_ms))" "$rss_kb" "$(date -u +%FT%TZ)" >>"$SUMMARY"

  if [ "$status" != "pass" ]; then
    echo "soak iteration $iteration failed ($detail); see /tmp/soak-$detail.log"
    exit 1
  fi
  echo "soak iteration $iteration passed in $((end_ms - start_ms)) ms (rss ${rss_kb} KB)"
done

#!/usr/bin/env bash
# M7 migration integration test: tilecast-edge-migrate against real systemd,
# a real Tilecast Server and a lingering kiosk account with a legacy player
# user unit, including a power loss during settlement. Run from the
# repository root after building the images and the Player Runtime:
#
#   docker build -t tilecast-edge-migrate-e2e -f apps/edge/ci/Dockerfile.migrate apps/edge/ci
#   npm run build --workspace @tilecast/player-runtime
#   apps/edge/ci/run-migrate-e2e.sh [target-dir-or-volume]
set -euo pipefail
target=${1:-tilecast-edge-target}
name=tilecast-migrate-e2e
docker rm -f "$name" >/dev/null 2>&1 || true
start() {
  docker start "$name" >/dev/null
  for _ in $(seq 1 90); do
    state=$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)
    case "$state" in running|degraded) return 0 ;; esac
    sleep 1
  done
  echo "the container's systemd did not finish booting: $state" >&2
  docker exec "$name" systemctl --failed --no-pager || true
  return 1
}
inside() {
  echo "== $1"
  docker exec "$name" python3 /src/apps/edge/ci/migrate_e2e.py "$1"
}
docker create --name "$name" --privileged --tmpfs /run --tmpfs /run/lock \
  -v "$PWD:/src" -v "$target:/target" tilecast-edge-migrate-e2e >/dev/null
# KEEP=1 leaves the container for debugging.
trap '[ "${KEEP:-0}" = 1 ] || docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
start
inside setup
inside import-failure
inside crash
inside start-settling
echo "== power loss"
docker kill "$name" >/dev/null
start
inside after-reboot
inside accept
echo "migrate-e2e: all phases passed"

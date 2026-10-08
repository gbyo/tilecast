#!/usr/bin/env bash
# M7 migration and M10 update integration test: tilecast-edge-migrate and
# tilecast-edge-update against real systemd, a real Tilecast Server and a
# lingering kiosk account with a legacy player user unit, including a power
# loss during settlement and a power loss while an update is provisional. Run from the
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
  docker exec "$name" systemctl list-jobs --no-pager || true
  docker exec "$name" journalctl -b -u tilecast-edge-update-guard.service --no-pager -n 80 || true
  docker exec "$name" journalctl -b -u tilecast-edge.service --no-pager -n 30 || true
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
# WebKit's bubblewrap sandbox mounts /proc in a user namespace. Ubuntu 24.04
# hosts (GitHub runners, Colima) restrict that for unconfined programs, which
# the privileged container shares with its host. A kernel without the
# setting needs nothing.
docker exec "$name" sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null 2>&1 || true
inside preflight
inside setup
inside import-failure
inside crash
inside start-settling
echo "== power loss"
docker kill "$name" >/dev/null
start
inside after-reboot
inside accept
echo "== power loss after acceptance"
docker kill "$name" >/dev/null
start
inside accepted-reboot
# M10: updates of the accepted Edge through the real helper (update_e2e.py).
update() {
  echo "== $1"
  docker exec "$name" python3 /src/apps/edge/ci/update_e2e.py "$1"
}
update update-releases
update update-field-rollback
update update-success
update update-provisional
echo "== power loss while provisional"
docker kill "$name" >/dev/null
start
update update-after-reboot
update update-broken
echo "migrate-e2e: all phases passed"

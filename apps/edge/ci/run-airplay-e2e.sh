#!/usr/bin/env bash
# AirPlay supervisor integration test (docs/tilecast-edge-airplay.md §12,
# Stage 2): tilecast-airplay and a fake UxPlay under the real
# tilecast-airplay.socket and tilecast-airplay.service, with systemd as
# PID 1. It checks that the renderer's control group is refused, that no
# UxPlay process outlives a SIGKILL of the supervisor, and that the PIN and
# the device ID are in no process argument and no log. Run from the
# repository root after building the image:
#
#   docker build -t tilecast-edge-migrate-e2e -f apps/edge/ci/Dockerfile.migrate apps/edge/ci
#   apps/edge/ci/run-airplay-e2e.sh [target-dir-or-volume]
set -euo pipefail
target=${1:-tilecast-edge-target}
name=tilecast-airplay-e2e
docker rm -f "$name" >/dev/null 2>&1 || true
docker create --name "$name" --privileged --tmpfs /run --tmpfs /run/lock \
  -v "$PWD:/src" -v "$target:/target" tilecast-edge-migrate-e2e >/dev/null
# KEEP=1 leaves the container for debugging.
trap '[ "${KEEP:-0}" = 1 ] || docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker start "$name" >/dev/null
for _ in $(seq 1 90); do
  state=$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)
  case "$state" in running|degraded) break ;; esac
  sleep 1
done
docker exec "$name" python3 /src/apps/edge/ci/airplay_e2e.py

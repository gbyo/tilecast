#!/usr/bin/env bash
# AirPlay supervisor integration test (docs/tilecast-edge-airplay.md §12,
# Stage 2): tilecast-airplay and a fake UxPlay under the real
# tilecast-airplay.socket and tilecast-airplay.service, with systemd as
# PID 1. It checks that the renderer's control group is refused, that no
# UxPlay process outlives a SIGKILL of the supervisor, and that the PIN and
# the device ID are in no process argument and no log. Then (Stage 5) it runs
# the headless `airplay` scenario: a real tilecastd in tilecast-edge.service,
# the real supervisor, the renderer with WebKit's sandbox on, and synthetic
# RTP. Run from the repository root after building the image and the Player
# Runtime (npm run build --workspace @tilecast/player-runtime):
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
docker exec -e "E2E_DISABLE_WEBKIT_SANDBOX=${E2E_DISABLE_WEBKIT_SANDBOX:-}" "$name" bash -c '
set -euo pipefail
export CARGO_TARGET_DIR=/target/cargo CARGO_HOME=/target/cargo-home PATH=/opt/cargo/bin:$PATH
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0
cd /src/apps/edge
cargo build -q --locked -p tilecastd -p tilecastctl
cmake -S renderer-wpe -B /target/renderer-airplay -G Ninja -DTILECAST_ALLOW_UNSANDBOXED_WEBKIT=ON >/dev/null
cmake --build /target/renderer-airplay >/dev/null
renderer-wpe/assemble-runtime.sh /target/runtime-airplay >/dev/null
python3 renderer-wpe/tests/e2e_headless.py --scenario airplay --bin-dir /target/cargo/debug \
  --renderer /target/renderer-airplay/tilecast-renderer-wpe --runtime-dir /target/runtime-airplay \
  --gst-plugin-dir /target/renderer-airplay/gstreamer-1.0
'

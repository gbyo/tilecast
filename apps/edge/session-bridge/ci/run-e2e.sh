#!/usr/bin/env bash
# Builds tilecast-session-bridge, runs its unit tests, then runs it against a
# real PipeWire and WirePlumber (tests/e2e_pipewire.py). Run inside the
# tilecast-edge-dev image with the repository mounted at /src:
#
#   docker run --rm -v "$PWD:/src" -v tilecast-edge-target:/target \
#     tilecast-edge-dev /src/apps/edge/session-bridge/ci/run-e2e.sh
set -euo pipefail
ulimit -c 0
cd /src/apps/edge
cmake -S session-bridge -B /target/bridge -G Ninja >/dev/null
cmake --build /target/bridge
ctest --test-dir /target/bridge --output-on-failure
python3 session-bridge/tests/e2e_pipewire.py --bridge /target/bridge/tilecast-session-bridge

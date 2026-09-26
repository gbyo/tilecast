#!/usr/bin/env bash
# Runs the Player Runtime conformance fixtures under WPE WebKit headless.
# Run in the tilecast-edge-dev image with the repository at /src and a
# results directory mounted at /results; build packages/player-runtime first
# (npm run build --workspace @tilecast/player-runtime):
#
#   docker run --rm -v "$PWD:/src" -v "$RESULTS:/results" \
#     -v tilecast-edge-target:/target tilecast-edge-dev \
#     /src/apps/edge/renderer-wpe/ci/run-conformance.sh [fixture,...]
set -euo pipefail
ulimit -c 0
cd /src/apps/edge
cmake -S renderer-wpe -B /target/renderer -G Ninja >/dev/null
cmake --build /target/renderer --target tilecast-runtime-conformance gsttcmedia
pkg-config --modversion wpe-webkit-2.0 wpe-platform-2.0 gstreamer-1.0 >/results/wpe-engine-versions.txt
args=(--engine wpe --out /results --wpe-runner /target/renderer/tilecast-runtime-conformance
  --gst-plugin-dir /target/renderer/gstreamer-1.0)
if [[ -n "${1:-}" ]]; then args+=(--only "$1"); fi
node /src/packages/player-runtime/conformance/run.mjs "${args[@]}"

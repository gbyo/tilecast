#!/usr/bin/env bash
# Builds tilecastd, tilecastctl and tilecast-renderer-wpe for Linux and runs
# the headless end-to-end scenarios. Run inside the tilecast-edge-dev image
# with the repository mounted at /src:
#
#   docker run --rm -v "$PWD:/src" -v tilecast-edge-target:/target \
#     tilecast-edge-dev /src/apps/edge/renderer-wpe/ci/run-e2e.sh [scenario]
set -euo pipefail
scenario=${1:-all}
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/target/cargo}
export CARGO_HOME=${CARGO_HOME_CACHE:-/target/cargo-home}
mkdir -p "$CARGO_HOME"
ln -sf /opt/cargo/bin "$CARGO_HOME/bin" 2>/dev/null || true
cd /src/apps/edge
cargo build --locked -p tilecastd -p tilecastctl
cmake -S renderer-wpe -B /target/renderer -G Ninja >/dev/null
cmake --build /target/renderer
ctest --test-dir /target/renderer --output-on-failure
runtime=/target/runtime
renderer-wpe/assemble-runtime.sh "$runtime"
python3 renderer-wpe/tests/e2e_headless.py \
  --bin-dir "$CARGO_TARGET_DIR/debug" \
  --renderer /target/renderer/tilecast-renderer-wpe \
  --runtime-dir "$runtime" \
  --gst-plugin-dir /target/renderer/gstreamer-1.0 \
  --scenario "$scenario"

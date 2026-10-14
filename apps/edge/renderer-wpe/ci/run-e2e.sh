#!/usr/bin/env bash
# Builds tilecastd, tilecastctl and both WPE renderers for Linux and runs
# the headless end-to-end scenarios. Run inside the tilecast-edge-dev image
# with the repository mounted at /src:
#
#   docker run --rm -v "$PWD:/src" -v tilecast-edge-target:/target \
#     tilecast-edge-dev /src/apps/edge/renderer-wpe/ci/run-e2e.sh [scenario]
set -euo pipefail
ulimit -c 0
scenario=${1:-all}
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/target/cargo}
export CARGO_HOME=${CARGO_HOME_CACHE:-/target/cargo-home}
mkdir -p "$CARGO_HOME"
ln -sf /opt/cargo/bin "$CARGO_HOME/bin" 2>/dev/null || true
cd /src/apps/edge
cargo build --locked -p tilecastd -p tilecastctl
if [[ "$scenario" == external-plugin-production ]]; then
  # The release configuration: no sandbox opt-out is compiled in, so the
  # renderer clears WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS (the test harness
  # still sets it) and WebKit's bubblewrap sandbox stays on. The container
  # must allow bubblewrap to create user namespaces (docker run --privileged).
  cmake -S renderer-wpe -B /target/renderer-prod -G Ninja >/dev/null
  cmake --build /target/renderer-prod
  grep -q '^TILECAST_ALLOW_UNSANDBOXED_WEBKIT:BOOL=OFF$' /target/renderer-prod/CMakeCache.txt
  # The binary carries the guard that clears the opt-out, and the sandbox
  # waits that only an unsandboxed build skips.
  grep -q "ignoring WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS" /target/renderer-prod/tilecast-renderer-wpe
  if [[ -f /target/renderer/tilecast-renderer-wpe ]] &&
    grep -q "ignoring WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS" /target/renderer/tilecast-renderer-wpe; then
    echo "the development renderer unexpectedly carries the release guard" >&2
    exit 1
  fi
  ctest --test-dir /target/renderer-prod --output-on-failure
  # Real-engine frame navigation with WebKit's sandbox on and its negative control.
  /target/renderer-prod/test-frame-navigation
  if /target/renderer-prod/test-frame-navigation --without-filter; then
    echo "frame navigation negative control unexpectedly passed" >&2
    exit 1
  fi
  runtime=/target/runtime
  renderer-wpe/assemble-runtime.sh "$runtime"
  python3 renderer-wpe/tests/e2e_external_plugins.py \
    --bin-dir "$CARGO_TARGET_DIR/debug" \
    --renderer /target/renderer-prod/tilecast-renderer-wpe \
    --runtime-dir "$runtime" \
    --gst-plugin-dir /target/renderer-prod/gstreamer-1.0
  exit 0
fi
cmake -S renderer-wpe -B /target/renderer -G Ninja -DTILECAST_ALLOW_UNSANDBOXED_WEBKIT=ON >/dev/null
cmake --build /target/renderer
ctest --test-dir /target/renderer --output-on-failure
WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 /target/renderer/test-frame-navigation
if WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 /target/renderer/test-frame-navigation --without-filter; then
  echo "frame navigation negative control unexpectedly passed" >&2
  exit 1
fi
cmake -S web-renderer-wpe -B /target/web-renderer -G Ninja -DTILECAST_ALLOW_UNSANDBOXED_WEBKIT=ON >/dev/null
cmake --build /target/web-renderer
ctest --test-dir /target/web-renderer --output-on-failure
WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 \
  python3 web-renderer-wpe/tests/security_test.py --helper /target/web-renderer/tilecast-web-renderer-wpe
cmake -S session-bridge -B /target/bridge -G Ninja >/dev/null
cmake --build /target/bridge
ctest --test-dir /target/bridge --output-on-failure
runtime=/target/runtime
renderer-wpe/assemble-runtime.sh "$runtime"
if [[ "$scenario" != external-plugin ]]; then
python3 renderer-wpe/tests/e2e_headless.py \
  --bin-dir "$CARGO_TARGET_DIR/debug" \
  --renderer /target/renderer/tilecast-renderer-wpe \
  --runtime-dir "$runtime" \
  --gst-plugin-dir /target/renderer/gstreamer-1.0 \
  --web-helper /target/web-renderer/tilecast-web-renderer-wpe \
  --scenario "$scenario"
fi
if [[ "$scenario" == all || "$scenario" == external-plugin ]]; then
  WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 \
    python3 renderer-wpe/tests/e2e_external_plugins.py \
      --bin-dir "$CARGO_TARGET_DIR/debug" \
      --renderer /target/renderer/tilecast-renderer-wpe \
      --runtime-dir "$runtime" \
      --gst-plugin-dir /target/renderer/gstreamer-1.0
fi

#!/usr/bin/env bash
# Runs the Rust workspace checks on Linux (the Edge target platform). Run in
# the tilecast-edge-dev image with the repository mounted at /src:
#
#   docker run --rm -v "$PWD:/src" -v tilecast-edge-target:/target \
#     tilecast-edge-dev /src/apps/edge/ci/test-linux.sh
set -euo pipefail
ulimit -c 0
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/target/cargo}
export CARGO_HOME=${CARGO_HOME_CACHE:-/target/cargo-home}
# Debug info is not needed for a check run and triples the target size.
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0
mkdir -p "$CARGO_HOME"
ln -sf /opt/cargo/bin "$CARGO_HOME/bin" 2>/dev/null || true
cd /src/apps/edge
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace

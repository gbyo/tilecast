#!/usr/bin/env bash
# Runs ci/e2e_server.py with a real Tilecast Server, PostgreSQL, tilecastd
# and tilecast-renderer-wpe together. Run in the tilecast-edge-e2e image
# (ci/Dockerfile.e2e) with the repository mounted at /src; build
# packages/player-runtime first (renderer-wpe/assemble-runtime.sh uses it):
#
#   docker run --rm -v "$PWD:/src" -v tilecast-edge-target:/target \
#     tilecast-edge-e2e /src/apps/edge/ci/run-e2e-server.sh
set -euo pipefail
ulimit -c 0
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/target/cargo}
export CARGO_HOME=${CARGO_HOME_CACHE:-/target/cargo-home}
mkdir -p "$CARGO_HOME"
ln -sf /opt/cargo/bin "$CARGO_HOME/bin" 2>/dev/null || true

# A throwaway cluster that trusts local connections from this container.
cluster=$(ls /etc/postgresql)
hba=/etc/postgresql/$cluster/main/pg_hba.conf
sed -i -E 's/(scram-sha-256|md5|peer)$/trust/' "$hba"
pg_ctlcluster "$cluster" main start
sudo -u postgres createuser --superuser "$(id -un)" 2>/dev/null || true

cd /src/apps/edge
cmake -S renderer-wpe -B /target/renderer -G Ninja >/dev/null
cmake --build /target/renderer
runtime=/target/runtime
renderer-wpe/assemble-runtime.sh "$runtime"
cd /src
python3 apps/edge/ci/e2e_server.py \
  --renderer /target/renderer/tilecast-renderer-wpe \
  --runtime-dir "$runtime" \
  --gst-plugin-dir /target/renderer/gstreamer-1.0

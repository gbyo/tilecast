#!/usr/bin/env bash
# Runs ci/activity_parity_e2e.py: the Electron Linux Player and Tilecast Edge
# side by side against one real Tilecast Server (the M8 exit criterion). Run
# in the tilecast-edge-parity image with the repository at /src, after
# building the Player Runtime and the Linux player:
#
#   npm run build --workspace @gibsonmb71/tilecast-player-linux
#   docker run --rm -v "$PWD:/src" -v tilecast-edge-target:/target \
#     tilecast-edge-parity /src/apps/edge/ci/run-activity-parity.sh
set -euo pipefail
ulimit -c 0
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/target/cargo}
export CARGO_HOME=${CARGO_HOME_CACHE:-/target/cargo-home}
mkdir -p "$CARGO_HOME"
ln -sf /opt/cargo/bin "$CARGO_HOME/bin" 2>/dev/null || true
cluster=$(ls /etc/postgresql)
sed -i -E 's/(scram-sha-256|md5|peer)$/trust/' "/etc/postgresql/$cluster/main/pg_hba.conf"
pg_ctlcluster "$cluster" main start
sudo -u postgres createuser --superuser "$(id -un)" 2>/dev/null || true
cd /src/apps/edge
cmake -S renderer-wpe -B /target/renderer -G Ninja >/dev/null
cmake --build /target/renderer
renderer-wpe/assemble-runtime.sh /target/runtime
cd /src
python3 apps/edge/ci/activity_parity_e2e.py

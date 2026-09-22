#!/usr/bin/env bash
# Assembles the trusted web runtime served at tilecast://runtime/ into DEST.
#
# The DOM runtime is the reference Linux player's renderer, used unmodified
# (docs/tilecast-edge.md Amendment A1): static/ and the compiled
# dist/renderer/*.js, plus this renderer's bridge script. Build
# apps/player-linux first (npm run build --workspace
# @gibsonmb71/tilecast-player-linux).
set -euo pipefail
dest=${1:?usage: assemble-runtime.sh DEST}
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
player=$(cd -- "$here/../../player-linux" && pwd)
if [[ ! -f "$player/dist/renderer/renderer.js" ]]; then
  echo "assemble-runtime: $player/dist/renderer/renderer.js is missing; build apps/player-linux first" >&2
  exit 1
fi
rm -rf "$dest"
mkdir -p "$dest/static" "$dest/dist/renderer"
cp "$player/static/index.html" "$player/static/tilecast-logo-white.svg" "$dest/static/"
find "$player/dist/renderer" -maxdepth 1 -name '*.js' ! -name '*.test.js' -exec cp {} "$dest/dist/renderer/" \;
cp "$here/web/tilecast-bridge.js" "$dest/tilecast-bridge.js"
echo "assemble-runtime: runtime assembled in $dest"

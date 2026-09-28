#!/usr/bin/env bash
# Assembles the directory served at tilecast://runtime/ into DEST.
#
# The trusted runtime is the shared Tilecast Player Runtime
# (packages/player-runtime), the same built artifact the Electron player
# serves (docs/tilecast-edge.md §10.2). It is copied unchanged and verified
# against its own manifest; the WPE host adapter (web/tilecast-bridge.js) is
# added beside it and injected by the host, never loaded by the page.
# Build the runtime first: npm run build --workspace @tilecast/player-runtime.
set -euo pipefail
dest=${1:?usage: assemble-runtime.sh DEST}
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
runtime=$(cd -- "$here/../../../packages/player-runtime" && pwd)/dist/runtime
if [[ ! -f "$runtime/runtime-manifest.json" ]]; then
  echo "assemble-runtime: $runtime is missing; build @tilecast/player-runtime first" >&2
  exit 1
fi
rm -rf "$dest"
mkdir -p "$dest"
cp -R "$runtime/." "$dest/"
python3 - "$dest" <<'PY'
import hashlib, json, os, sys
dest = sys.argv[1]
manifest = json.load(open(os.path.join(dest, "runtime-manifest.json")))
for entry in manifest["files"]:
    with open(os.path.join(dest, entry["path"]), "rb") as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()
    if digest != entry["sha256"]:
        sys.exit(f"assemble-runtime: {entry['path']} does not match the runtime manifest")
print(f"assemble-runtime: {len(manifest['files'])} runtime files verified")
PY
cp "$here/web/tilecast-bridge.js" "$dest/tilecast-bridge.js"
echo "assemble-runtime: runtime assembled in $dest"

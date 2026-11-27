#!/usr/bin/env bash
# Developer only: build a WPE WebKit overlay and the compositor lab on this
# machine, in the release builder image, for a screen of the same
# architecture (docs/tilecast-edge-wpe-compositor-lab.md).
#
#   wpe-local.sh --label NAME --release-pin            the pinned release WPE
#   wpe-local.sh --label NAME --version 2.54.3 --sha256 HASH
#   wpe-local.sh --label NAME --webkit ~/src/WebKit    a local checkout
#     [--out DIR] [--jobs N] [--keep-symbols] [--no-lab]
#     [--runtime-overlay | --runtime-overlay-only]
#
# --runtime-overlay-only builds the diagnostic Tilecast overlay of this
# checkout (instrumented renderer + Runtime) against the chosen WPE and nothing
# else; use it with --release-pin for a screen that runs the release's WebKit.
# --runtime-overlay builds it as well as the WPE overlay and the lab. Both
# build the Player Runtime first (npm run build --workspace @tilecast/player-runtime).
#
# The build directory lives in the Docker volume tilecast-wpe-local, one per
# label, so rebuilding a patched checkout is incremental. The outputs are
# wpe-overlay-<label>-<arch>.tar (+ .sha256), tilecast-wpe-lab-<arch>.tar and,
# with --runtime-overlay, tilecast-runtime-overlay-<commit label>-<arch>.tar
# (+ .sha256).
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd -- "$here/../../../.." && pwd)
image=tilecast-edge-release-builder
out=$PWD/wpe-local-out
args=() webkit=
while [[ $# -gt 0 ]]; do
  case $1 in
    --label|--jobs) args+=("$1" "$2"); shift 2 ;;
    --version) version=$2; shift 2 ;;
    --sha256) sha=$2; shift 2 ;;
    --release-pin)
      version=$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import wpe_build_flags as f; print(f.read()["version"])' "$here")
      sha=$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import wpe_build_flags as f; print(f.read()["sha256"])' "$here")
      shift ;;
    --webkit) webkit=$(cd -- "$2" && pwd); shift 2 ;;
    --out) out=$2; shift 2 ;;
    --keep-symbols|--no-lab) args+=("$1"); shift ;;
    --runtime-overlay|--runtime-overlay-only) args+=("$1"); runtime=1; shift ;;
    *) echo "wpe-local: unknown argument $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$out"
out=$(cd -- "$out" && pwd)
if [[ ${runtime:-0} == 1 ]]; then
  (cd "$repo" && npm run build --workspace @tilecast/player-runtime)
fi
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build -t "$image" -f "$repo/apps/edge/release/Dockerfile.builder" "$repo/apps/edge/release"
fi
mounts=(-v "$repo:/src:ro" -v tilecast-wpe-local:/work -v "$out:/out")
if [[ -n $webkit ]]; then
  mounts+=(-v "$webkit:/webkit:ro")
  args+=(--source /webkit)
elif [[ -n ${version:-} ]]; then
  args+=(--tarball "$version" "${sha:?--sha256 is required with --version}")
else
  echo "wpe-local: give --release-pin, --version with --sha256, or --webkit" >&2
  exit 2
fi
docker run --rm "${mounts[@]}" "$image" /src/apps/edge/renderer-wpe/diagnostics/build-wpe-local.sh "${args[@]}"
echo "wpe-local: outputs in $out"

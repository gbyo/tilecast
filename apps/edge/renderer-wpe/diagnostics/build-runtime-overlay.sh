#!/usr/bin/env bash
# Developer only. Builds the diagnostic Tilecast overlay of the current
# checkout: the instrumented tilecast-renderer-wpe (--visual-trace) and the
# exact assembled Runtime and bridge, packed in one archive for
# `tilecast_wpe_debug.py runtime-overlay install`. Never part of a release.
#
# It builds the renderer the way build-edge-release.sh does (same flags, same
# $ORIGIN runtime path, WebKit's sandbox switch off) against a WPE already
# installed at the release prefix, so it must run after build-wpe-local.sh
# has installed the release-pin WPE in the same container. Use
# wpe-local.sh --runtime-overlay on the host instead of calling this directly.
#
#   build-runtime-overlay.sh --prefix PREFIX --out DIR [--label NAME] [--jobs N]
#
# The archive names the git commit, the number of modified files and the
# SHA-256 of the diff. The commit is also compiled into the renderer, and the
# packer refuses a binary that does not carry it.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
src=/src
edge=$src/apps/edge
prefix= out= label= jobs=$(nproc)
while [[ $# -gt 0 ]]; do
  case $1 in
    --prefix) prefix=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --label) label=$2; shift 2 ;;
    --jobs) jobs=$2; shift 2 ;;
    *) echo "build-runtime-overlay: unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ -n $prefix && -n $out ]] || { echo "build-runtime-overlay: --prefix and --out are required" >&2; exit 2; }
[[ -f $prefix/lib/pkgconfig/wpe-webkit-2.0.pc ]] || { echo "build-runtime-overlay: no WPE installed at $prefix" >&2; exit 2; }

git=(git -c safe.directory='*' -C "$src")
commit=$("${git[@]}" rev-parse HEAD)
status=$("${git[@]}" status --porcelain=v1 --untracked-files=all)
modified=$(printf '%s' "$status" | grep -c . || true)
diff_sha=
if [[ $modified -gt 0 ]]; then
  # Tracked changes and the content of new files: what this build used.
  diff_sha=$({
    "${git[@]}" diff HEAD
    while IFS= read -r -d '' file; do
      printf '%s ' "$file"
      sha256sum < "$src/$file"
    done < <("${git[@]}" ls-files --others --exclude-standard -z | sort -z)
  } | sha256sum | cut -d' ' -f1)
fi
# Plain `if` blocks: a failed test in an assignment or a trailing `&&` would
# end the script under `set -e` for a clean checkout.
identity=$commit
if [[ $modified -gt 0 ]]; then
  identity=$commit-dirty
fi
if [[ -z $label ]]; then
  label=tc-${commit:0:12}
  if [[ $modified -gt 0 ]]; then
    label=$label-dirty
  fi
fi
[[ $label =~ ^[a-z0-9][a-z0-9.-]{0,47}$ ]] || { echo "build-runtime-overlay: bad --label" >&2; exit 2; }

# The Runtime build must not be older than what it was built from.
runtime=$src/packages/player-runtime/dist/runtime
if [[ ! -f $runtime/runtime-manifest.json ]]; then
  echo "build-runtime-overlay: $runtime is missing; run: npm run build --workspace @tilecast/player-runtime" >&2
  exit 1
fi
# -print -quit: one path and no pipe, so many stale files cannot fail the
# assignment under pipefail before the rebuild instruction is shown.
stale=$(find "$src/packages/player-runtime/src" "$src/packages/presentation-model/src" -type f -newer "$runtime/runtime-manifest.json" -print -quit 2>/dev/null || true)
if [[ -n $stale ]]; then
  echo "build-runtime-overlay: the Runtime build is older than its sources (e.g. $stale); run: npm run build --workspace @tilecast/player-runtime" >&2
  exit 1
fi

arch=$(uname -m)
build=/work/renderer-$label
export PKG_CONFIG_PATH=$prefix/lib/pkgconfig CFLAGS="-ffile-prefix-map=/src=. -O2"
cmake -S "$edge/renderer-wpe" -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON "-DCMAKE_INSTALL_RPATH=\$ORIGIN/../lib/wpe/lib" \
  "-DTILECAST_BUILD_COMMIT=$identity" >/dev/null
cmake --build "$build" -- -j "$jobs"
ctest --test-dir "$build" --output-on-failure
# The overlay renderer keeps WebKit's sandbox: it clears the variable that
# turns it off, as a release does. Nothing here weakens bubblewrap.
if ! grep -q "ignoring WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS" "$build/tilecast-renderer-wpe"; then
  echo "build-runtime-overlay: the renderer honors the variable that disables WebKit's sandbox" >&2
  exit 1
fi

assembled=/work/runtime-$label
"$edge/renderer-wpe/assemble-runtime.sh" "$assembled"
wpe_version=$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import pack_wpe_overlay as p; print(p.webkit_version(sys.argv[2]))' "$here" "$prefix")
args=(pack --renderer "$build/tilecast-renderer-wpe" --runtime-dir "$assembled" --label "$label" --arch "$arch"
  --commit "$commit" --modified-files "$modified" --wpe-version "$wpe_version" --out "$out")
[[ -n $diff_sha ]] && args+=(--diff-sha256 "$diff_sha")
python3 "$here/runtime_overlay.py" "${args[@]}"

#!/usr/bin/env bash
# Builds the pinned UxPlay for the AirPlay supervisor
# (docs/tilecast-edge-airplay.md §11) into OUTDIR: the uxplay binary, the
# exact source archive, and its GPL-3.0 license. UxPlay is a separate GPL-3.0
# program in the release tree; nothing links it.
#
# The archive is pinned by version, tag commit and SHA-256. The tag
# v1.73.7 names commit df67c212a433cf6dda3676dd40c097900d24e645; the GitHub
# tag archive below has the SHA-256 that this script checks, and its tree is
# identical to that commit's archive.
#
# The binary loads the release's carried libraries (runtime_closure.py) from
# ../lib/wpe/lib, like the renderer. It is built without X11 and without
# -march=native, so one build serves every machine of the architecture.
#
#   build-uxplay.sh OUTDIR [WORKDIR]
set -euo pipefail
UXPLAY_VERSION=1.73.7
UXPLAY_COMMIT=df67c212a433cf6dda3676dd40c097900d24e645
UXPLAY_SHA256=65feb8732de666a7161a9e562aa603a7f5fe0ebb890c2a30c5e1a9c85c76309f
out=${1:?output directory}
work=${2:-/tmp/uxplay-build}
mkdir -p "$work" "$out"
tarball="$work/UxPlay-$UXPLAY_VERSION.tar.gz"
if [ ! -f "$tarball" ]; then
  curl -fsSL -o "$tarball.part" "https://github.com/FDH2/UxPlay/archive/refs/tags/v$UXPLAY_VERSION.tar.gz"
  mv "$tarball.part" "$tarball"
fi
echo "$UXPLAY_SHA256  $tarball" | sha256sum -c -
rm -rf "$work/src" && mkdir -p "$work/src"
tar -xzf "$tarball" -C "$work/src" --strip-components=1
grep -q "^#define VERSION \"$UXPLAY_VERSION\"" "$work/src/uxplay.cpp"
cmake -S "$work/src" -B "$work/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DNO_X11_DEPS=ON \
  -DNO_MARCH_NATIVE=ON \
  -DCMAKE_C_FLAGS="-ffile-prefix-map=$work/src=. -O2" \
  -DCMAKE_CXX_FLAGS="-ffile-prefix-map=$work/src=. -O2" \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
  "-DCMAKE_INSTALL_RPATH=\$ORIGIN/../lib/wpe/lib" >/dev/null
cmake --build "$work/build" --target uxplay
install -m 0755 "$work/build/uxplay" "$out/uxplay"
"$out/uxplay" -v | grep -q "UxPlay version $UXPLAY_VERSION"
# The options the supervisor depends on (tilecast-airplay/src/uxplay.rs).
help=$("$out/uxplay" -h 2>&1 || true)
for option in -rc -pin -vrtp -artp -vs -as -p -s -fps -m -n -nh; do
  grep -qe "^$option\b" <<<"$help" || { echo "UxPlay $UXPLAY_VERSION has no $option option" >&2; exit 1; }
done
install -m 0644 "$tarball" "$out/UxPlay-$UXPLAY_VERSION.tar.gz"
install -m 0644 "$work/src/LICENSE" "$out/LICENSE"
printf '%s\n' "$UXPLAY_VERSION" "$UXPLAY_COMMIT" "$UXPLAY_SHA256" > "$out/pin"

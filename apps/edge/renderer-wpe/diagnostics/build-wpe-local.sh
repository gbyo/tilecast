#!/usr/bin/env bash
# Developer only. Builds WPE WebKit with the Tilecast release configuration
# (the -D flags of apps/edge/release/build-wpe.sh, read by wpe_build_flags.py)
# from either an official release tarball or a local WebKit checkout, and
# packs a debug overlay for one screen plus the compositor lab built against
# it. Never part of a release; a release still builds WebKit only through
# build-wpe.sh and the immutable GHCR prebuild.
#
# Runs inside the release builder image (Dockerfile.builder), with the
# repository at /src, a persistent work volume at /work (one incremental build
# directory per label) and the output directory at /out. Use wpe-local.sh on
# the host instead of calling this directly.
#
#   build-wpe-local.sh --label NAME (--tarball VERSION SHA256 | --source DIR)
#                      [--jobs N] [--keep-symbols] [--no-lab]
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
label= source= version= sha256= jobs=$(nproc) strip=--strip lab=1
while [[ $# -gt 0 ]]; do
  case $1 in
    --label) label=$2; shift 2 ;;
    --tarball) version=$2; sha256=$3; shift 3 ;;
    --source) source=$2; shift 2 ;;
    --jobs) jobs=$2; shift 2 ;;
    --keep-symbols) strip=; shift ;;
    --no-lab) lab=0; shift ;;
    *) echo "build-wpe-local: unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ $label =~ ^[a-z0-9][a-z0-9.-]{0,47}$ ]] || { echo "build-wpe-local: --label must be lower-case letters, digits, '.' and '-'" >&2; exit 2; }
if [[ -n $version && -n $source ]] || [[ -z $version && -z $source ]]; then
  echo "build-wpe-local: give exactly one of --tarball VERSION SHA256 and --source DIR" >&2
  exit 2
fi
[[ $jobs =~ ^[0-9]+$ && $jobs -ge 1 ]] || { echo "build-wpe-local: --jobs must be a number" >&2; exit 2; }
arch=$(uname -m)
config=$(python3 "$here/wpe_build_flags.py")
prefix=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["prefix"])' <<<"$config")
mapfile -t flags < <(python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)["flags"]))' <<<"$config")
identity=/work/identity-$label.json

if [[ -n $version ]]; then
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $sha256 =~ ^[0-9a-f]{64}$ ]] || {
    echo "build-wpe-local: --tarball takes a version like 2.54.3 and a SHA-256" >&2; exit 2; }
  mkdir -p /work/tarballs
  tarball=/work/tarballs/wpewebkit-$version.tar.xz
  if [[ ! -f $tarball ]]; then
    curl -fsSL -o "$tarball.part" "https://wpewebkit.org/releases/wpewebkit-$version.tar.xz"
    mv "$tarball.part" "$tarball"
  fi
  echo "$sha256  $tarball" | sha256sum -c -
  src=/work/src-$version
  if [[ ! -f $src/.tilecast-extracted-$sha256 ]]; then
    rm -rf "$src" && mkdir -p "$src"
    tar -xJf "$tarball" -C "$src" --strip-components=1
    touch "$src/.tilecast-extracted-$sha256"
  fi
  python3 - "$identity" "$version" "$sha256" <<'PY'
import json, sys
json.dump({"kind": "tarball", "version": sys.argv[2], "sha256": sys.argv[3],
           "url": f"https://wpewebkit.org/releases/wpewebkit-{sys.argv[2]}.tar.xz"}, open(sys.argv[1], "w"))
PY
else
  src=$source
  [[ -f $src/CMakeLists.txt && -d $src/Source/WebKit ]] || { echo "build-wpe-local: $src is not a WebKit checkout" >&2; exit 2; }
  git=(git -c safe.directory='*' -C "$src")
  commit=$("${git[@]}" rev-parse HEAD 2>/dev/null || echo unknown)
  dirty=$("${git[@]}" status --porcelain --untracked-files=no 2>/dev/null | wc -l)
  diff_sha=$("${git[@]}" diff HEAD 2>/dev/null | sha256sum | cut -d' ' -f1)
  python3 - "$identity" "$commit" "$dirty" "$diff_sha" <<'PY'
import json, sys
json.dump({"kind": "checkout", "commit": sys.argv[2], "modifiedFiles": int(sys.argv[3]),
           "diffSha256": sys.argv[4] if int(sys.argv[3]) else None}, open(sys.argv[1], "w"))
PY
fi

build=/work/build-$label
echo "build-wpe-local: configuring $build with the release flags"
cmake -S "$src" -B "$build" -G Ninja "${flags[@]}" >/dev/null
cmake --build "$build" -- -j "$jobs"
# A throwaway container: install at the fixed prefix itself, as the release
# builder does, so the lab below compiles against exactly this build.
rm -rf "$prefix"
cmake --install "$build" $strip >/dev/null
python3 "$here/pack_wpe_overlay.py" --prefix "$prefix" --label "$label" --arch "$arch" --identity "$identity" --out /out

if [[ $lab == 1 ]]; then
  labbuild=/work/lab-$label
  PKG_CONFIG_PATH="$prefix/lib/pkgconfig" cmake -S /src/apps/edge/renderer-wpe -B "$labbuild" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON -DCMAKE_INSTALL_RPATH="$prefix/lib" >/dev/null
  cmake --build "$labbuild" --target tilecast-wpe-compositor-lab test-lab-detector test-visual-trace-format
  "$labbuild/test-lab-detector" >/dev/null && "$labbuild/test-visual-trace-format" >/dev/null
  stage=$(mktemp -d)
  mkdir -p "$stage/lab/bin" "$stage/lab/share/tilecast-wpe-lab"
  install -m 0755 "$labbuild/tilecast-wpe-compositor-lab" "$stage/lab/bin/"
  cp -R /src/apps/edge/renderer-wpe/lab/scenes "$stage/lab/share/tilecast-wpe-lab/scenes"
  if [[ ! -f $stage/lab/share/tilecast-wpe-lab/scenes/media/lab-a.mp4 ]]; then
    /src/apps/edge/renderer-wpe/lab/make-media.sh "$stage/lab/share/tilecast-wpe-lab/scenes/media"
  fi
  tar --sort=name --numeric-owner --owner=0 --group=0 --mtime="@${SOURCE_DATE_EPOCH:-0}" \
    -cf "/out/tilecast-wpe-lab-$arch.tar" -C "$stage" lab
  rm -rf "$stage"
  echo "build-wpe-local: /out/tilecast-wpe-lab-$arch.tar"
fi

#!/usr/bin/env bash
# Builds the pinned WPE WebKit into DESTDIR with the fixed prefix
# /opt/tilecast-edge/current/lib/wpe. WebKit compiles its helper process paths
# in, so the prefix is fixed and independent of the Edge version; one build
# serves every Edge release that carries this WPE version. (M10 therefore
# stops the renderer before it switches `current`.)
#
#   build-wpe.sh DESTDIR [WORKDIR]
set -euo pipefail
WPE_VERSION=2.54.0
WPE_SHA256=efa9bcc3cb891c2d88f50eec710d9ccee71cbdf1040420361eb98c17355eb452
PREFIX=/opt/tilecast-edge/current/lib/wpe
destdir=${1:?destination directory}
work=${2:-/tmp/wpe-build}
mkdir -p "$work"
tarball="$work/wpewebkit-$WPE_VERSION.tar.xz"
if [ ! -f "$tarball" ]; then
  curl -fsSL -o "$tarball.part" "https://wpewebkit.org/releases/wpewebkit-$WPE_VERSION.tar.xz"
  mv "$tarball.part" "$tarball"
fi
echo "$WPE_SHA256  $tarball" | sha256sum -c -
rm -rf "$work/src" && mkdir -p "$work/src"
tar -xJf "$tarball" -C "$work/src" --strip-components=1
cmake -S "$work/src" -B "$work/build" -G Ninja \
  -DPORT=WPE \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_INSTALL_LIBEXECDIR=libexec \
  -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
  -DCMAKE_INSTALL_RPATH="$PREFIX/lib" \
  -DENABLE_WPE_PLATFORM=ON \
  -DENABLE_WPE_QT_API=OFF \
  -DENABLE_MINIBROWSER=OFF \
  -DENABLE_DOCUMENTATION=OFF \
  -DENABLE_INTROSPECTION=OFF \
  -DENABLE_BUBBLEWRAP_SANDBOX=ON \
  -DUSE_LIBBACKTRACE=OFF
cmake --build "$work/build"
DESTDIR="$destdir" cmake --install "$work/build" --strip
echo "build-wpe: WPE WebKit $WPE_VERSION installed in $destdir$PREFIX"

#!/usr/bin/env bash
# Compiles the pinned WPE WebKit and packs the deterministic tar that
# build-edge-release.sh step 1 restores from /cache. The wpe-prebuild
# workflow publishes the tar as an immutable release asset, so Edge
# releases download WebKit instead of recompiling it. Keep the tar flags
# in sync with build-edge-release.sh step 1.
#
#   prebuild-wpe.sh OUT.tar [WORKDIR]
# Runs in the release builder image with the repository at /src.
set -euo pipefail
: "${SOURCE_DATE_EPOCH:?the builder image sets SOURCE_DATE_EPOCH}"
release=/src/apps/edge/release
wpe_prefix=/opt/tilecast-edge/current/lib/wpe
out=${1:?output tar path}
work=${2:-/tmp/wpe-build}
"$release/build-wpe.sh" / "$work"
tar --sort=name --numeric-owner --owner=0 --group=0 --mtime="@$SOURCE_DATE_EPOCH" -cf "$out.part" -C / "${wpe_prefix#/}"
mv "$out.part" "$out"
echo "prebuild-wpe: $out"

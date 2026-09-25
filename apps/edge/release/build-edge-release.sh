#!/usr/bin/env bash
# Builds, signs and packages a Tilecast Edge release. Runs in the release
# builder image (Dockerfile.builder) with the repository at /src, a cache at
# /cache and the output at /out; build packages/player-runtime first.
#
#   docker run --rm -v "$PWD:/src" -v "$CACHE:/cache" -v "$OUT:/out" \
#     -v "$KEYS:/keys:ro" -e TILECAST_UPDATE_MANIFEST_PRIVATE_KEY=/keys/update-private.pem \
#     -e TILECAST_UPDATE_MANIFEST_PUBLIC_KEY_FILE=/keys/update-public.pem \
#     tilecast-edge-release-builder /src/apps/edge/release/build-edge-release.sh
#
# Without the signing variables it builds and stages an unsigned tree only.
set -euo pipefail
: "${SOURCE_DATE_EPOCH:?the builder image sets SOURCE_DATE_EPOCH}"
release=/src/apps/edge/release
edge=/src/apps/edge
wpe_version=$(sed -n 's/^WPE_VERSION=//p' "$release/build-wpe.sh")
wpe_sha256=$(sed -n 's/^WPE_SHA256=//p' "$release/build-wpe.sh")
snapshot=$(sed -n 's/^ARG SNAPSHOT=//p' "$release/Dockerfile.builder")
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$edge/Cargo.toml" | head -1)
arch=$(uname -m)
wpe_prefix=/opt/tilecast-edge/current/lib/wpe

# 1. WPE WebKit, cached per version and builder inputs.
key=$(cat "$release/Dockerfile.builder" "$release/build-wpe.sh" | sha256sum | cut -c1-16)
cache="/cache/wpe-$wpe_version-$key.tar"
if [ -f "$cache" ]; then
  tar -xf "$cache" -C /
else
  "$release/build-wpe.sh" / /cache/wpe-work
  tar --sort=name --numeric-owner --owner=0 --group=0 --mtime="@$SOURCE_DATE_EPOCH" -cf "$cache.part" -C / "${wpe_prefix#/}"
  mv "$cache.part" "$cache"
fi
export PKG_CONFIG_PATH="$wpe_prefix/lib/pkgconfig"

# 2. The renderer, against the private WPE, loading it relative to itself.
export CFLAGS="-ffile-prefix-map=/src=. -O2"
cmake -S "$edge/renderer-wpe" -B /cache/renderer -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON "-DCMAKE_INSTALL_RPATH=\$ORIGIN/../lib/wpe/lib" >/dev/null
cmake --build /cache/renderer
ctest --test-dir /cache/renderer --output-on-failure

# 2b. The session bridge (system GStreamer and WirePlumber).
cmake -S "$edge/session-bridge" -B /cache/bridge -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build /cache/bridge
ctest --test-dir /cache/bridge --output-on-failure

# 3. The Rust binaries, without the integration-test feature.
export CARGO_TARGET_DIR=/cache/cargo RUSTFLAGS="--remap-path-prefix=/src=. --remap-path-prefix=/opt/cargo=cargo"
(cd "$edge" && cargo build --release --locked -p tilecastd -p tilecastctl -p tilecast-edge-migrate)
if grep -q TILECAST_MIGRATE_CRASH_AT "$CARGO_TARGET_DIR/release/tilecast-edge-migrate"; then
  echo "the release migrator was built with the integration-test feature" >&2
  exit 1
fi

# 4. The Player Runtime bundle, verified against its manifest.
"$edge/renderer-wpe/assemble-runtime.sh" /cache/runtime

# 5. Stage, describe, stage again with the SBOM, sign.
stage() {
  python3 "$release/stage-release.py" --out /out/tree --version "$version" \
    --bin-dir "$CARGO_TARGET_DIR/release" --renderer /cache/renderer/tilecast-renderer-wpe \
    --session-bridge /cache/bridge/tilecast-session-bridge \
    --gst-plugin-dir /cache/renderer/gstreamer-1.0 --runtime-dir /cache/runtime --sbom "$1" \
    --wpe-version "$wpe_version" --base-distribution "debian-13-snapshot-$snapshot" --wpe-lib-dir "$wpe_prefix"
}
echo '{"bomFormat":"CycloneDX","specVersion":"1.5","components":[]}' > /cache/sbom-placeholder.json
stage /cache/sbom-placeholder.json
python3 "$release/sbom.py" --release-tree /out/tree --version "$version" --snapshot "$snapshot" \
  --wpe-version "$wpe_version" --wpe-sha256 "$wpe_sha256" --out /cache/sbom.cdx.json
stage /cache/sbom.cdx.json
cp /cache/sbom.cdx.json "/out/tilecast-edge-$version-$arch.sbom.cdx.json"

manifest=/out/tree/tilecast-edge-release.json
if [ -n "${TILECAST_UPDATE_MANIFEST_PRIVATE_KEY:-}" ]; then
  openssl pkeyutl -sign -rawin -inkey "$TILECAST_UPDATE_MANIFEST_PRIVATE_KEY" -in "$manifest" |
    openssl base64 -A > "$manifest.sig"
  openssl pkeyutl -verify -rawin -pubin -inkey "${TILECAST_UPDATE_MANIFEST_PUBLIC_KEY_FILE:?}" -in "$manifest" \
    -sigfile <(openssl base64 -d -A -in "$manifest.sig")
  # The migrator verifies the same way it will on a screen.
  mkdir -p /cache/verify
  openssl pkey -pubin -in "$TILECAST_UPDATE_MANIFEST_PUBLIC_KEY_FILE" -outform DER | tail -c 32 | base64 > /cache/verify/key
else
  echo "build-edge-release: no signing key; the tree is unsigned" >&2
fi

# 6. The archive, byte-for-byte reproducible from the tree.
archive="tilecast-edge-$version-$arch.tar.zst"
tar --sort=name --numeric-owner --owner=0 --group=0 --mtime="@$SOURCE_DATE_EPOCH" -C /out/tree -cf - . |
  zstd -19 -T1 -q > "/out/$archive"
cp "$manifest" "/out/tilecast-edge-$version-$arch.json"
[ -f "$manifest.sig" ] && cp "$manifest.sig" "/out/tilecast-edge-$version-$arch.json.sig"
(cd /out && sha256sum "$archive" "tilecast-edge-$version-$arch.json" "tilecast-edge-$version-$arch.sbom.cdx.json" \
  $( [ -f "tilecast-edge-$version-$arch.json.sig" ] && echo "tilecast-edge-$version-$arch.json.sig") > SHA256SUMS)
echo "build-edge-release: Tilecast Edge $version ($arch) with WPE WebKit $wpe_version in /out"

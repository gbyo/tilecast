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
wpe_version=$(python3 "$release/inputs.py" wpe-version)
wpe_sha256=$(sed -n 's/^WPE_SHA256=//p' "$release/build-wpe.sh")
snapshot=$(sed -n 's/^ARG SNAPSHOT=//p' "$release/Dockerfile.builder")
version=$(python3 "$release/inputs.py" version)
export TILECAST_EDGE_VERSION="$version"
arch=$(uname -m)
wpe_prefix=/opt/tilecast-edge/current/lib/wpe

# 1. WPE WebKit, cached per version, builder inputs and architecture: a
# cache entry for the other architecture is ignored, never extracted.
# The key ignores comments and whitespace (inputs.py), and the release
# workflow prefers a published prebuild at this exact path before the
# best-effort CI cache, so releases never recompile WebKit.
key=$(python3 "$release/inputs.py" wpe-key)
cache="/cache/wpe-$wpe_version-$key-$arch.tar"
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

# 2b. The isolated remote web helper (M11): the same private WPE WebKit (see
# PKG_CONFIG_PATH above), its own protocol/policy/frame tests, then the
# helper binary for the release.
cmake -S "$edge/web-renderer-wpe" -B /cache/web-renderer -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build /cache/web-renderer
ctest --test-dir /cache/web-renderer --output-on-failure

# 2c. The session bridge (system GStreamer and WirePlumber).
cmake -S "$edge/session-bridge" -B /cache/bridge -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build /cache/bridge
ctest --test-dir /cache/bridge --output-on-failure

# 3. The Rust binaries, without the integration-test feature.
export CARGO_TARGET_DIR=/cache/cargo RUSTFLAGS="--remap-path-prefix=/src=. --remap-path-prefix=/opt/cargo=cargo"
(cd /src && cargo build --release --locked --message-format=json-render-diagnostics \
  -p tilecastd -p tilecastctl -p tilecast-edge-migrate -p tilecast-edge-update) > /cache/edge-rust-artifacts.jsonl
if grep -q TILECAST_MIGRATE_CRASH_AT "$CARGO_TARGET_DIR/release/tilecast-edge-migrate" ||
  grep -q TILECAST_UPDATE_CRASH_AT "$CARGO_TARGET_DIR/release/tilecast-edge-update"; then
  echo "a release root tool was built with the integration-test feature" >&2
  exit 1
fi

# 4. The Player Runtime bundle, verified against its manifest.
"$edge/renderer-wpe/assemble-runtime.sh" /cache/runtime

# 5. Stage, describe, stage again with the SBOM, sign.
stage() {
  python3 "$release/stage-release.py" --out /out/tree --version "$version" \
    --bin-dir "$CARGO_TARGET_DIR/release" --renderer /cache/renderer/tilecast-renderer-wpe \
    --web-renderer /cache/web-renderer/tilecast-web-renderer-wpe \
    --session-bridge /cache/bridge/tilecast-session-bridge \
    --gst-plugin-dir /cache/renderer/gstreamer-1.0 --runtime-dir /cache/runtime --sbom "$1" \
    --wpe-version "$wpe_version" --base-distribution "debian-13-snapshot-$snapshot" --wpe-lib-dir "$wpe_prefix"
}
echo '{"bomFormat":"CycloneDX","specVersion":"1.5","components":[]}' > /cache/sbom-placeholder.json
stage /cache/sbom-placeholder.json
python3 "$release/sbom.py" --release-tree /out/tree --version "$version" --snapshot "$snapshot" \
  --wpe-version "$wpe_version" --wpe-sha256 "$wpe_sha256" --out /cache/sbom.cdx.json \
  --cargo-artifacts /cache/edge-rust-artifacts.jsonl
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
# 7. The update envelope (M10): binds the archive to the manifest inside it,
# signed with the same key and in the same way.
state_schema=$(python3 "$release/inputs.py" state-schema)
envelope="/out/tilecast-edge-update-$arch.json"
python3 "$release/envelope.py" --tree /out/tree --archive "/out/$archive" --arch "$arch" \
  --state-schema "$state_schema" --channel "${TILECAST_EDGE_CHANNEL:-stable}" --out "$envelope"
if [ -n "${TILECAST_UPDATE_MANIFEST_PRIVATE_KEY:-}" ]; then
  openssl pkeyutl -sign -rawin -inkey "$TILECAST_UPDATE_MANIFEST_PRIVATE_KEY" -in "$envelope" |
    openssl base64 -A > "$envelope.sig"
  openssl pkeyutl -verify -rawin -pubin -inkey "$TILECAST_UPDATE_MANIFEST_PUBLIC_KEY_FILE" -in "$envelope" \
    -sigfile <(openssl base64 -d -A -in "$envelope.sig")
fi
(cd /out && sha256sum "$archive" "tilecast-edge-$version-$arch.json" "tilecast-edge-$version-$arch.sbom.cdx.json" \
  "tilecast-edge-update-$arch.json" \
  $( [ -f "tilecast-edge-$version-$arch.json.sig" ] && echo "tilecast-edge-$version-$arch.json.sig") \
  $( [ -f "tilecast-edge-update-$arch.json.sig" ] && echo "tilecast-edge-update-$arch.json.sig") > SHA256SUMS)
echo "build-edge-release: Tilecast Edge $version ($arch) with WPE WebKit $wpe_version in /out"

#!/usr/bin/env bash
# Fetches the prebuilt private WPE WebKit for one architecture from GHCR and
# verifies it before the release build will use it.
#
#   fetch-wpe-prebuild.sh ARCH DIR
#
# The prebuild is an OCI artifact (not a runnable image) at the immutable
# reference `inputs.py wpe-ref ARCH`: ghcr.io/gbyo/tilecast-wpe:<wpe version>-
# <builder inputs key>-<arch>. It leaves DIR/<wpe tar name> only after:
#   * the manifest is a Tilecast WPE prebuild with exactly one tar layer whose
#     name, architecture, inputs key and SHA-256 match this checkout's inputs;
#   * the pulled bytes hash to the digest the registry and the manifest name;
#   * the tar has a GitHub build provenance attestation from wpe-prebuild.yml.
# It exits 1 when there is no prebuild, and 2 when there is one that fails a
# check. The release workflow treats both the same way: it falls back to the
# Actions cache and then to compiling WebKit, so a missing or rejected prebuild
# slows a release and never changes what ships.
#
# TILECAST_ORAS and TILECAST_GH replace the oras and gh programs in tests.
set -euo pipefail

arch=${1:?architecture}
dir=${2:?output directory}
release=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
oras=${TILECAST_ORAS:-oras}
gh=${TILECAST_GH:-gh}
repository=${GITHUB_REPOSITORY:-gbyo/tilecast}
signer_workflow="$repository/.github/workflows/wpe-prebuild.yml"
artifact_type=application/vnd.tilecast.wpe-prebuild.v1

ref=$(python3 "$release/inputs.py" wpe-ref "$arch")
name=$(python3 "$release/inputs.py" wpe-tar "$arch")
key=$(python3 "$release/inputs.py" wpe-key)

reject() {
  echo "fetch-wpe-prebuild: rejected $ref: $*" >&2
  exit 2
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if ! "$oras" manifest fetch "$ref" > "$work/manifest.json" 2> "$work/error.txt"; then
  echo "fetch-wpe-prebuild: no prebuild at $ref" >&2
  exit 1
fi

jq -e --arg type "$artifact_type" --arg name "$name" --arg arch "$arch" --arg key "$key" '
  .artifactType == $type
  and (.layers | length) == 1
  and .layers[0].mediaType == "application/x-tar"
  and .layers[0].annotations["org.opencontainers.image.title"] == $name
  and .annotations["org.tilecast.wpe.architecture"] == $arch
  and .annotations["org.tilecast.wpe.inputs-key"] == $key
  and .annotations["org.tilecast.wpe.tar-sha256"] == (.layers[0].digest | ltrimstr("sha256:"))
  and (.layers[0].size > 0 and .layers[0].size < 8589934592)
' "$work/manifest.json" > /dev/null || reject "the manifest is not this build's WPE prebuild"

expected=$(jq -r '.layers[0].digest | ltrimstr("sha256:")' "$work/manifest.json")
mkdir "$work/pull"
"$oras" pull "$ref" --output "$work/pull" > /dev/null 2>&1 || reject "the layer could not be pulled"
[ -f "$work/pull/$name" ] && [ "$(find "$work/pull" -type f | wc -l | tr -d ' ')" = 1 ] || reject "the artifact does not contain exactly $name"
actual=$(sha256sum "$work/pull/$name" | cut -d' ' -f1)
[ "$actual" = "$expected" ] || reject "the tar hashes to $actual, not $expected"

"$gh" attestation verify "$work/pull/$name" --repo "$repository" --signer-workflow "$signer_workflow" > /dev/null 2>&1 \
  || reject "the tar has no build provenance attestation from $signer_workflow"

mkdir -p "$dir"
mv "$work/pull/$name" "$dir/$name"
echo "fetch-wpe-prebuild: $ref verified ($actual)"

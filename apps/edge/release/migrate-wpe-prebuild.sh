#!/usr/bin/env bash
# One-time migration of the WPE WebKit prebuilds that used to be published as
# GitHub Releases (tags wpe-<version>-<key>-<arch>) to GHCR.
#
#   migrate-wpe-prebuild.sh backfill RELEASE_TAG [--dry-run]
#   migrate-wpe-prebuild.sh check    RELEASE_TAG
#
# backfill  verifies the old release's tar and publishes it to
#           ghcr.io/gbyo/tilecast-wpe under the matching tag (the release tag
#           without "wpe-"). Nothing already in GHCR is ever replaced. With
#           --dry-run it verifies everything and publishes nothing.
# check     succeeds only when GHCR already holds exactly the old release's
#           tar. wpe-release-cleanup.yml runs it before it deletes an old
#           release, so a release is only removed once its prebuild is safe.
#
# The old tar is trusted only after three checks that must all pass: it hashes
# to the digest GitHub records for the asset, it hashes to the SHA-256 the
# release notes state, and it has a GitHub build provenance attestation from
# wpe-prebuild.yml in this repository.
#
# TILECAST_ORAS and TILECAST_GH replace oras and gh in tests.
set -euo pipefail

command=${1:?use backfill or check}
tag=${2:?old release tag}
dry_run=false
[ "${3:-}" = "--dry-run" ] && dry_run=true
release=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
oras=${TILECAST_ORAS:-oras}
gh=${TILECAST_GH:-gh}
repository=${GITHUB_REPOSITORY:-gbyo/tilecast}
signer_workflow="$repository/.github/workflows/wpe-prebuild.yml"

if ! [[ "$tag" =~ ^wpe-([0-9A-Za-z.]+)-([0-9a-f]{16})-(x86_64|aarch64)$ ]]; then
  echo "migrate-wpe-prebuild: $tag is not a WPE prebuild release tag" >&2
  exit 1
fi
version=${BASH_REMATCH[1]}
key=${BASH_REMATCH[2]}
arch=${BASH_REMATCH[3]}
tar_name="$tag.tar"
ref=$(python3 "$release/inputs.py" wpe-ref-for "$version" "$key" "$arch")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

"$gh" release view "$tag" --repo "$repository" --json assets,body,publishedAt > "$work/release.json"
recorded=$(jq -r --arg name "$tar_name" '[.assets[] | select(.name == $name) | .digest // ""][0] // ""' "$work/release.json")
stated=$(jq -r '.body' "$work/release.json" | sed -n 's/^.*Tar SHA-256: \([0-9a-f]\{64\}\).*$/\1/p' | head -n1)
revision=$(jq -r '.body' "$work/release.json" | sed -n 's/^.*Built from commit \([0-9a-f]\{40\}\).*$/\1/p' | head -n1)
created=$(jq -r '.publishedAt' "$work/release.json")
[ -n "$recorded" ] || [ -n "$stated" ] || { echo "migrate-wpe-prebuild: $tag records no digest to verify the tar against" >&2; exit 2; }

"$gh" release download "$tag" --repo "$repository" --pattern "$tar_name" --dir "$work" > /dev/null
[ -s "$work/$tar_name" ] || { echo "migrate-wpe-prebuild: $tag has no asset $tar_name" >&2; exit 2; }
sha256=$(sha256sum "$work/$tar_name" | cut -d' ' -f1)
if [ -n "$recorded" ] && [ "$recorded" != "sha256:$sha256" ]; then
  echo "migrate-wpe-prebuild: $tag asset hashes to $sha256 but GitHub records $recorded" >&2
  exit 2
fi
if [ -n "$stated" ] && [ "$stated" != "$sha256" ]; then
  echo "migrate-wpe-prebuild: $tag asset hashes to $sha256 but its notes state $stated" >&2
  exit 2
fi
"$gh" attestation verify "$work/$tar_name" --repo "$repository" --signer-workflow "$signer_workflow" > /dev/null 2>&1 \
  || { echo "migrate-wpe-prebuild: $tag has no build provenance attestation from $signer_workflow" >&2; exit 2; }

# Whether GHCR already holds exactly this tar.
published=false
if "$oras" manifest fetch "$ref" > "$work/ghcr.json" 2> /dev/null; then
  jq -e --arg d "sha256:$sha256" --arg arch "$arch" --arg key "$key" '
    .artifactType == "application/vnd.tilecast.wpe-prebuild.v1"
    and (.layers | length) == 1 and .layers[0].digest == $d
    and .annotations["org.tilecast.wpe.architecture"] == $arch
    and .annotations["org.tilecast.wpe.inputs-key"] == $key
  ' "$work/ghcr.json" > /dev/null \
    || { echo "migrate-wpe-prebuild: $ref exists and is not this tar; it is never replaced" >&2; exit 2; }
  published=true
fi

case "$command" in
  check)
    $published || { echo "migrate-wpe-prebuild: $ref is not in GHCR yet" >&2; exit 1; }
    echo "migrate-wpe-prebuild: $tag is safe in GHCR at $ref ($sha256)" ;;
  backfill)
    if $published; then
      echo "migrate-wpe-prebuild: $ref already holds $tag ($sha256)"
    elif $dry_run; then
      echo "migrate-wpe-prebuild: dry run: would publish $tag ($sha256) to $ref"
    else
      TILECAST_WPE_VERSION=$version TILECAST_WPE_KEY=$key TILECAST_WPE_REVISION=${revision:-unknown} \
        TILECAST_WPE_CREATED=$created "$release/publish-wpe-prebuild.sh" "$work/$tar_name" "$arch"
    fi ;;
  *)
    echo "use backfill or check" >&2
    exit 2 ;;
esac

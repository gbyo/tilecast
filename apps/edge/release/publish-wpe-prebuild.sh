#!/usr/bin/env bash
# Publishes a WPE prebuild tar to GHCR as an immutable OCI artifact.
#
#   publish-wpe-prebuild.sh TAR ARCH
#
# The tag is `inputs.py wpe-ref ARCH`, which binds the pinned WPE version, the
# normalized builder inputs and the architecture. A tag that already exists is
# never replaced: the script prints its digest and exits 0, so a rerun, a
# concurrent run and the one-time backfill of the old GitHub release prebuilds
# all converge on the first publication. The artifact has no runnable layers;
# it is one application/x-tar layer under artifactType
# application/vnd.tilecast.wpe-prebuild.v1.
#
# Optional environment: TILECAST_WPE_REVISION (the commit that built the tar,
# default GITHUB_SHA) and TILECAST_WPE_CREATED (RFC 3339 build time, default
# now). The one-time backfill of the old GitHub release prebuilds
# (migrate-wpe-prebuild.sh) also sets TILECAST_WPE_VERSION and TILECAST_WPE_KEY,
# because an old prebuild belongs to the inputs it was built from, not to this
# checkout's. TILECAST_ORAS replaces the oras program in tests.
set -euo pipefail

tar_path=${1:?tar file}
arch=${2:?architecture}
release=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
oras=${TILECAST_ORAS:-oras}
version=${TILECAST_WPE_VERSION:-$(python3 "$release/inputs.py" wpe-version)}
key=${TILECAST_WPE_KEY:-$(python3 "$release/inputs.py" wpe-key)}
ref=$(python3 "$release/inputs.py" wpe-ref-for "$version" "$key" "$arch")
name="wpe-$version-$key-$arch.tar"
revision=${TILECAST_WPE_REVISION:-${GITHUB_SHA:-unknown}}
created=${TILECAST_WPE_CREATED:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}

if [ "$(basename "$tar_path")" != "$name" ]; then
  echo "publish-wpe-prebuild: the tar must be named $name" >&2
  exit 1
fi
[ -s "$tar_path" ] || { echo "publish-wpe-prebuild: $tar_path is empty" >&2; exit 1; }

if existing=$("$oras" manifest fetch --descriptor "$ref" 2> /dev/null); then
  echo "publish-wpe-prebuild: $ref already exists ($(jq -r .digest <<< "$existing")); nothing to do"
  exit 0
fi

sha256=$(sha256sum "$tar_path" | cut -d' ' -f1)
cd "$(dirname "$tar_path")"
"$oras" push "$ref" "$name:application/x-tar" \
  --artifact-type application/vnd.tilecast.wpe-prebuild.v1 \
  --annotation "org.opencontainers.image.title=Tilecast WPE WebKit $version prebuild ($arch)" \
  --annotation "org.opencontainers.image.description=Private WPE WebKit build for Tilecast Edge releases. Not a runnable image." \
  --annotation "org.opencontainers.image.source=https://github.com/gbyo/tilecast" \
  --annotation "org.opencontainers.image.revision=$revision" \
  --annotation "org.opencontainers.image.version=$version" \
  --annotation "org.opencontainers.image.created=$created" \
  --annotation "org.tilecast.wpe.architecture=$arch" \
  --annotation "org.tilecast.wpe.inputs-key=$key" \
  --annotation "org.tilecast.wpe.tar-sha256=$sha256" \
  --no-tty
digest=$("$oras" manifest fetch --descriptor "$ref" | jq -r .digest)
echo "publish-wpe-prebuild: published $ref ($digest), tar sha256 $sha256"
echo "digest=$digest" >> "${GITHUB_OUTPUT:-/dev/null}"

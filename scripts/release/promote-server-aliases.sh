#!/usr/bin/env bash
# Moves the Server image aliases to one verified, published digest.
#
#   PROMOTE_DIGEST=sha256:<hash> ALIASES='["stable","latest","beta"]' \
#   RELEASE_CHANNEL=stable promote-server-aliases.sh
#
# This is a registry-native tag operation. It builds nothing and it never reads
# the version tag, so an alias can only name the artifact the release recorded.
# release.yml decides which aliases are due (scripts/release/release_plan.py);
# this script is the last guard:
#   * only stable, latest and beta can move;
#   * only a Stable release can move stable and latest;
#   * the digest must exist, and every alias must name it afterwards.
# An empty list is not an error: a release that is not the newest of its kind
# owes no alias.
#
# IMAGE defaults to ghcr.io/gbyo/tilecast-server. DOCKER replaces docker in tests.
set -euo pipefail

image=${IMAGE:-ghcr.io/gbyo/tilecast-server}
docker=${DOCKER:-docker}
digest=${PROMOTE_DIGEST:-}
channel=${RELEASE_CHANNEL:-}

if ! [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Digest has an unexpected shape: ${digest:-<empty>}." >&2
  exit 1
fi
case "$channel" in
  stable | beta) ;;
  *)
    echo "The release channel must be stable or beta, not '${channel:-<empty>}'." >&2
    exit 1 ;;
esac
aliases=()
while IFS= read -r alias; do
  aliases+=("$alias")
done < <(jq -r '.[]' <<<"${ALIASES:-[]}")
if [ "${#aliases[@]}" -eq 0 ]; then
  echo "No alias is due to move for this release."
  exit 0
fi
for alias in "${aliases[@]}"; do
  case "$alias" in
    stable | latest)
      if [ "$channel" != stable ]; then
        echo "A $channel release must not move $alias." >&2
        exit 1
      fi ;;
    beta) ;;
    *)
      echo "Refusing to move the unknown alias '$alias'." >&2
      exit 1 ;;
  esac
done

source_ref="$image@$digest"
"$docker" buildx imagetools inspect "$source_ref" > /dev/null
tags=()
for alias in "${aliases[@]}"; do
  tags+=(--tag "$image:$alias")
done
"$docker" buildx imagetools create "${tags[@]}" "$source_ref"
expected=$("$docker" buildx imagetools inspect "$source_ref" --format '{{json .Manifest}}')
test -n "$expected"
for alias in "${aliases[@]}"; do
  actual=$("$docker" buildx imagetools inspect "$image:$alias" --format '{{json .Manifest}}')
  test "$actual" = "$expected"
  echo "$alias now names $digest."
done

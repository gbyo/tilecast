#!/usr/bin/env bash
# Builds the clean closure image and checks a staged release tree in it.
#
#   apps/edge/release/run-closure-check.sh /path/to/tree
#
# The tree is mounted read-only at /opt/tilecast-edge/current, where it
# installs. The image is built for the machine's own architecture, so the
# release for that architecture is the one checked. Exit status 1 means a
# library does not resolve; the unresolved names are printed.
set -euo pipefail
tree=${1:?usage: run-closure-check.sh TREE}
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
docker build -q -t tilecast-edge-closure -f "$here/Dockerfile.closure" "$here" >/dev/null
docker run --rm -v "$(cd -- "$tree" && pwd):/opt/tilecast-edge/current:ro" tilecast-edge-closure

#!/bin/sh
# sync-marketplace-catalog.sh — copy the canonical marketplace catalog into
# the server's embedded snapshot. The repository file stays the single
# authored source of truth; make generate refreshes the copy, and
# make generated-check fails when the committed copy drifts from it.
set -eu
cd "$(dirname "$0")/.."
cp marketplace/catalog.json apps/server/internal/extensions/catalog/bundled_catalog.json

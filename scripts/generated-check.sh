#!/bin/sh
# make generated-check: regenerate everything and fail on any working-tree
# diff in a generated file. Run in a clean checkout in CI; with a dirty
# tree, stash or commit first so unrelated edits are not blamed.
set -eu
cd "$(dirname "$0")/.."
make generate
set -- \
  docs/openapi.yaml \
  plugins/registry_gen.go \
  .github/CODEOWNERS \
  packages/plugin-sdk/schema/tilecast-plugin.schema.json \
  packages/widget-sdk/schema/tilecast-widget.schema.json \
  packages/data-source-sdk/schema/tilecast-datasource.schema.json \
  apps/server/internal/database/migrations.lock.json \
  'plugins/*/automation.gen.json' \
  widgets/plugin_widgets.gen.go \
  data-sources/plugin_sources.gen.go \
  packages/player-runtime/src/widgets/capabilities.gen.ts \
  packages/api-client/internal/generated \
  packages/api-schema/generated

git diff --exit-code -- "$@"
untracked="$(git ls-files --others --exclude-standard -- "$@")"
if [ -n "$untracked" ]; then
  echo "generated-check: untracked generated files:" >&2
  printf '%s\n' "$untracked" >&2
  exit 1
fi

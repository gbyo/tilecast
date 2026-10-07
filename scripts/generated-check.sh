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
  packages/package-sdk/schema/tilecast-package.schema.json \
  packages/widget-sdk/schema/tilecast-widget.schema.json \
  packages/data-source-sdk/schema/tilecast-datasource.schema.json \
  apps/server/internal/database/migrations.lock.json \
  apps/server/internal/extensions/catalog/bundled_catalog.json \
  'plugins/*/automation.gen.json' \
  widgets/plugin_widgets.gen.go \
  data-sources/plugin_sources.gen.go \
  packages/player-runtime/src/widgets/capabilities.gen.ts \
  packages/player-runtime/src/compat/projection/presentation-capabilities.gen.ts \
  apps/edge/tilecastd/src/presentation_capabilities.rs \
  apps/player-android/native/src/presentation_capabilities.rs \
  apps/player-android/native/src/widget_capabilities.rs \
  apps/player-android/app/src/main/java/org/tilecast/player/network/PresentationCapabilities.gen.kt \
  apps/server/internal/presentationcaps/capabilities.gen.go \
  packages/api-client/internal/generated \
  packages/api-schema/generated \
  apps/ios/Tilecast/Resources/Assets.xcassets/Lucide \
  apps/ios/TilecastKit/Sources/TilecastCore/Navigation/NavigationIconImages.gen.swift \
  apps/ios/Tilecast/App/AppIcon.gen.swift

git diff --exit-code -- "$@"
untracked="$(git ls-files --others --exclude-standard -- "$@")"
if [ -n "$untracked" ]; then
  echo "generated-check: untracked generated files:" >&2
  printf '%s\n' "$untracked" >&2
  exit 1
fi

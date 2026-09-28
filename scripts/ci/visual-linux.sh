#!/usr/bin/env bash
# Run the same Chromium build on Linux from any contributor host. The source
# is copied into an ephemeral container so npm never replaces host binaries.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
suite="${1:-studio}"
shift || true
case "$suite" in
  studio|widgets) ;;
  *) echo "Usage: scripts/ci/visual-linux.sh studio|widgets [Playwright arguments]" >&2; exit 2 ;;
esac
playwright_version="$(cd "$repo_dir" && node -p 'require("@playwright/test/package.json").version')"
mkdir -p "$repo_dir/e2e/visual/__screenshots__/linux" "$repo_dir/widgets/visual/__screenshots__/linux" "$repo_dir/e2e/visual/test-results/linux-run"
docker run --rm --ipc=host \
  -e TILECAST_E2E_BASE_URL="${TILECAST_E2E_BASE_URL:-http://host.docker.internal:${TILECAST_DEMO_PORT:-18080}}" \
  -v "$repo_dir:/src:ro" \
  -v "$repo_dir/e2e/visual/__screenshots__/linux:/studio-baselines" \
  -v "$repo_dir/widgets/visual/__screenshots__/linux:/widget-baselines" \
  -v "$repo_dir/e2e/visual/test-results/linux-run:/artifacts" \
  "mcr.microsoft.com/playwright:v${playwright_version}-noble" \
  bash -eu -o pipefail -c '
    mkdir /work
    tar -C /src --exclude=./.git --exclude=./.muse --exclude=./.claude --exclude="*/.gradle" --exclude="*/node_modules" --exclude="*/dist" --exclude="*/target" --exclude="*/build" --exclude="*/test-results" --exclude="*/playwright-report" --exclude=./widgets/storybook-static -cf - . | tar -C /work -xf -
    cd /work
    npm ci
    suite="$1"; shift
    if [ "$suite" = widgets ]; then
      npm run widgets:storybook:build
      config=widgets/visual/playwright.config.ts
      output=widgets/visual
      baseline=/widget-baselines
    else
      config=e2e/visual/playwright.config.ts
      output=e2e/visual
      baseline=/studio-baselines
    fi
    trap '\''cp -a "$output/test-results" /artifacts/ 2>/dev/null || true; cp -a "$output/playwright-report" /artifacts/ 2>/dev/null || true'\'' EXIT
    npx playwright test -c "$config" "$@"
    for argument in "$@"; do
      if [[ "$argument" == --update-snapshots* ]]; then
        cp -a "$output/__screenshots__/linux/." "$baseline/"
        break
      fi
    done
  ' bash "$suite" "$@"

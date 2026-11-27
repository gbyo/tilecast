#!/bin/sh
# Counts Countdown Bar's own source lines by category, for the Plugin Model V3
# phase 1 proof (docs/adr/plugin-model-v3.md). Pass a git revision to count
# that revision instead of the working tree:
#
#   scripts/plugins/countdown-bar-lines.sh            # working tree
#   scripts/plugins/countdown-bar-lines.sh a94e81b1b  # an earlier commit
#
# Lines are physical lines (wc -l). Store artwork, generated files
# (automation.gen.json), and locale JSON are not counted.
set -eu
rev="${1:-}"
dir=plugins/countdown-bar
list() {
  if [ -n "$rev" ]; then git ls-tree -r --name-only "$rev" -- "$dir"; else git ls-files -- "$dir"; git ls-files --others --exclude-standard -- "$dir"; fi
}
count() {
  total=0
  for file in $(list | grep -E "$1" | grep -Ev "$2" || true); do
    if [ -n "$rev" ]; then n=$(git show "$rev:$file" | wc -l); else [ -f "$file" ] || continue; n=$(wc -l < "$file"); fi
    total=$((total + n))
  done
  echo "$total"
}
tests='(_test\.go|\.test\.tsx?)$'
printf '%-58s %6s\n' "Category" "Lines"
printf '%-58s %6s\n' "Server CRUD, storage, targets, routes (server/{store,http,plugin}.go)" "$(count "^$dir/server/(store|http|plugin)\.go$" "$tests")"
printf '%-58s %6s\n' "Migrations (shipped files never change; see the note)" "$(count "^$dir/migrations/" "$tests")"
printf '%-58s %6s\n' "Studio CRUD and editor (studio/*.ts, studio/*.tsx)" "$(count "^$dir/studio/[^/]+\.tsx?$" "$tests")"
printf '%-58s %6s\n' "API and automation boilerplate (api/, automation.yaml)" "$(count "^$dir/(api/|automation\.yaml$)" "$tests")"
printf '%-58s %6s\n' "Domain validation and projection (server/model.go, server/demo.go, plugin.go)" "$(count "^$dir/(server/(model|demo)\.go|plugin\.go)$" "$tests")"
printf '%-58s %6s\n' "Player runtime (runtime/)" "$(count "^$dir/runtime/" "$tests")"
printf '%-58s %6s\n' "Manifest (tilecast.plugin.json)" "$(count "^$dir/tilecast\.plugin\.json$" "$tests")"
printf '%-58s %6s\n' "Tests" "$(count "$tests" '^$')"

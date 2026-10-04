#!/usr/bin/env bash
# Only the portable shared layer; Linux integration stays in Edge validation.
set -euo pipefail
repo_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"
names=$(cargo metadata --locked --no-deps --format-version 1 | python3 -c '
import json,sys
from pathlib import Path
root=Path.cwd()/"crates"
for package in sorted(json.load(sys.stdin)["packages"], key=lambda p:p["name"]):
    if Path(package["manifest_path"]).parent.parent == root:
        print(package["name"])
')
selection=()
while IFS= read -r name; do
  if [ -n "$name" ]; then selection+=(-p "$name"); fi
done <<< "$names"
if [ ${#selection[@]} -eq 0 ]; then
  echo "No shared Player crates registered in Cargo workspace." >&2
  exit 1
fi
case "${1:?use fmt, clippy, test, or doc}" in
  fmt) shift; cargo fmt "${selection[@]}" "$@" ;;
  clippy|test|doc) command=$1; shift; cargo "$command" --locked "${selection[@]}" "$@" ;;
  *) echo "use fmt, clippy, test, or doc" >&2; exit 2 ;;
esac

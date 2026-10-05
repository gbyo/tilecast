#!/usr/bin/env bash
# The Android platform host crate only; the shared layer stays in
# cargo-player.sh and Linux integration in Edge validation.
set -euo pipefail
repo_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"
selection=(-p tilecast-player-android-native)
case "${1:?use fmt, clippy, test, or doc}" in
  fmt) shift; cargo fmt "${selection[@]}" "$@" ;;
  clippy|test|doc) command=$1; shift; cargo "$command" --locked "${selection[@]}" "$@" ;;
  *) echo "use fmt, clippy, test, or doc" >&2; exit 2 ;;
esac

#!/usr/bin/env bash
# Scope product validation explicitly; root --workspace includes future hosts.
set -euo pipefail
edge_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
packages=(edge-protocol edge-state edge-cas edge-server edge-platform edge-ipc edge-release
  tilecastd tilecastctl tilecast-edge-migrate tilecast-edge-update)
selection=()
for package in "${packages[@]}"; do selection+=(-p "$package"); done
cd "$edge_root/../.."
case "${1:?use fmt, clippy, or test}" in
  fmt) shift; cargo fmt "${selection[@]}" "$@" ;;
  clippy|test) command=$1; shift; cargo "$command" --locked "${selection[@]}" "$@" ;;
  *) echo "use fmt, clippy, or test" >&2; exit 2 ;;
esac

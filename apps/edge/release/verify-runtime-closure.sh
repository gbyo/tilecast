#!/usr/bin/env bash
# Fails if any shared library of a Tilecast Edge release tree does not resolve.
#
# Run it in the clean closure image (Dockerfile.closure) with the release tree
# mounted at its installed path, because the private WPE WebKit finds its
# libraries through an absolute RUNPATH under /opt/tilecast-edge/current:
#
#   docker run --rm -v "$TREE:/opt/tilecast-edge/current:ro" tilecast-edge-closure
#
# Every ELF file is checked, not only the two renderers: the injected bundle,
# WebKit's helper processes, the GStreamer plugin and the session bridge load
# libraries too. A builder-environment ldd proves nothing here, because the
# builder has the -dev packages that hide a missing release dependency.
set -euo pipefail
root=${1:-/opt/tilecast-edge/current}
unset LD_LIBRARY_PATH LD_PRELOAD
failed=0
checked=0
for required in bin/tilecast-renderer-wpe bin/tilecast-web-renderer-wpe lib/wpe/lib/libWPEWebKit-2.0.so.1; do
  if [ ! -f "$root/$required" ]; then
    echo "runtime closure: the release has no $required" >&2
    failed=1
  fi
done
while IFS= read -r -d '' file; do
  head -c4 "$file" | grep -q $'^\x7fELF' || continue
  checked=$((checked + 1))
  output=$(ldd "$file" 2>&1 || true)
  missing=$(printf '%s\n' "$output" | grep -E '=> not found' || true)
  if [ -n "$missing" ]; then
    failed=1
    while IFS= read -r line; do
      echo "runtime closure: ${file#"$root"/}:${line}" >&2
    done <<< "$missing"
  fi
done < <(find "$root" -type f -print0 | sort -z)
if [ "$failed" -ne 0 ]; then
  echo "runtime closure: FAILED ($checked ELF files checked)" >&2
  exit 1
fi
echo "runtime closure: every library of $checked ELF files resolves"

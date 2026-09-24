#!/usr/bin/env bash
set -euo pipefail

repo_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
files=()
# Public pages below apps/docs/src/content/ follow apps/docs/STYLE.md, not
# ASD-STE100. Exclude them even if one is named README.md.
while IFS= read -r file; do
  files+=("$file")
done < <(
  find "$repo_root" -type f -name '*.md' \( -path "$repo_root/docs/*" -o -path "$repo_root/wiki/*" -o -name 'README.md' \) \
    -not -path '*/.git/*' \
    -not -path "$repo_root/apps/docs/src/content/*" \
    -not -path '*/node_modules/*' \
    -not -path '*/build/*' \
    -print | sort
)

status=0

for file in "${files[@]}"; do
  if ! awk -v file="$file" -v contractions="don't|doesn't|can't|won't|wouldn't|isn't|aren't|it's|that's|there's|you'll|you've|you're|we're|we'll|they're|didn't|shouldn't|couldn't|mustn't|let's" '
    function strip_inline_code(value) {
      while (match(value, /`[^`]*`/)) {
        value = substr(value, 1, RSTART - 1) substr(value, RSTART + RLENGTH)
      }
      return value
    }

    function report(rule, value) {
      printf "%s:%d: %s: %s\n", file, FNR, rule, value
      found = 1
    }

    /^```/ {
      in_fence = !in_fence
      next
    }

    in_fence { next }

    {
      prose = tolower(strip_inline_code($0))
      if (prose ~ /(^|[^[:alnum:]])and\/or([^[:alnum:]]|$)/) {
        report("use a precise conjunction", $0)
      }
      if (prose ~ /(^|[^[:alnum:]])etc\.([^[:alnum:]]|$)/) {
        report("name the complete list", $0)
      }
      if (prose ~ ("(^|[^[:alnum:]])(" contractions ")([^[:alnum:]]|$)")) {
        report("do not use a contraction", $0)
      }
      if (prose ~ /(^|[^[:alnum:]])(simply|obvious|obviously|easily|leverage|utilize|seamless|turnkey|future-proof|state-of-the-art|best-in-class|world-class)([^[:alnum:]]|$)/) {
        report("replace vague or promotional wording", $0)
      }
      if (prose ~ /(^|[^[:alnum:]])as well as([^[:alnum:]]|$)/) {
        report("use a precise conjunction", $0)
      }
    }

    END { exit found ? 1 : 0 }
  ' "$file"; then
    status=1
  fi
done

if [[ "$status" -ne 0 ]]; then
  echo "ASD-STE100 hard-rule check failed." >&2
  exit "$status"
fi

echo "ASD-STE100 hard-rule check passed for ${#files[@]} Markdown files."

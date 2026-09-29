#!/bin/sh
# openapi-compat.sh — fail on definite breaking OpenAPI changes between the
# PR base revision and the working tree. The base defaults to the pull
# request base revision (BASE_SHA, then the pull_request event base, then
# origin/main) so stacked PRs compare against their real base. Uses the
# committed docs/openapi.yaml on both sides: the contract is generated, so
# comparing files compares the pipeline output, not the sources.
set -eu
cd "$(dirname "$0")/../.."
OASDIFF_VERSION="${OASDIFF_VERSION:-v1.32.1}"
BASE="${BASE_SHA:-${PR_BASE_SHA:-}}"
if [ -z "$BASE" ]; then
	if git rev-parse --verify -q origin/main >/dev/null; then
		BASE="origin/main"
	else
		BASE="main"
	fi
fi
BASE_SPEC="$(mktemp)"
HEAD_SPEC="docs/openapi.yaml"
NORM_BASE="$(mktemp)"
NORM_HEAD="$(mktemp)"
trap 'rm -f "$BASE_SPEC" "$NORM_BASE" "$NORM_HEAD"' EXIT INT TERM
if ! git cat-file -e "$BASE:docs/openapi.yaml" 2>/dev/null; then
	echo "openapi-compat: base $BASE is not fetchable here; skipping"
	exit 1
fi
git show "$BASE:docs/openapi.yaml" >"$BASE_SPEC"
if [ ! -s "$BASE_SPEC" ]; then
	echo "openapi-compat: no base contract at $BASE; skipping"
	exit 0
fi
# oasdiff reads nullability through the OpenAPI 3.0 `nullable` keyword and
# does not understand 3.1 `type: [T, "null"]` arrays, so it reports a
# mechanically equivalent 3.1 spelling as "became not nullable" (Redocly,
# in 3.1 mode, rejects `nullable`, so the 3.1 spelling is the committed
# one). Normalize both sides to the 3.0 spelling in temp copies before
# comparing: genuinely removed nullability still reads as a break because
# the normalized `nullable: true` disappears on exactly one side.
node -e '
const fs = require("node:fs");
const YAML = require("yaml");
function norm(node) {
	if (Array.isArray(node)) { node.forEach(norm); return; }
	if (node && typeof node === "object") {
		if (Array.isArray(node.type) && node.type.includes("null")) {
			const rest = node.type.filter((t) => t !== "null");
			if (rest.length === 1 && node.nullable === undefined) {
				node.type = rest[0];
				node.nullable = true;
			}
		}
		Object.values(node).forEach(norm);
	}
}
for (const f of process.argv.slice(1).join(" ").split(",")) {
	const [src, dst] = f.split(">");
	const doc = YAML.parse(fs.readFileSync(src, "utf8"));
	norm(doc);
	fs.writeFileSync(dst, YAML.stringify(doc));
}
' "$BASE_SPEC>$NORM_BASE,$HEAD_SPEC>$NORM_HEAD"
BASE_SPEC="$NORM_BASE"
HEAD_SPEC="$NORM_HEAD"
OASDIFF_BIN="${OASDIFF_BIN:-$(pwd)/.tools/oasdiff}"
if [ ! -x "$OASDIFF_BIN" ]; then
	OS="$(uname -s)"
	ARCH="$(uname -m)"
	case "$OS" in
		Darwin) PLATFORM="darwin_all" ;;
		Linux)
			case "$ARCH" in
				x86_64) PLATFORM="linux_amd64" ;;
				aarch64 | arm64) PLATFORM="linux_arm64" ;;
				*) echo "openapi-compat: unsupported architecture $ARCH" >&2; exit 2 ;;
			esac
			;;
		*) echo "openapi-compat: unsupported OS $OS" >&2; exit 2 ;;
	esac
	VERSION="${OASDIFF_VERSION#v}"
	mkdir -p "$(dirname "$OASDIFF_BIN")"
	TARBALL="$(mktemp)"
	trap 'rm -f "$BASE_SPEC" "$TARBALL"' EXIT INT TERM
	curl -sSL -o "$TARBALL" "https://github.com/oasdiff/oasdiff/releases/download/${OASDIFF_VERSION}/oasdiff_${VERSION}_${PLATFORM}.tar.gz"
	tar -xzf "$TARBALL" -C "$(dirname "$OASDIFF_BIN")"
	chmod +x "$OASDIFF_BIN"
	echo "openapi-compat: downloaded oasdiff ${OASDIFF_VERSION} to .tools (gitignored)"
fi
# Spec corrections documented in oasdiff-err-ignore.md (a handler that
# 400s a missing body cannot break a working client by documenting it).
# Anything not listed there still fails the gate.
"$OASDIFF_BIN" breaking --fail-on ERR --err-ignore scripts/ci/oasdiff-err-ignore.md "$BASE_SPEC" "$HEAD_SPEC"

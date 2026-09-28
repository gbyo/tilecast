#!/bin/sh
# make doctor [area] — area-aware prerequisite diagnostics for Tilecast
# contributors. Reports versions and missing tools; it never installs,
# downloads, or changes anything. Areas: all (default), server,
# dashboard, edge, android, media, docs.
set -u
AREA="${1:-${AREA:-all}}"

want() {
	area="$1"
	name="$2"
	version_cmd="$3"
	case " $AREA " in
		*" all "* | *" $area "*) ;;
		*) return 0 ;;
	esac
	if command -v "$name" >/dev/null 2>&1; then
		version="$(eval "$version_cmd" 2>/dev/null | head -n 1)"
		echo "ok   $name ${version:-installed}"
	else
		echo "MISS $name (needed for: $area)"
	fi
}

want all node "node --version"
want all npm "npm --version"
want server go "go version"
want server docker "docker --version"
want edge docker "docker --version"
want server psql "psql --version"
want edge cargo "cargo --version"
want edge rustc "rustc --version"
want android java "java -version 2>&1"
want media ffmpeg "ffmpeg -version"
want media ffprobe "ffprobe -version"

composite() {
	area="$1"
	label="$2"
	probe="$3"
	case " $AREA " in
		*" all "* | *" $area "*) ;;
		*) return 0 ;;
	esac
	if out="$(eval "$probe" 2>/dev/null | head -n 1)" && [ -n "$out" ]; then
		echo "ok   $label $out"
	else
		echo "MISS $label (needed for: $area)"
	fi
}

composite server compose "docker compose version"
composite edge compose "docker compose version"
composite dashboard playwright "npx --no-install playwright --version"

case " $AREA " in
	*" all "* | *" android "*)
		if [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME" ]; then
			echo "ok   ANDROID_HOME $ANDROID_HOME"
		else
			echo "MISS ANDROID_HOME (needed for: android)"
		fi
		;;
esac

case " $AREA " in
	*" all "* | *" server "*)
		if [ -n "${TEST_DATABASE_URL:-}" ]; then
			echo "ok   TEST_DATABASE_URL set (server integration tests run)"
		else
			echo "MISS TEST_DATABASE_URL (needed for: server integration tests; unit tests run without it)"
		fi
		;;
esac

echo "area: $AREA (run 'make doctor AREA=<server|dashboard|edge|android|media|docs>' to narrow)"

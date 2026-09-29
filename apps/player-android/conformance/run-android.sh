#!/usr/bin/env bash
# Android Player Runtime conformance driver.
#
# Invoked by packages/player-runtime/conformance/run.mjs --engine android.
# It never boots or manages an emulator: attach one device (or a running
# emulator, API 34+ recommended, UTC timezone, mdpi for scale-1 screenshots)
# and this script assembles the test APKs, pushes the fixture inputs, runs
# the instrumentation suite once, and pulls result.json plus screenshots
# back into the per-fixture layout compare.mjs expects.
#
#   run-android.sh --fixtures DIR --host-script FILE --cas-root DIR \
#     --out DIR [--only a,b]
#
# --fixtures/--out is the engine directory run.mjs prepared: each selected
# fixture already has fixture.json, and result.json/<checkpoint>.png land
# beside it.
set -euo pipefail

FIXTURES=""; HOST_SCRIPT=""; CAS_ROOT=""; OUT=""; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fixtures) FIXTURES="$2"; shift 2 ;;
    --host-script) HOST_SCRIPT="$2"; shift 2 ;;
    --cas-root) CAS_ROOT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    *) echo "run-android: unknown argument $1" >&2; exit 64 ;;
  esac
done
if [ -z "$FIXTURES" ] || [ -z "$HOST_SCRIPT" ] || [ -z "$CAS_ROOT" ] || [ -z "$OUT" ]; then
  echo "run-android: --fixtures, --host-script, --cas-root and --out are required" >&2
  exit 64
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$HERE/.."
APP_ID="org.tilecast.player"
TEST_ID="$APP_ID.test"
DEVICE_BASE="/sdcard/Android/data/$APP_ID/files/conformance"

command -v adb >/dev/null || { echo "run-android: adb is not on PATH" >&2; exit 69; }
[ -f "$HOST_SCRIPT" ] || { echo "run-android: host script missing: $HOST_SCRIPT" >&2; exit 66; }
[ -d "$CAS_ROOT" ] || { echo "run-android: CAS root missing: $CAS_ROOT" >&2; exit 66; }
DEVICES="$(adb devices | awk 'NR>1 && $2=="device" {print $1}')"
if [ "$(echo "$DEVICES" | wc -l)" -ne 1 ]; then
  echo "run-android: exactly one adb device is required (got: $DEVICES)" >&2
  exit 69
fi
# Screenshots compare at device scale 1: the display must be mdpi.
DENSITY="$(adb shell wm density | grep -o '[0-9]*' | head -n 1)"
if [ "$DENSITY" != "160" ]; then
  echo "run-android: display density must be 160 (mdpi) for scale-1 screenshots, got: $DENSITY" >&2
  echo "run-android: e.g. adb shell wm size 1280x720 && adb shell wm density 160" >&2
  exit 69
fi

echo "run-android: assembling test APKs (syncs the exact dist/runtime artifact)"
(cd "$PROJECT" && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest --console=plain -q)

APK="$(ls "$PROJECT/app/build/outputs/apk/debug/app-debug.apk")"
TEST_APK="$(ls "$PROJECT/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk")"
adb install -r -t "$APK" >/dev/null
adb install -r -t "$TEST_APK" >/dev/null

echo "run-android: pushing fixtures, host script, and media store"
adb shell "rm -rf $DEVICE_BASE && mkdir -p $DEVICE_BASE/in $DEVICE_BASE/cas" >/dev/null
adb push "$HOST_SCRIPT" "$DEVICE_BASE/in/conformance-host.js" >/dev/null
adb push "$CAS_ROOT/." "$DEVICE_BASE/cas/" >/dev/null
for fixture in "$FIXTURES"/*/fixture.json; do
  name="$(basename "$(dirname "$fixture")")"
  if [ -n "$ONLY" ] && ! echo ",$ONLY," | grep -q ",$name,"; then continue; fi
  adb push "$fixture" "$DEVICE_BASE/in/$name.fixture.json" >/dev/null
done

echo "run-android: recording engine versions"
{
  echo "webview:"
  adb shell dumpsys webviewupdate | grep -E "Current|Package" || true
  echo "device:"
  adb shell getprop ro.build.version.sdk
  adb shell getprop ro.product.model
} > "$OUT/android-engine-versions.txt" || true

echo "run-android: running instrumentation"
ARGS="-e conformanceRoot $DEVICE_BASE"
if [ -n "$ONLY" ]; then ARGS="$ARGS -e only $ONLY"; fi
# shellcheck disable=SC2086
adb shell am instrument -w $ARGS \
  -e class org.tilecast.player.conformance.PlayerRuntimeConformanceTest \
  "$TEST_ID/androidx.test.runner.AndroidJUnitRunner"

echo "run-android: pulling results"
TMP_OUT="$(mktemp -d)"
adb pull "$DEVICE_BASE/out/." "$TMP_OUT/" >/dev/null
for dir in "$TMP_OUT"/*/; do
  name="$(basename "$dir")"
  mkdir -p "$OUT/$name"
  cp "$dir/result.json" "$dir"/*.png "$OUT/$name/" 2>/dev/null || true
done
rm -rf "$TMP_OUT"
echo "run-android: done"

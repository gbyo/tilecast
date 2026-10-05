#!/usr/bin/env bash
set -euo pipefail

: "${TILECAST_ANDROID_KEYSTORE_PATH:?Set TILECAST_ANDROID_KEYSTORE_PATH}"
: "${TILECAST_ANDROID_KEYSTORE_PASSWORD:?Set TILECAST_ANDROID_KEYSTORE_PASSWORD}"
: "${TILECAST_ANDROID_KEY_ALIAS:?Set TILECAST_ANDROID_KEY_ALIAS}"
: "${TILECAST_ANDROID_KEY_PASSWORD:?Set TILECAST_ANDROID_KEY_PASSWORD}"
: "${TILECAST_UPDATE_MANIFEST_PRIVATE_KEY:?Set TILECAST_UPDATE_MANIFEST_PRIVATE_KEY}"

CHANNEL="${TILECAST_RELEASE_CHANNEL:-stable}"
NOTES="${TILECAST_RELEASE_NOTES:-Tilecast Player release}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${TILECAST_RELEASE_OUTPUT:-$ROOT/release-output}"
mkdir -p "$OUTPUT"

cd "$ROOT/apps/player-android"
./gradlew clean assembleRelease
APK="$ROOT/apps/player-android/app/build/outputs/apk/release/app-release.apk"
test -f "$APK"
# 16 KB page-size compatibility is a release gate: every bundled native
# library must carry 16 KB ELF alignment and valid ZIP placement.
python3 "$ROOT/apps/player-android/ci/check-native-alignment.py" "$APK"
APKSIGNER="${ANDROID_HOME:?ANDROID_HOME is required}/build-tools/${ANDROID_BUILD_TOOLS_VERSION:-35.0.0}/apksigner"
BUILD_TOOLS="$(dirname "$APKSIGNER")"
AAPT="$BUILD_TOOLS/aapt"

# Capture complete command output before parsing it. Early-closing consumers such
# as `head` can send SIGPIPE upstream and fail an otherwise successful release
# script when `set -o pipefail` is enabled.
VERIFY_OUTPUT="$("$APKSIGNER" verify --verbose --print-certs "$APK" 2>&1)"
printf '%s\n' "$VERIFY_OUTPUT"
BADGING_OUTPUT="$("$AAPT" dump badging "$APK")"

GRADLE_VERSION_CODE="$(sed -n 's/.*versionCode = \([0-9][0-9]*\).*/\1/p' app/build.gradle.kts)"
GRADLE_VERSION_NAME="$(sed -n 's/.*versionName = "\([^"]*\)".*/\1/p' app/build.gradle.kts)"
PACKAGE_METADATA="${BADGING_OUTPUT%%$'\n'*}"

# The package line also contains fields such as compileSdkVersionCodename.
# Anchor each expression to the leading package fields so a greedy `.*name=`
# cannot accidentally return the SDK codename as the application ID.
APPLICATION_ID="$(printf '%s\n' "$PACKAGE_METADATA" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")"
VERSION_CODE="$(printf '%s\n' "$PACKAGE_METADATA" | sed -n "s/^package: name='[^']*' versionCode='\([^']*\)'.*/\1/p")"
VERSION_NAME="$(printf '%s\n' "$PACKAGE_METADATA" | sed -n "s/^package: name='[^']*' versionCode='[^']*' versionName='\([^']*\)'.*/\1/p")"
MINIMUM_SDK="$(printf '%s\n' "$BADGING_OUTPUT" | sed -n "s/sdkVersion:'\([^']*\)'/\1/p")"
APK_SIZE="$(wc -c < "$APK" | tr -d ' ')"
if command -v sha256sum >/dev/null 2>&1; then
	APK_SHA="$(sha256sum "$APK" | awk '{print $1}')"
else
	APK_SHA="$(shasum -a 256 "$APK" | awk '{print $1}')"
fi
CERT_SHA="$(printf '%s\n' "$VERIFY_OUTPUT" | bash "$ROOT/scripts/extract-apksigner-sha256.sh")"

require_equal() {
	local label="$1"
	local actual="$2"
	local expected="$3"
	if [ "$actual" != "$expected" ]; then
		printf '%s mismatch: expected %s, got %s\n' "$label" "$expected" "${actual:-<empty>}" >&2
		exit 1
	fi
}

require_equal "applicationId" "$APPLICATION_ID" "org.tilecast.player"
require_equal "versionCode" "$VERSION_CODE" "$GRADLE_VERSION_CODE"
require_equal "versionName" "$VERSION_NAME" "$GRADLE_VERSION_NAME"
require_equal "minimumSdk" "$MINIMUM_SDK" "23"
if ! [[ "$CERT_SHA" =~ ^[0-9a-f]{64}$ ]]; then
	printf 'Unable to read a valid SHA-256 signing certificate digest from apksigner output: %s\n' "${CERT_SHA:-<empty>}" >&2
	exit 1
fi

cp "$APK" "$OUTPUT/tilecast-player.apk"
jq -n --argjson versionCode "$VERSION_CODE" --arg versionName "$VERSION_NAME" --arg channel "$CHANNEL" --argjson minimumSdk "$MINIMUM_SDK" --argjson size "$APK_SIZE" --arg sha "$APK_SHA" --arg cert "$CERT_SHA" --arg notes "$NOTES" '{schemaVersion:1,product:"tilecast-player",applicationId:"org.tilecast.player",versionCode:$versionCode,versionName:$versionName,channel:$channel,minimumSdk:$minimumSdk,apkAssetName:"tilecast-player.apk",apkSizeBytes:$size,apkSha256:$sha,signingCertificateSha256:$cert,releaseNotes:$notes}' > "$OUTPUT/tilecast-player-update.json"
openssl pkeyutl -sign -rawin -inkey "$TILECAST_UPDATE_MANIFEST_PRIVATE_KEY" -in "$OUTPUT/tilecast-player-update.json" | openssl base64 -A > "$OUTPUT/tilecast-player-update.json.sig"
openssl pkeyutl -verify -rawin -pubin -inkey "${TILECAST_UPDATE_MANIFEST_PUBLIC_KEY_FILE:?Set TILECAST_UPDATE_MANIFEST_PUBLIC_KEY_FILE}" -in "$OUTPUT/tilecast-player-update.json" -sigfile <(openssl base64 -d -A -in "$OUTPUT/tilecast-player-update.json.sig")
echo "Created signed Tilecast Player $VERSION_NAME ($VERSION_CODE) release assets in $OUTPUT"

#!/usr/bin/env bash
# Guards the host/Studio boundary described in docs/ios-app.md.
#
# Studio owns its routes and its navigation. A Studio destination reaches
# the app through the navigation catalog Studio sends, never a Swift list,
# so that adding a Studio page needs no iOS change. App sources therefore
# must not name Studio routes or destinations. Tests may use them as data.
set -euo pipefail
cd "$(dirname "$0")/.."

sources=(Tilecast TilecastKit/Sources)
bridge=TilecastKit/Sources/TilecastCore/Bridge
# Icon tokens are a visual vocabulary shared with Studio, not destinations.
icons=TilecastKit/Sources/TilecastCore/Navigation/NavigationIconImages.gen.swift

routes='screens|display-groups|media|widgets|data-sources|playlists|layouts|campaigns|schedules|plugins|activity|settings|users|preferences|overview|fleet|assets|groups|account'
if grep -rnE "\"/($routes)([/?\"]|$)" "${sources[@]}"; then
  echo "check-architecture: Swift sources name a Studio route. Use navigation metadata from Studio instead." >&2
  exit 1
fi

# "groups" is also a protocol field, so it is left out here.
destinations='overview|screens|display-groups|media|widgets|data-sources|playlists|layouts|campaigns|schedules|plugins|activity|settings|fleet'
if grep -rnE --include='*.swift' "\"($destinations)\"" "${sources[@]}" | grep -v "^$icons:"; then
  echo "check-architecture: Swift sources name a Studio destination. Destination ids are opaque; render the catalog." >&2
  exit 1
fi

# The app knows only the presentation root. Studio owns every child route,
# so a new presentation needs no Swift change.
if grep -rnE "__native/modal/[A-Za-z0-9]" "${sources[@]}"; then
  echo "check-architecture: Swift sources name a presentation route. Only the root /__native/modal is allowed." >&2
  exit 1
fi

# Page scripting belongs to the versioned native bridge alone.
if grep -rnE "WKUserContentController|WKScriptMessageHandler|addScriptMessageHandler|userContentController|callJavaScript" \
  "${sources[@]}" | grep -v "^$bridge/"; then
  echo "check-architecture: page scripting belongs to the native bridge in $bridge." >&2
  exit 1
fi

# The bridge answers messages; it never injects scripts, uses a handler
# without replies, or evaluates arbitrary source.
if grep -rnE "WKUserScript|evaluateJavaScript|WKScriptMessageHandler([^W]|$)" "${sources[@]}"; then
  echo "check-architecture: no user scripts, evaluateJavaScript, or reply-less message handlers. See docs/ios-app.md." >&2
  exit 1
fi

# Native code calls Studio through one static receiver script. Messages are
# arguments, never script source.
if grep -rnE "callJavaScript\(" "$bridge" | grep -v "callJavaScript(Self.receiverScript,"; then
  echo "check-architecture: callJavaScript may only run StudioBridge.receiverScript." >&2
  exit 1
fi

# The bridge carries presentation and navigation only: no credentials,
# cookies, or file access.
if grep -rnE "SecItem|kSec[A-Z]|HTTPCookie|httpCookieStore|FileManager|URLSession|UserDefaults|NativeAuthSession" "$bridge" TilecastKit/Sources/TilecastCore/Presentation TilecastKit/Sources/TilecastCore/Web/PresentationPage.swift; then
  echo "check-architecture: the native bridge must not reach credentials, cookies, or files." >&2
  exit 1
fi

# One ATS exception only; never arbitrary loads.
if grep -rnE "NSAllowsArbitraryLoads|NSExceptionAllowsInsecureHTTPLoads|NSExceptionDomains" Tilecast; then
  echo "check-architecture: only NSAllowsLocalNetworking is permitted. See docs/ios-app.md." >&2
  exit 1
fi

# Certificate validation is never bypassed.
if grep -rnE "\.useCredential|URLCredential\(trust|SecTrustSetExceptions|serverTrust.*performDefaultHandling" "${sources[@]}"; then
  echo "check-architecture: TLS trust must use default system evaluation." >&2
  exit 1
fi
echo "Architecture boundaries hold."

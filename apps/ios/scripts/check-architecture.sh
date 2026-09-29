#!/usr/bin/env bash
# Guards the host/Studio boundary described in docs/ios-app.md.
#
# Studio owns its routes. A Studio destination must reach the app through
# server-provided navigation metadata, never a Swift list, so that adding a
# Studio page needs no iOS change. App sources therefore must not name
# Studio routes. Tests may use paths as data.
set -euo pipefail
cd "$(dirname "$0")/.."

routes='screens|display-groups|media|widgets|data-sources|playlists|layouts|campaigns|schedules|plugins|activity|settings|users|preferences|overview|fleet'
if grep -rnE "\"/($routes)([/?\"]|$)" Tilecast TilecastKit/Sources; then
  echo "check-architecture: Swift sources name a Studio route. Use navigation metadata from Studio instead." >&2
  exit 1
fi

# The app never exposes a native credential to page JavaScript. Until the
# bridge exists, nothing may inject scripts or message handlers.
if grep -rnE "WKUserScript|addScriptMessageHandler|WKScriptMessageHandler" Tilecast TilecastKit/Sources; then
  echo "check-architecture: page scripting belongs to the versioned native bridge (Milestone 2)." >&2
  exit 1
fi

# One ATS exception only; never arbitrary loads.
if grep -rnE "NSAllowsArbitraryLoads|NSExceptionAllowsInsecureHTTPLoads|NSExceptionDomains" Tilecast; then
  echo "check-architecture: only NSAllowsLocalNetworking is permitted. See docs/ios-app.md." >&2
  exit 1
fi

# Certificate validation is never bypassed.
if grep -rnE "\.useCredential|URLCredential\(trust|SecTrustSetExceptions|serverTrust.*performDefaultHandling" TilecastKit/Sources Tilecast; then
  echo "check-architecture: TLS trust must use default system evaluation." >&2
  exit 1
fi
echo "Architecture boundaries hold."

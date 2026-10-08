# Tilecast Browser Companion

An optional MV3 Chromium extension that contributes Player
capabilities to the Browser Player. It is a Companion, not a plugin
host: it never executes Marketplace packages, and it holds no generic
`chrome.*`, tabs, fetch, or script capability.

## Setup

1. Open the Browser Player at its `/player/*` page.
2. Invoke the extension. The popup offers to connect exactly the
   visible player origin.
3. Approve Chrome's permission prompt for that origin. The grant
   persists for that origin only — never for every site.
4. Reload the player page. The bridge handshakes and the Companion's
   providers appear in the capability report.

Disconnecting from the popup removes the origin grant, unregisters
the bridge, and drops the connection. The Browser Player stays fully
usable without a Companion.

## Layout

- `manifest.json`: MV3 manifest. Storage, scripting, and activeTab
  permissions; optional host permission for http/https; no static
  content scripts; no Native Messaging.
- `src/background.ts`: the ephemeral service worker. Origin and
  connection configuration persist in extension storage; listeners
  register synchronously; state rebuilds from storage on every wake.
  The worker revalidates everything the bridge relays.
- `src/content.ts`: the isolated bridge, registered only on a granted
  origin under `/player/*` and only in the top frame. It relays
  validated messages and holds no privilege of its own.
- `src/popup.ts` + `popup.html`: the per-origin grant flow.
- `src/providers.ts`: the provider table. Empty in this foundation:
  the first real Companion capability ships with an actual product
  need, and tests register fakes to prove the bridge.
- `packages/companion-protocol`: the versioned, bounded, data-only
  page protocol both sides validate.

## Protocol

Page and bridge speak `tilecast-companion` messages over
`window.postMessage` on the page's own origin: hello, handshake,
describe/described, invoke/result, bye. The worker answers describe
from its provider table and invokes only described capabilities. Every
field is bounded; anything unexpected is dropped silently.

## Future shape

If a future capability needs native functionality, the path is
Browser Player → Companion provider → extension service worker →
Native Messaging adapter → Tilecast Companion daemon. Native
functionality still surfaces as ordinary versioned Tilecast Player
capabilities; packages never receive raw Native Messaging access. No
Native Messaging permission or daemon ships in this foundation.

## Build and test

```sh
npm run build --workspace @tilecast/browser-companion
npm run test --workspace @tilecast/browser-companion
```

Load `apps/browser-companion/dist/` as an unpacked extension.

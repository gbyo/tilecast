# Browser Companion architecture

The Tilecast Browser Companion (`apps/browser-companion`) is an
optional MV3 Chromium extension that contributes Player capabilities
to the Browser Player. It is not a plugin host: it never executes
Marketplace packages, and it holds no generic `chrome.*`, tabs,
fetch, or script capability.

## Trust boundaries

Three principals meet here, and only two trust each other partially.
The Browser Player page trusts the extension only after the user
grants its origin, and only for versioned capability messages. The
content bridge is an untrusted relay: the service worker revalidates
everything it forwards. The service worker trusts the bridge for
nothing except transport. Packages never touch this path directly:
they invoke versioned Player capabilities through the server, which
verifies the reported capability before queueing anything.

## Grant flow

The connection needs an explicit per-origin grant. The user opens the
Browser Player, invokes the extension action, and approves Chrome's
permission prompt for exactly that Tilecast origin. The request names
one origin pattern (`https://signage.example.org/*`): no wildcard
grant, no access to every site. On approval the worker persists the
origin in extension storage and registers the isolated content bridge
for `/player/*` on that origin only. The player page reloads and the
bridge handshakes.

The extension never uses `externally_connectable` for arbitrary
self-hosted servers and adds no Native Messaging permission or
daemon. Disconnecting from the popup removes the origin grant,
unregisters the bridge, and drops the connection. The Browser Player
stays fully usable without a Companion, and removing one never breaks
playback.

## Protocol

Page and bridge speak `tilecast-companion` messages over
`window.postMessage` on the page's own origin
(`packages/companion-protocol`): hello, handshake, describe/described,
invoke/result, bye. Protocol version is 1. Both sides validate the
top-level frame, the same-origin sender, the player path, the
protocol version, the connection identity, the message shape, and the
payload bounds: 32 KiB per message, 4 KiB per invoke input, 128
characters per identifier. Anything unexpected is dropped silently.

The content script runs isolated, top-frame only, on a granted origin
under `/player/*`. It relays validated page messages to the service
worker over `chrome.runtime` messaging and posts validated answers
back. It touches no tabs, no fetch, and no script execution.

The service worker answers describe from its provider table and
invokes only described capabilities. It validates the granted origin,
the `/player/*` sender path, the live connection, the tab binding,
the operation membership, and the payload bounds before any provider
runs. Provider answers are bounded and typed; a failure becomes a
typed result, never a raw exception.

The service worker is ephemeral by design. Origin and connection
configuration persist in extension storage, listeners register
synchronously at module load, and state rebuilds from storage on
every wake. Nothing depends on a global variable surviving.

## Providers

The provider table is empty in this foundation: the first real
Companion capability ships with an actual product need. Providers
describe versioned Player capabilities and invoke typed operations;
they never see extension APIs. Tests register fakes to prove the
bridge on both sides.

If native functionality ever needs a daemon, the path stays ordinary:
Browser Player to Companion provider to extension service worker to
Native Messaging adapter to Tilecast Companion daemon. Native
functionality still surfaces as versioned Tilecast Player
capabilities, and packages never receive raw Native Messaging access.
The Offscreen API is not part of the capability ABI; it may serve as
an internal provider detail if a future capability genuinely needs
DOM, media, WebRTC, or geolocation work.

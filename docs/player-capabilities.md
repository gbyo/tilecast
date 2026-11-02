# Player capabilities

Player capabilities generalize the Display Control pattern into one
versioned cross-player model. Hosts report what they actually support.
Granted packages invoke typed operations. The server maps operations
to the persistent Player command system after verifying the target
screen reports the matching capability. No decision branches on a
platform name.

## Registry

`packages/player-contracts/player-capabilities.json` is the canonical
registry: data-only definitions of every Player capability. Each entry
carries an `id`, a `version`, human-readable metadata, the closed
provider vocabulary, and its operations. Each operation carries an
input schema and the command table that maps validated inputs to
persistent Player commands. A `when` clause lists the discriminator
fields selecting its command; an empty clause matches every valid
input. The queued payload is the operation input without the matched
discriminators, and it must validate under the command's own rules.

The registry holds five capabilities at version 1: `display.power`,
`display.input`, `display.volume`, `display.mute`, and
`display.brightness`. Providers are `hdmi_cec`, `ddc_ci`, `network`,
and `rs232`.

The server package `internal/playercaps` mirrors the registry in typed
Go and pins it with a drift test that replays the canonical file, so
the JSON stays the single source of truth without a runtime file
dependency. Native hosts share the wire vocabulary in
`player-types::player_caps`. The Browser Player reads the canonical
file at build time.

## Status

Players report the generic status in the heartbeat as
`playerCapabilities`. Studio shows the report in the screen
diagnostics. The reliability endpoint carries the stored value. Legacy
display-control wire fields stay unchanged; reporters populate both
representations from the same probe. See [Player pairing and
connection protocol](player-protocol.md) for the heartbeat contract.

## Package service

The `players.display-control@1` package service exposes one method per
Player Capability operation. A call carries the target `screenId` and
the operation `input`. The server verifies the grant, the Studio role,
the operation schema, the target screen, the reported
capability/version, and ordinary command eligibility before queueing
through the single persistent command path. Guests never name a
command type or touch the queue. Screens whose players predate the
generic report still qualify through their legacy display-control map.
See [Extension packages](packages.md).

## Browser providers

The Browser Player aggregates a small provider registry
(`apps/player-web/src/capability-providers.ts`). Each provider
describes its current capability set and invokes typed operations. The
heartbeat repeats the merged set, so a removed provider disappears
promptly. Persistent commands outside the static browser matrix route
through the registry when a provider covers them; anything else keeps
the standard `unsupported_command` result. The bare Browser Player
ships no providers and stays fully usable alone. Tests use fake
providers to prove the bridge. No meaningless public capability ships
to demonstrate it.

## Browser Companion

The Tilecast Browser Companion (`apps/browser-companion`) is an
optional MV3 Chromium extension that contributes additional providers
to the Browser Player. It is not a plugin host and never executes
Marketplace packages.

The connection needs an explicit per-origin grant. The user opens the
Browser Player, invokes the extension, and approves Chrome's
permission prompt for exactly that Tilecast origin. The extension
registers its isolated content bridge for `/player/*` on that origin
only. It never requests persistent access to every site, never uses
`externally_connectable` for arbitrary self-hosted servers, and adds
no Native Messaging permission or daemon.

Page and bridge speak a versioned, bounded, data-only protocol over
`window.postMessage` on the page's own origin: hello, handshake,
describe/described, invoke/result, bye (`packages/companion-protocol`).
Both sides validate the top-level frame, the granted origin, the
player path, the protocol version, the connection identity, the
message shape, and the payload bounds. The content script is not a
trust boundary: the service worker revalidates everything it relays.
No generic `chrome.*`, tabs, fetch, or script RPC exists.

The service worker is ephemeral. Origin and connection configuration
persist in extension storage, listeners register synchronously, and
state rebuilds from storage on every wake. The provider table is empty
in this foundation: the first real Companion capability ships with an
actual product need.

If native functionality ever needs a daemon, the path stays ordinary:
Browser Player to Companion provider to extension service worker to
Native Messaging adapter to Tilecast Companion daemon. Native
functionality still surfaces as versioned Tilecast Player
capabilities, and packages never receive raw Native Messaging access.
The Offscreen API is not part of the capability ABI; it may serve as
an internal provider detail if a future capability genuinely needs
DOM, media, WebRTC, or geolocation work.

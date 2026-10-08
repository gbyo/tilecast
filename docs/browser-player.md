# Browser Player architecture

Browser Player is experimental. Tilecast does not claim that it is supported on Chrome or Microsoft Edge.
Only the bundled Playwright Chromium has run the end-to-end tests.
The implementation must meet this contract before release.
See [Implementation status](#implementation-status) for what is and is not qualified.

## Ownership

| Layer                    | Responsibility                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| Server                   | Screen identity, browser sessions, recovery, manifests, configuration, scheduling authority |
| Browser Host             | Browser lifecycle, networking, verified local content, authentication, capabilities         |
| Player Runtime           | Visual presentation and playback                                                            |
| Presentation Model       | Pure shared presentation decisions                                                          |
| Presentation resolver    | Pure shared lookup of the selected content, its exact media, and the Runtime messages       |
| Player Core              | Native durable orchestration and offline scheduling                                         |
| Future browser extension | Optional providers for additional host capabilities                                         |

`apps/player-web` must not become a TypeScript clone of `player-core`.
The Browser Host installs `TilecastRuntimeHostV1` before the production Runtime starts.
It must load the same Runtime artifact as native hosts.
It must not import Studio application code.

## Presentation resolution

The Server selects the content for a Browser Player. The Host copies that selection.
The Host does not evaluate schedules, takeovers, or active hours.
The shared presentation resolver in `@tilecast/player-runtime/projection` is a pure function.
It does no I/O and has no knowledge of the Host that calls it.
It is not a schedule engine. It compares no times and ranks nothing.

The Host supplies these inputs:

- the verified manifest and the accepted Player configuration;
- the Server selection and the corrected Server instant;
- the Server `nextEvaluationAt` boundary;
- the live Runtime support report.

Resolution has two steps:

1. `planPresentation` names the selected playlist or Layout. It returns the exact resource closure, compatibility, selection facts, and `validUntil`.
2. `realizePresentation` returns the Runtime presentation, projection context, and plugin snapshot. The Host first authorizes a media binding for every required resource.

The resource closure comes from the Runtime projector itself.
The resolver runs the projector with placeholder bindings and collects the placeholders it emits.
Playlist media, Layout media, Widget media, Website fallback images, the branding logo, and plugin media enter the closure only when the presentation uses them.
The closure cannot differ from what the Runtime requests.

`validUntil` is the first instant at which an availability window changes or the Server must select again.
The Host plans again at that instant.

Status surfaces, branded copy, Website defaults, and playback defaults come from the accepted Player configuration through the same resolver.
The Host supplies only its own connection wording.
Behavior follows Runtime capabilities. It never follows a platform name.
`scripts/ci/browser-player-architecture.test.mjs` fails when `apps/player-web` makes a presentation decision or when the Runtime branches on a host name.

## Media authorization

Runtime consumes host-authorized media bindings.
The compatibility projector rejects a missing binding.
Runtime does not construct a native media URL for plugin surfaces.
An optional host resolver supports native activation-bound media protocols.
Other hosts supply explicit bindings in each plugin snapshot.
The native media handler remains the authorization authority for its protocol.

Browser Player downloads each complete object to an OPFS partial file.
It checks the expected size and SHA-256 before publication.
IndexedDB records the verified object only after publication completes.
A crash can leave an orphan object but cannot authorize unverified bytes.
Startup reconciliation must remove partial and orphan objects.
The active activation pins every required object.
Eviction removes only unpinned objects in deterministic order.
The media layer validates an activation grant before it serves bytes.
It serves a single byte range from a complete verified local object.
It rejects invalid ranges with `416`.
It never publishes a network `206` as a complete object.

## Authentication boundary

Browser Player must use an independent HttpOnly session cookie.
Each slot has its own cookie name under the `__Host-tilecast_player_` prefix.
HTTP requests select the slot with `X-Tilecast-Player-Slot`.
The WebSocket uses the non-secret `browserSlot` query parameter.
The Server checks that the selected session belongs to the requested slot.
It must not use Studio sessions or store permanent bearer credentials in JavaScript storage.
Each installation keeps a non-extractable P-256 private key in IndexedDB.
The Server verifies a single-use challenge before session renewal.
The challenge response contains `nonce`, `message`, and `expiresAt`.
The device key signs the exact `message`:
`tilecast-browser-player-v1:<slotId>:<bindingId>:<nonce>`.
The Server rebuilds this message from the slot, the binding, and the nonce.
It never accepts signing text from the client.
The Host also refuses to sign a message that names another slot or binding.
A signature over the nonce alone is not valid.
The managed launch fragment contains a recovery capability for one Screen.
The bootstrap removes the fragment before it parses the secret.
It must keep the secret in memory only.
Recovery replaces the active binding epoch and invalidates previous bindings.
Cookie `Path` is not a security boundary.

## Browser lifecycle and offline behavior

The Browser Host holds an exclusive Web Lock for the active slot.
A second tab must not connect as a Player.
Hidden, frozen, unreconciled, or revoked instances cannot report meaningful playback evidence.
A wall-clock or monotonic-clock discontinuity requires reconciliation and a new timing anchor.
Timer delay alone does not establish a clock discontinuity.

### Startup and offline cold start

Five facts decide whether the Host may show content and report playback.
The Host keeps them separate:

| Fact                        | Meaning                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `serverBindingConfirmed`    | The Server accepted this installation, slot, and binding since the last discontinuity.      |
| `selectionCurrent`          | The Host reconciled with the Server selection since the last discontinuity.                 |
| `localActivationAuthorized` | The committed activation matches the Server, slot, and binding, and every resource matches. |
| `runtimeActivationAccepted` | The Runtime accepted the activation that the Host sent last.                                |
| `foregroundEligible`        | The page is visible and not frozen.                                                         |

Startup order is the same online and offline:

1. Acquire the slot Web Lock.
2. Load the saved browser identity.
3. Revalidate the last committed activation. The Host hashes every resource again.
4. Start the exact shared Runtime and send the restored activation.
5. Contact the Server. Check the installation identity. Authenticate, renew, or recover the binding.
6. Reconcile the manifest, the configuration, and the Server selection.
7. Prepare and atomically activate newer content when needed.

If the Server is unreachable, the Host stops at step 4.
The Runtime continues the last fully prepared activation.
The Host does not evaluate a future schedule.
The Host does not report meaningful playback evidence.
It retries step 5 after 2 seconds, then after longer intervals up to 15 seconds.
A browser `online` event or a visible page ends the wait at once.

When the Server answers, the Host acts on the answer:

- An installation identity that changed, a revoked binding, or a replaced binding removes the local activation, its grants, and its pins.
- A disabled Screen stops local playback. The Host keeps the stored content.
- A current binding leads to reconciliation with the Server selection.

A restored activation must match the saved server installation, slot, and binding.
One missing, resized, or corrupt resource discards the whole activation.
If no valid activation exists, the Host shows the connection surface.

During an outage, Browser Player continues the last verified activation.
Runtime continues local playlist advancement.
Browser Player does not evaluate future schedules offline.
The Server selects the current presentation when connection resumes.

## Local media

Browser Player prepares only the resource closure of the selected activation.
It does not download unrelated manifest assets.
Each object has one full SHA-256 check when it is downloaded and committed.
A page load rehashes the active objects once, at restoration.
A Range request does not hash the object again.
It checks the object metadata and stored size, then reads only the requested bytes.
Serving a range costs time in proportion to the bytes served.

Trust has four levels:

1. Stored metadata says the object is verified.
2. Restoration or commit verified the bytes in this page load. This marks the grants trusted.
3. A live, trusted activation grant authorizes the service worker request.
4. The Range request reads the requested bytes.

Metadata without bytes, or with a different size, invalidates the object.
Bytes without metadata are removed during reconciliation.

## Sandbox frames

Browser Player prepares each Widget frame like other objects.
It downloads the frame document, checks size and SHA-256, and pins the bytes.
Activation mints one frame grant per frame, separate from media grants.
A media grant never serves the frame route, and a frame grant never serves media.
The grant usage is fixed when the grant is minted.

The Runtime navigates a bare iframe to the grant URL.
A service worker never sees a sandboxed iframe navigation, so the sandbox attribute would bypass the verified store.
The served frame response carries the `sandbox` directive instead.
The document runs at an opaque origin and completes the production handshake.
The shell policy allows same-origin frame navigations on any scheme.
Navigations carry no client, so the grant capability and its active-trusted state authorize them.
`fetch()` and media keep the client authorization roundtrip.
See [Widget sandbox spike](widget-sandbox-spike.md) for the measured behavior.

## Installation identity

Each managed Browser Player has its own install manifest at `/player/<slot>/manifest.webmanifest`.
Its `id`, `start_url`, and `scope` are the stable slot route `/player/<slot>/`.
An installed Browser Player reopens as the same Screen.
The slot ID is not secret.
The recovery capability is never part of the start URL.
It remains in the one-time launch fragment, and the Host removes it before it parses it.
The unmanaged `/player/` route keeps its own manifest and identity.

## Capabilities

`apps/player-web/capabilities.json` is the one source of this matrix.
`node scripts/generate-browser-capabilities.mjs` generates the Host, server, Studio, and these tables from it.
`npm run player-contracts:check` fails when a generated file is stale.

<!-- browser-capabilities:start -->

| Capability                                | Browser Player v1 | Detail                                                                                                                                                                |
| ----------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image and video playback                  | Supported         | The shared Player Runtime plays them.                                                                                                                                 |
| Playlists and transitions                 | Supported         | The shared Player Runtime advances items and runs transitions.                                                                                                        |
| Layouts                                   | Supported         | Layout zones render in the shared Player Runtime.                                                                                                                     |
| Widgets                                   | Supported         | Widgets and Widget components render in the shared Player Runtime.                                                                                                    |
| Content schedules chosen by the server    | Supported         | The server selects the content. The Browser Player does not rank schedules.                                                                                           |
| Takeovers                                 | Supported         | The server selects a Takeover like any other content.                                                                                                                 |
| Active hours and rest                     | Supported         | The shared active-hours policy runs in the browser, including while the server is unreachable. The browser shows the rest surface. It does not power off the display. |
| Last verified content offline             | Supported         | The last completely prepared activation continues while the server is unreachable.                                                                                    |
| Choosing future content schedules offline | Not supported     | The server chooses content. The Browser Player waits for the server to choose again.                                                                                  |
| Persistent media cache                    | Conditional       | Supported when the browser grants persistent storage. Otherwise the browser can remove downloaded content.                                                            |
| Activity and proof of play                | Supported         | The Browser Player reports the same Activity events as other Players. It keeps them in a durable local queue until the server accepts them.                           |
| Identify, retry, skip, sync and reload    | Supported         | The Browser Player runs the commands listed under Commands.                                                                                                           |
| Installed app                             | Supported         | Chrome and Microsoft Edge can install each Browser Player as its own app.                                                                                             |
| Synchronized playback                     | Not supported     | The Browser Player does not produce shared timeline anchors.                                                                                                          |
| Watch Live and screenshots                | Not supported     | A browser cannot capture its own display without a user prompt.                                                                                                       |
| Websites and YouTube                      | Not supported     | Browser Player v1 has no isolated Website surface. The browser frame boundary is not weakened.                                                                        |
| Display control (CEC and DDC)             | Not supported     | A web page cannot control the display.                                                                                                                                |
| Device restart                            | Not supported     | A web page cannot restart the device.                                                                                                                                 |
| Player updates                            | Not applicable    | The server supplies the Browser Player. Update targeting excludes it.                                                                                                 |
| Operating system network setup            | Not supported     | A web page cannot change the network.                                                                                                                                 |

<!-- browser-capabilities:end -->

## Commands

A Browser Player runs only the command types in this table.
The server refuses every other command type for a Browser Screen.
Studio offers only these command types for a Browser Screen.

<!-- browser-commands:start -->

| Command                                   | Detail                                                              |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `sync_now` (Sync now)                     | Refreshes the manifest, the configuration and the server selection. |
| `reload_playback` (Reload playback)       | Activates the current content again from the start.                 |
| `identify_screen` (Identify screen)       | Shows the Screen name through the shared Runtime.                   |
| `retry_current_item` (Retry current item) | Asks the shared Runtime to restart the item on screen.              |
| `skip_current_item` (Skip current item)   | Asks the shared Runtime to advance to the next item.                |

<!-- browser-commands:end -->

## Validation

`apps/player-web` has its own continuous integration lane, `Browser Player`.
It installs the whole workspace, because the production Runtime declares its own build dependencies.
It runs unit tests, builds the exact Runtime and the Host, and runs Chromium end-to-end tests against the real Go server and PostgreSQL.
The end-to-end tests cover authentication, replaced and revoked bindings, single ownership, media preparation, service worker range responses, a browser restart while the Server is stopped, and Runtime output for each representative presentation.
`npm run test:e2e:frames` covers verified frame grants separately: the production worker build serves two grants, two bare navigations complete the handshake under the production shell policy, and an ungranted capability answers 404.
The Activity tests read proof of play back from the Server.
They cover an image playlist, a video that ends by itself, a manual skip, and a Layout that a takeover replaces.
A Go test verifies a WebCrypto signature from `apps/server/internal/devices/testdata/browser_webcrypto_golden.json`.
Regenerate it with `node apps/player-web/scripts/generate-webcrypto-golden.mjs`.

The Runtime reports its first evidence while it handles a presentation.
The Host must tell the proof tracker what it presents before it sends the presentation to the Runtime.
If the order is reversed, the tracker drops the first `item-started` report and the first item has no recorded play.

## Origin and extensions

Only trusted bundled first-party runtime plugins may execute in the Player origin.
Untrusted marketplace or custom plugin JavaScript must not execute as trusted top-level code there.
Future runtime extensions need isolated execution or a separate origin.
The Player aggregates a small capability-provider registry: each provider describes its current capability set and invokes typed operations, the heartbeat repeats the merged set, and persistent commands outside the static matrix route through the registry when a provider covers them.
The optional Tilecast Browser Companion extension contributes additional providers after an explicit per-origin grant.
Runtime behavior must not depend on a platform name or extension presence flag.
Browser Player v1 must report capture and Watch Live as unsupported.
See [Browser Companion architecture](browser-companion.md) and [Player capabilities](player-capabilities.md).

## Implementation status

Implemented. Unit tests cover each item. Chromium end-to-end tests cover authentication, enrollment, offline restart, activation, and Activity:

- The Host, the shared resolver, and the verified store.
- Browser sessions, key challenges, managed slots, recovery, ordinary pairing enrollment, and current Server selection.
- The typed commands in the command table, with at-most-once execution.
- Activity and proof of play, with a durable outbox and the shared session tracker.
- Active hours and rest, with the policy saved with each activation.
- Lifecycle facts, the capability matrix, and Studio diagnostics.

Not qualified:

- Real Chrome and Microsoft Edge. No browser version is recorded as supported.
- Lifecycle and reliability behavior in a real browser: a hidden page, a frozen page, wake lock, fullscreen, storage eviction, and a clock change.
- Command end-to-end cases: duplicate delivery, a lost result, a replaced binding, and an offline Player.
- Active hours, staged service worker updates, and long video playback.

Not implemented:

- A WebSocket push channel. The Host polls.
- The `lastMeaningfulProgressAt` telemetry gauge.
- Websites and YouTube.

Studio labels Browser Player as experimental when an operator creates a Browser Screen.
Do not remove the label until the qualification items above pass on recorded Chrome and Edge versions.
Browser screens remain outside native update targets.

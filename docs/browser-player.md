# Browser Player architecture

Browser Player is under implementation. It is not available for deployment.
The implementation must meet this contract before release.

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

## Installation identity

Each managed Browser Player has its own install manifest at `/player/<slot>/manifest.webmanifest`.
Its `id`, `start_url`, and `scope` are the stable slot route `/player/<slot>/`.
An installed Browser Player reopens as the same Screen.
The slot ID is not secret.
The recovery capability is never part of the start URL.
It remains in the one-time launch fragment, and the Host removes it before it parses it.
The unmanaged `/player/` route keeps its own manifest and identity.

## Capabilities

| Capability                              | Browser Player v1                                           |
| --------------------------------------- | ----------------------------------------------------------- |
| Image, video, Layout, Widget, status    | Supported through the shared Runtime                        |
| Server-selected schedule and takeover   | Supported. The Server selects.                              |
| Offline continuation of last activation | Supported                                                   |
| Offline schedule evaluation             | Not supported                                               |
| Active hours and outside-hours display  | Not supported. The Host has no power policy.                |
| Synchronized playback                   | Not supported. `synchronizedPlayback` is `false`.           |
| Remote Website surface                  | Not supported. The browser iframe boundary is not weakened. |
| Watch Live and capture                  | Not supported                                               |
| CEC, DDC, reboot, power                 | Not supported                                               |
| Native Player update                    | Not supported. Native update targeting excludes `browser`.  |
| Native network configuration            | Not supported                                               |

## Validation

`apps/player-web` has its own continuous integration lane, `Browser Player`.
It installs the whole workspace, because the production Runtime declares its own build dependencies.
It runs unit tests, builds the exact Runtime and the Host, and runs Chromium end-to-end tests against the real Go server and PostgreSQL.
The end-to-end tests cover authentication, replaced and revoked bindings, single ownership, media preparation, service worker range responses, a browser restart while the Server is stopped, and Runtime output for each representative presentation.
A Go test verifies a WebCrypto signature from `apps/server/internal/devices/testdata/browser_webcrypto_golden.json`.
Regenerate it with `node apps/player-web/scripts/generate-webcrypto-golden.mjs`.

## Origin and extensions

Only trusted bundled first-party runtime plugins may execute in the Player origin.
Untrusted marketplace or custom plugin JavaScript must not execute as trusted top-level code there.
Future runtime extensions need isolated execution or a separate origin.
An optional browser extension can supply narrow host capability providers.
Runtime behavior must not depend on a platform name or extension presence flag.
Browser Player v1 must report capture and Watch Live as unsupported.

## Implementation status

The Host, the shared resolver, and the verified store are implemented.
The Host starts the unchanged production Runtime and restores the last activation without the Server.
Server endpoints support browser sessions, key challenges, managed slots, recovery, ordinary pairing enrollment, and current Server selection.
Studio recognizes the browser family and the `awaiting_player` state.
Studio provides Browser Player creation and one-time launch link controls.
Browser screens remain outside native update targets.
Command and Activity integration, lifecycle diagnostics, and a WebSocket push channel remain incomplete.
Browser Player is not available for deployment.

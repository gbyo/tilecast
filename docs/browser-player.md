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
| Player Core              | Native durable orchestration and offline scheduling                                         |
| Future browser extension | Optional providers for additional host capabilities                                         |

`apps/player-web` must not become a TypeScript clone of `player-core`.
The Browser Host installs `TilecastRuntimeHostV1` before the production Runtime starts.
It must load the same Runtime artifact as native hosts.
It must not import Studio application code.

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

During an outage, Browser Player continues the last verified activation.
Runtime continues local playlist advancement.
Browser Player does not evaluate future schedules offline.
The Server selects the current presentation when connection resumes.

## Origin and extensions

Only trusted bundled first-party runtime plugins may execute in the Player origin.
Untrusted marketplace or custom plugin JavaScript must not execute as trusted top-level code there.
Future runtime extensions need isolated execution or a separate origin.
An optional browser extension can supply narrow host capability providers.
Runtime behavior must not depend on a platform name or extension presence flag.
Browser Player v1 must report capture and Watch Live as unsupported.

## Implementation status

The current changes establish the host media seam, browser identity key,
fragment scrubbing, lifecycle predicates, verified-store policy, OPFS adapter,
IndexedDB foundation, atomic activation metadata, and local Range responses.
Server endpoints support browser sessions, key challenges, managed slots,
recovery, ordinary pairing enrollment, and current Server selection.
The recovery transaction replaces the active binding epoch.
Studio recognizes the browser family and the `awaiting_player` state.
Browser screens remain outside native update targets.
The Host boots the unchanged production Runtime artifact.
The Server serves an independent Player shell with a restricted policy.
The service worker stages versioned assets and serves authorized local media.
The Host uses cookie and device-key recovery before managed recovery or pairing.
Atomic activation coordination prepares all manifest media before publication.
Studio management controls, command and Activity integration, lifecycle diagnostics,
and browser integration qualification remain incomplete.
These foundations do not establish Browser Player support.

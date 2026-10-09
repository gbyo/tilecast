# Native Player Core

**Status:** current native Player ownership contract. Edge, Android, and
Windows compose the shared native crates today. Historical extraction and
qualification evidence is retained in
[`records/player-core-readiness.md`](records/player-core-readiness.md).

This document defines ownership for native Player work. It supplements
[`tilecast-edge.md`](tilecast-edge.md), which defines Linux process, privilege,
content, update, and recovery guarantees. Extraction changes code ownership.
It must preserve those guarantees and the Server contracts.

## Contribution rules

1. Changes to presentation appearance or execution belong in Presentation
   Model or Player Runtime.
2. Behavior shared by full native Player hosts belongs in Player Core.
3. OS integration, lifecycle, distribution, renderer hosting, and behavior
   specific to one platform family belong to that platform.
4. A rule that independent Players must share needs a contract or fixture at
   its natural owner. See [`player-contracts.md`](player-contracts.md).
5. A normal product-level Player change should usually need one Core or
   Runtime implementation, rather than one implementation per platform.

Use this distinction when reviewing a change:

- What must a presentation do? Presentation Model or Player Runtime owns it.
- What must a native Player present, and can it do so safely? Player Core owns it.
- How does a host perform the operation? The platform owns it.

## Ownership matrix

| Behavior                                                 | Owner                                 | Examples                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pure presentation decisions shared by Studio and Runtime | `@tilecast/presentation-model`        | Playback defaults, item availability, zone advancement and fallback                                                                                                                        |
| Presentation execution                                   | `packages/player-runtime`             | Media surfaces, transitions, Widgets, Layouts, Websites, synchronized playback, browser evidence                                                                                           |
| Native Player behavior                                   | `crates/player-core` after extraction | Pairing, server reconciliation, manifest lifecycle, native schedule and temporary-presentation precedence, offline activation, command idempotency, Activity coordination, recovery policy |
| Durable metadata                                         | `crates/player-state`                 | Embedded SQLite migrations, Core-owned repositories, bounded outbox                                                                                                                        |
| Verified bytes                                           | `crates/player-cas`                   | Digest and size verification, resume, pinning, eviction, crash reconciliation                                                                                                              |
| Server transport                                         | `crates/player-client`                | URL policy, identity gate, REST, WebSocket, typed Player endpoints                                                                                                                         |
| Semantic values without I/O                              | `crates/player-types`                 | IDs, digests, bounded primitives, timestamps, shared capability vocabulary                                                                                                                 |
| Linux composition and providers                          | `apps/edge`                           | File credential store, statvfs, dynamic host measurements, CEC/DDC, NetworkManager, Avahi, systemd, logind                                                                                 |
| Edge renderer adapter                                    | `apps/edge`                           | Unix IPC, WPE lifecycle, media capabilities, peer identity, process lineage, JSON and Base64 encoding                                                                                      |
| Edge installation and updates                            | `apps/edge`                           | Legacy import, signed release verification, privileged installer, probation and rollback guards                                                                                            |

Core must not decide behavior from a platform or renderer name.
Optional unsupported capabilities must remain truthful.
Some platform-owned operations use Server endpoints. Server communication alone
does not make behavior a Core responsibility.

## Shared Rust crates

The target has five shared crates:

```text
crates/player-types       no I/O
crates/player-state       -> player-types
crates/player-cas         -> player-types, player-state
crates/player-client      -> player-types
crates/player-core        -> player-types, player-state, player-cas, player-client

apps/edge                 -> shared Player crates
shared Player crates      -X-> apps/edge
```

Do not add a `player-platform`, generic IPC, or service crate without evidence
of a distinct owner. Player Runtime is not an application-code dependency of
Core. Core and Runtime exchange bounded semantic values.

`edge-protocol` keeps Edge wire frames, roles, serialization, and descriptors.
It may consume generic values from `player-types`. Do not rename the entire
wire crate. Preserve IPC golden fixtures when semantic values move.

Expose a small Core composition API, such as `PlayerCore::new(dependencies)`
and its domain drivers. Keep scheduling, reconciliation, command delivery,
Activity, and supervision modules internal unless a consumer needs an API.
`tilecastd` becomes the Linux composition root. It constructs shared services
and connects Edge providers, lifecycle, migration, and update integrations.

Define narrow traits at their consuming crate. Examples are `CredentialStore`,
`RendererPort`, `DisplayControlProvider`, and CAS `SpaceProbe`.
Introduce each seam when extraction reaches its actual consumer.
Do not define a trait that collects all platform operations.

## Durable state and verified content

Preserve every shipped SQLite migration byte for byte. Preserve WAL,
`synchronous = FULL`, embedded migrations, `BEGIN IMMEDIATE`, newer-schema
refusal, integrity checks after unclean shutdown, and refusal to recreate a
failed database. Use a local filesystem that supports SQLite WAL semantics.

Shared physical schema compatibility does not imply shared behavioral ownership.
Historical update, legacy import, and Presentation Network repositories remain
platform-owned. Core must not use them. Clearly identify these repositories
when state moves. New platform state may use the same database when atomicity,
crash recovery, or rollback compatibility requires it. Keep those repositories
namespaced and inaccessible to Core. The `player-state::repo` API contains
Core-owned repositories. The `edge-state::platform` API contains update jobs,
Linux network recovery, and legacy import records. It is not a dependency of any
shared Player crate. Edge retains temporary repository reexports for its callers.

CAS trusts bytes only after size and SHA-256 verification. Preserve immutable
objects, partial downloads, resume, pins, eviction, limits, corruption detection,
and crash reconciliation. Define `SpaceProbe::available_bytes(path)` in CAS.
Edge supplies statvfs. Audit secure object opening on each host. A portable
adapter must preserve link and regular-file checks.
The shared CAS is implemented in `crates/player-cas`. Linux free-space providers
live in `edge-cas::space` and call `edge-platform::disk::available_bytes`.
The shared crate has no Edge dependency. Its secure Unix opening uses the same
no-follow, nonblocking flags and opened-file checks on Linux and macOS, and its
Windows opening rejects reparse points and non-regular files. Privileged
Edge helpers do not depend on CAS, state, the server client, or Core.

## Server identity and credentials

Preserve the type boundary between public `ServerClient` and
`AuthenticatedServer`. Only installation identity verification may create an
authenticated client. Never send a stored credential before that check.

`DeviceCredential` owns parsing, redacted Debug, and authorization headers.
`CredentialStore` owns load, save, and remove. The HTTP client must not know the
storage location. Edge keeps its owner-only file store and legacy Electron
import. A future host supplies its own credential store.
The portable client is implemented in `crates/player-client`. Hosts supply its
user agent and device metadata. `CredentialStore` and `PairingStore` are private
storage ports; the HTTP client never calls them. Edge implements atomic,
owner-only file writes. Authenticated downloads require a validated
`PlayerDownloadPath`. Core supplies the CAS origin adapter.

Core owns pairing eligibility, persistent Player identity creation, session
creation, enrollment retry and storage order, session renewal, reset
suppression, and polling cadence.
Edge supplies device metadata and private credential and session stores.
Edge still constructs pairing surfaces and supplies wake and shutdown signals.
Core owns binding-scoped offline manifest reads, stale pending retirement,
active-hours and disabled gates, pending grace and trial deadlines, evidence
requirements for promotion, and verified pin lifetime. Core tests check that
acceptance alone cannot promote a manifest, a changed target cannot become
active, and a changed binding resets trial state. Core drives offline activation
ordering and wake timers. Hosts project Runtime documents and supply opaque
comparison keys. Edge retains Runtime document comparison, projection, and
surface construction. Core checks packaged and connected support before a trial.
Core now owns server relationship verification, credential rejection,
retry backoff, and persisted policy-clock samples. Core now drives the server
socket, reconnect and liveness timers, heartbeat fallback, push handling,
configuration and manifest reconciliation, and command/Watch Live wakes.
Edge supplies heartbeat projection, renderer privacy checks, Activity signals,
and retry jitter. Socket credentials still pass the public identity gate.
Core owns conditional configuration fetches, binding-scoped acceptance,
revision ordering, current/previous persistence, and refusal reporting.
Core validates the bounded configuration envelope and projects cache limits,
reconciliation intervals, recovery policy, and active-hours scheduling.
The configuration host validates its remaining sections and receives the native
projection with the bounded document. Core carries the host projection without
interpreting Runtime or Linux settings. Edge separates its Runtime projection
from Linux kiosk and Presentation Network policy. Runtime fields keep their
existing values and defaults, including unknown bounded playback context fields.
Core now owns conditional manifest fetches, stable manifest identity,
binding-scoped target persistence, and native resource-claim validation.
Runtime-owned fields in the manifest stay opaque. Edge owns Runtime projection
and supplies explicit compatibility requirements. Core drives activation and owns
preparation-worker supervision, verified content preparation, repair, pin identities,
and target-bound pending storage. Core tests use SQLite and CAS to check repair
and replacement during a fetch.
Core worker tests cover replacement and shutdown cancellation, deterministic
rejection, transient retries, and cached-content repair.
Core tests cover identity order, saved claims, storage failure, session
retirement, polling outcomes, reset suppression, and the enrollment retry budget.
The four existing Edge pairing integration tests pass after orchestration moves.
Core clock tests use SQLite to check precision and persistence after reopening.
The first stage-9 CI run passed 39 of 40 Linux playback tests. The clock
sampling test failed on a timestamp rewrite with a final offset change of 9 ms.
The sampling rule is unchanged. The same test passed in isolation in Linux
Docker, and all 40 playback tests then passed locally in that image.
Later qualification passed at `f19a6b88`, including that playback test.

## Core foundation

`crates/player-core` implements native schedule selection, command idempotency,
and Activity session semantics. Its implementation modules are private.
`PlayerCore::new(Dependencies)` receives durable state and a host clock.
Hosts supply fixed command handlers. `PlayerCore::run_commands` drives command delivery.
Edge supplies its migration hold outside Core.
Activity consumes semantic signals and injected clocks and IDs.
The persisted session encoding and parity fixtures remain unchanged.
Core drives durable Activity reporting, restart closure, overflow reporting,
and bounded shutdown flushing. Edge retains renderer signal projection and
supplies clocks, IDs, and timezone observations. Edge constructs one PlayerCore
with shared durable dependencies. It connects the narrow host services to
domain drivers and keeps Linux lifecycle and hardware tasks separate.
`PlayerCore::run_server_link`, `run_activity`, and `run_telemetry` use those
dependencies. Hosts do not construct a second set for these drivers.
Hosts generate Player, activation, command, capture, and telemetry IDs.
Core persists stable Player identity and correlates the supplied request IDs.
Core owns the renderer recovery ladder and meaningful-evidence rules.
Core tracks acceptance, errors, and evidence by connection and activation.
It refuses stale observations and bounds evidence logs and content-item sets.
Edge maps wire values and executes actions through its RendererPort adapter.
Core coordinates activation identity, profile checks, and recovery timers.
Core creates recovery Activity events with the existing escalation metadata.
Edge keeps Runtime projection inputs and constructs status payloads.

The renderer contract carries bounded opaque Runtime data and verified
object bindings. Edge uses prepared activations through
its RendererPort adapter. A temporary projection bridge remains in Edge.
Separate packaged and connected profiles check host features, presentation
schemas, declarative capabilities, and Widget component versions.
Release support does not replace a missing session advertisement.
The RendererPort interface defines semantic operations and immutable prepared
activations. Edge uses Core checks for decoded capture dimensions, size, and
JPEG signature. Transport decoding stays in Edge.
Core serializes captures across preview and Watch Live.
It checks protected states and applies the ten-second timeout.
Canceled and expired requests release their capture slot.
Edge decodes requested replies on the capture caller's task.
Core owns periodic preview leases, cadence, uploads, fault suspension, and
capability policy. Edge supplies captures, time, and provider identity.
Core also owns Watch Live leases, cadence, frame replacement, and checks after
capture. Edge owns socket delivery and checks protection again before sending.
Core correlates renderer command results with at most eight pending requests.
Disconnects, timeouts, and cancellation release command registrations.
Startup Website data clearing retries on readiness until one clear succeeds.
Edge maps wire results and user-facing failure text.
Edge owns resource encoding, media grants, and IPC queue operations.
The Edge port owns its renderer endpoint and caches grants for that session.
It prepares and activates grants and drains prior generations with its own clock.
The activation coordinator does not assemble media capabilities.
Core checks packaged and connected profiles before activation.

Keep command delivery in Core: fetch, validate, persist idempotency, acknowledge,
commit executing, invoke a typed handler, persist the result, report, and retry
reporting. Redelivery or restart must never execute a command twice.
Display operations and Player installation use typed platform handlers.
Do not add arbitrary command execution.

## Configuration projections

Do not move monolithic `player_config.rs` into Core. Accept and bind a complete
validated `PlayerConfigEnvelope` with schema version and configuration revision.
Project it according to behavioral ownership:

| Projection                     | Behavior                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Core                           | Cache policy, reconciliation cadence, recovery policy, shared device policy                                         |
| Presentation Model and Runtime | Playback defaults, presentation formatting, Website behavior, Widget and Layout context, presentation accessibility |
| Platform                       | Linux kiosk, Presentation Network implementation, updater settings, OS integration                                  |

Core may preserve and route fields it does not interpret. A new platform
section must not require Core to implement its field behavior.
Preserve revision acceptance, binding, and previous valid configuration.
Do not duplicate presentation-default calculations in Core.

## Renderer semantics and authorization

Core uses a semantic `RendererPort` for activate, clear, typed
commands, capture, and restart or reload requests. It receives bounded typed
events for connection, readiness, acceptance, refusal, meaningful evidence,
playback errors, command results, capture results, and disconnection.

Runtime owns presentation fields. Core carries bounded opaque JSON and separate
resource bindings. Projection supplies explicit requirements, activation identity,
evidence expectations, and capture protection. Core does not infer these values
from arbitrary Runtime JSON. New transitions, Website options, and Layout visual
properties normally require no Core change. Unknown Runtime fields pass through
the Core and Edge preparation path except for declared resource bindings.

The combined document and context have a four MiB bound and at most 1,024
bindings. Bindings use valid JSON pointers without duplicates. Each binding must
refer to an object in the activation's verified-content set. Missing resources
fail closed. Core owns no visual status defaults. Edge constructs status payloads
and owns display-sleep policy, cursor configuration, and media-expiry time.

The host owns transport. Core must not contain `SessionHandle`, Unix renderer
sockets, Edge wire frames, WPE APIs, IPC Base64 encoding, renderer UID/PID,
process lineage, or `tcmedia` URLs. A capture result carries bounded JPEG bytes
and dimensions. Edge encodes those bytes for its existing wire contract.
Do not design future macOS IPC during this extraction.

Core owns valid presentation generations and verified object references.
The host authorizes media reads for those generations. A renderer may access
only verified content authorized for its valid generation. Preserve Edge's
random per-session and per-generation capability, Unix peer credentials,
renderer identity, process lineage, secure local file serving, and revocation.
Other hosts may use another safe media mechanism.

Keep two renderer profiles:

- `PackagedRendererProfile`: support declared by the installed release.
- `ConnectedRendererProfile`: support advertised by the current session.

Preparation checks the packaged profile. Activation also checks the connected
profile. Component version skew produces a truthful incompatibility or error.
Do not assume these profiles match. Presentation schema, host features,
declarative capabilities, Widget capabilities, remote web, and synchronization
remain distinct contracts.

`RuntimeReadyV1.support` reports live presentation schemas and declarative
capabilities from Runtime constants, and Widget versions from live discovery.
WPE forwards this optional bounded metadata in `renderer.ready.support`.
Edge combines it with live host features for the connected profile.
An absent namespace stays empty. Generated release files remain the packaged
profile source. This additive readiness report leaves existing activation and
capture wire fixtures unchanged.

## Platform facts and optional features

Keep build identity separate from dynamic environment facts. Version,
architecture, and platform family are stable. Hostname, display dimensions,
locale, timezone, display state, free storage, and uptime can change.
Add a narrow snapshot provider only for fields that Core actually needs.

Core owns telemetry cadence, interval counters, serialization, and bounded
offline outbox policy. The telemetry host supplies semantic observations and
measured gauges. Linux owns measurements from `/proc` and hardware.
An unavailable measurement is omitted. Never report it as zero.
Core tests check offline sample storage, wire fields, queue bounds, and restart
persistence. Telemetry does not displace proof-of-play events.

Core validates Display Control payloads and applies committed scheduled actions
through a narrow provider. It owns retry settlement and power-readback result
semantics. Edge converts input identifiers to CEC physical addresses and keeps
probe timers, device access, and hardware readback. Unsupported results settle
until capabilities change; uncertain results retry.
Core validates non-secret Presentation Network assignments, identifies obsolete
profiles, and checks installed revisions and credential availability.
NetworkManager, Wi-Fi mechanics, helper sockets, and recovery stay in Edge.
Discovery supplies a candidate URL to the shared URL policy and pairing path.
Core needs no discovery abstraction until a real consumer requires it.
Generic capability values and IDs live in `player-types`.
WPE, systemd, PipeWire, CEC, and DDC provider IDs live in `edge-protocol`.

Edge updates remain intact: release family, signed archive, installer,
privileged helper, systemd guards, provisional activation, and rollback.
Core may dispatch `install_player_update`; it does not own this state machine.

## Extraction order and gates

Each row is a separate reviewable PR. No step may weaken existing Edge tests.

| Step | Change                                                                        | Required evidence                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | This ownership contract and characterization                                  | No implementation moves; dependency gate and migration baseline                                                                                                               |
| 2    | Repository virtual Cargo workspace only                                       | One lockfile; explicit Edge release version; Edge-scoped commands; actual shipped-binary SBOM closure; cache, release, schema, and reproducibility consumers updated together |
| 3    | Generic types                                                                 | IPC fixtures unchanged; shared Rust Ubuntu and macOS gates; `player_core` affected area and all consumer edges                                                                |
| 4    | Durable state                                                                 | Migration bytes unchanged; durability and crash tests; platform repositories identified                                                                                       |
| 5    | CAS                                                                           | Verification, resume, corruption, and crash tests; narrow space and secure-opening seams                                                                                      |
| 6    | Server client                                                                 | Identity type gate and credential storage separation; Edge import retained                                                                                                    |
| 7    | Core composition, selection, commands, Activity                               | Existing fixtures; platform-independent tests; no duplicate implementations                                                                                                   |
| 8    | Renderer port, authorization, recovery, capture                               | Semantic Core; Edge IPC and media fixtures unchanged; separate renderer profiles                                                                                              |
| 9    | Server link, pairing, manifest preparation, offline, configuration, telemetry | Core outage and restart tests; configuration projections                                                                                                                      |
| 10   | Optional native capabilities                                                  | Narrow shared semantics; Linux hardware and service implementations retained                                                                                                  |
| 11   | Linux composition root                                                        | Obsolete forwarding modules removed; full Edge qualification                                                                                                                  |
| 12   | Architecture and macOS-readiness audit                                        | No Edge leakage, duplicated presentation policy, stale facts, or unnecessary public internals                                                                                 |

Do not use one root package version as every future product's release version.
The workspace migration must introduce an explicit Edge release-version source.
The root lockfile may include other products. Edge SBOM tooling must calculate
the locked dependency closure of shipped Edge binaries.

`default-members` controls unqualified root Cargo commands. It does not scope
`--workspace`. Edge scripts must explicitly select Edge packages.

Run the dependency gate with `python3 scripts/ci/check-player-architecture.py`.
It checks local paths, dependency aliases, workspace inheritance, normal,
development, build, and target dependencies. CI and `make check` run it.
Root Cargo and toolchain changes select shared Ubuntu/macOS validation and all
Edge integration tests. Shared Player crate changes select these same consumer
tests plus Android validation through the `player_core` area. Unknown root crates select all areas.

Keep Rust, real Linux builds, fake-server playback, real Server E2E, WPE E2E,
Runtime conformance, Activity parity, migration crash and power-loss tests,
systemd update and rollback, hardware-provider tests, packaged sandbox, and
release reproducibility qualification. Linux integration does not run on macOS.
Each new shared crate needs Ubuntu (x64 and ARM64), macOS, and Windows (x64
and ARM64) validation from its first PR.

Core tests use temporary SQLite and CAS, fake renderer and server ports,
provider fakes, and controllable clocks. Cover identity mismatch, rejection and
revocation, offline cached boot, reconnect, invalid or superseded preparation,
corrupt content, precedence transitions, configuration revisions, command
redelivery and execution crash, Activity outage persistence, renderer failures,
recovery and safe mode, protected capture, and renderer version skew.
These tests supplement Edge system tests.

## Other Players and non-goals

Android keeps Kotlin. Android hosts Core through the platform crate
`tilecast-player-android-native` below `apps/player-android/native`.
The crate owns one process-level host, a narrow JNI bridge, Android storage
locations, and Android platform TLS trust. Kotlin keeps lifecycle, setup UI, WebView hosting, Keystore, and OS effects.
Shared crates never depend on the Android crate. The dependency gate checks
this direction. Production uses the native Player Core host for pairing,
Server reconciliation, manifests, offline activation, commands, and recovery;
see [Android development](android-development.md) for the completed cutover.
Kotlin supplies private stores and device facts and keeps the credential
in the Keystore. A pairing reset clears the session and preserves an enrolled
credential; Core reserves credential removal for revocation.

Independent Players share fixtures at the rule's natural
owner. `packages/player-contracts` contains only ownerless cross-player fixtures.
The experimental Browser Player in `apps/player-web` uses Player Runtime and
shared presentation contracts without native appliance Core; see
[Browser Player](browser-player.md) for its separately qualified host model.
Other browser-based platforms may reuse that family after qualification.
This project does not currently build a macOS, Tizen, or webOS Player.
The Windows Player (`apps/player-windows`) is the second native host: it
proves the extraction by composing the same shared crates with a WebView2
renderer instead of a second Player implementation.
It does not replace Runtime or Presentation Model, rewrite shipped migrations,
create a universal updater or IPC framework, change Player API behavior,
relax privilege boundaries, or decide macOS process topology.

A new native host needs platform composition, a renderer host, capability
providers, lifecycle, distribution, and secure media delivery. It must not need
another implementation of pairing, reconciliation, manifests, offline
selection, idempotency, Activity, recovery, or content verification. A new
platform proposal records its own platform gaps rather than reopening the Core
extraction ledger.

## Current characterization

The baseline remains in the existing Edge tests:

| Guarantee                                                            | Evidence                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Edge IPC representation                                              | `edge-protocol/tests/fixtures.rs` and C IPC fixtures                                       |
| Shipped migration bytes and durability                               | `crates/player-state/tests/state.rs` and `migration_baseline.rs`                           |
| CAS corruption, pins, resume, crash reconciliation                   | `crates/player-cas` tests                                                                  |
| Pairing and identity before credentials                              | `tilecastd/tests/pairing.rs` and `edge-server` tests                                       |
| Offline playback, superseded preparation, renderer recovery, capture | `tilecastd/tests/playback.rs`, `daemon.rs`, `media_channel.rs`                             |
| Command redelivery and restart                                       | `player-core/tests/commands.rs`, `tilecastd/tests/commands.rs`, and `playback.rs`          |
| Native schedule selection                                            | `player-core/tests/schedule_contract.rs` and shared schedule fixtures                      |
| Activity outage and restart parity                                   | Core and Edge `tests/activity_parity.rs` and Activity parity fixtures                      |
| Update and migration power-loss behavior                             | `tilecast-edge-update`, `tilecast-edge-migrate`, `tilecastd/tests/updates.rs`, systemd E2E |

The existing implementation ledger is [`tilecast-edge-next.md`](tilecast-edge-next.md).
These tests must keep exercising the implementation after it moves.
Architecture documentation does not establish physical hardware qualification.

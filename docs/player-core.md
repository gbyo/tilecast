# Native Player Core

**Status:** Accepted extraction contract. The five shared crates and Core
foundation are implemented. Renderer and reconciliation extraction remains.
Edge keeps its current behavior throughout the extraction.

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
and `PlayerCore::run(...)`. Keep scheduling, reconciliation, command delivery,
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
no-follow, nonblocking flags and opened-file checks on Linux and macOS. Privileged
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

## Core foundation

`crates/player-core` implements native schedule selection, command idempotency,
and Activity session semantics. Its implementation modules are private.
`PlayerCore::new(Dependencies)` receives durable state and a host clock.
Hosts supply fixed command handlers. `PlayerCore::run` drives command delivery.
Edge supplies its migration hold outside Core.
Activity consumes semantic signals and injected clocks and IDs.
The persisted session encoding and parity fixtures remain unchanged.
Edge retains renderer signal adapters and outbox delivery in this stage.
Renderer supervision stays in Edge until the RendererPort extraction.

The draft renderer contract adds semantic prepared-document types and verified
object bindings for Runtime data. Edge does not consume these types yet.
The RendererPort and its Edge adapter remain required work.
This groundwork does not complete the renderer extraction gate.

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

Core uses a semantic `RendererPort` for configure, activate, clear, typed
commands, capture, and restart or reload requests. It receives bounded typed
events for connection, readiness, acceptance, refusal, meaningful evidence,
playback errors, command results, capture results, and disconnection.

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

## Platform facts and optional features

Keep build identity separate from dynamic environment facts. Version,
architecture, and platform family are stable. Hostname, display dimensions,
locale, timezone, display state, free storage, and uptime can change.
Add a narrow snapshot provider only for fields that Core actually needs.

Core may own telemetry cadence, counters, bounded retention, serialization,
and offline outbox policy. Linux owns measurements from `/proc` and hardware.
An unavailable measurement is omitted. Never report it as zero.

Shared display command validation, result vocabulary, and scheduled action
semantics may use a narrow display provider. CEC and DDC/CI stay in Edge.
Presentation Network assignment and revision policy may be shared where needed.
NetworkManager, Wi-Fi mechanics, helper sockets, and recovery stay in Edge.
Discovery supplies a candidate URL to the shared URL policy and pairing path.
Core needs no discovery abstraction until a real consumer requires it.

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
tests through the `player_core` area. Unknown root crates select all areas.

Keep Rust, real Linux builds, fake-server playback, real Server E2E, WPE E2E,
Runtime conformance, Activity parity, migration crash and power-loss tests,
systemd update and rollback, hardware-provider tests, packaged sandbox, and
release reproducibility qualification. Linux integration does not run on macOS.
Each new shared crate needs Ubuntu and macOS validation from its first PR.

Core tests use temporary SQLite and CAS, fake renderer and server ports,
provider fakes, and controllable clocks. Cover identity mismatch, rejection and
revocation, offline cached boot, reconnect, invalid or superseded preparation,
corrupt content, precedence transitions, configuration revisions, command
redelivery and execution crash, Activity outage persistence, renderer failures,
recovery and safe mode, protected capture, and renderer version skew.
These tests supplement Edge system tests.

## Other Players and non-goals

Android keeps Kotlin. Independent Players share fixtures at the rule's natural
owner. `packages/player-contracts` contains only ownerless cross-player fixtures.
Browser, Tizen, and webOS may later share a browser-host family and Player Runtime
where supported. They need no native appliance Core or WASM requirement.

This project does not build macOS, Windows, browser, or smart-TV Players.
It does not replace Runtime or Presentation Model, rewrite shipped migrations,
create a universal updater or IPC framework, change Player API behavior,
relax privilege boundaries, or decide macOS process topology.

At completion, a new native host needs platform composition, a renderer host,
capability providers, lifecycle, distribution, and secure media delivery.
It must not need another implementation of pairing, reconciliation, manifests,
offline selection, idempotency, Activity, recovery, or content verification.
Record remaining macOS work in a readiness review. Do not create the app.

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

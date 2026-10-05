# Native Player Core readiness review

**Status:** Stage 12 review in progress. The extraction is not fully qualified.
This review does not authorize a production Edge rollout or create a macOS app.
The governing contract is [`player-core.md`](player-core.md).

## Ownership audit

The five shared Rust crates contain native values, durable state, verified
storage, Server transport, and native Player behavior. Their dependency graph
has no Edge dependency. Core modules are private. Hosts use `PlayerCore` to
construct coordinators and run Server, command, Activity, and telemetry drivers.
Renderer and capture coordination use separate semantic handles because these
operations must also accept asynchronous renderer reports.

Core owns pairing, identity verification policy, Server reconciliation,
configuration acceptance, manifest preparation, offline activation, native
selection, command guarantees, Activity, telemetry policy, and renderer recovery.
Edge supplies private stores, host facts, Runtime projection, hardware providers,
renderer transport, and Linux lifecycle. Edge update and migration state machines
remain platform-owned.

The review found and corrected these ownership issues:

- WPE, systemd, PipeWire, CEC, and DDC provider IDs were in shared values.
  They now live in the Edge protocol crate. Their wire strings are unchanged.
- Core generated some request and Player IDs. Hosts now generate them.
  Core keeps stable identity persistence and request correlation.
  Duplicate pending renderer command IDs fail before they reach the renderer.
- The Server driver constructed another set of shared dependencies in Edge.
  It now runs through the same `PlayerCore` as other durable drivers.
- An origin-source forwarding module had no remaining implementation role.
  Its consumers now use the Core origin adapter directly.
- Recovery state, Server backoff state, and the evidence predicate had no
  external consumers. These implementation details are now private to Core.
  Hosts use the renderer coordinator and Server driver to apply those rules.
- Ownership descriptions still claimed that shared crates were unimplemented
  or that Edge owned Activity delivery. The descriptions now match the code.

Edge compatibility exports that still have consumers remain in `edge-state`,
`edge-cas`, and client or value adapters. They contain no second implementation
of native policy. Historical platform repositories remain in
`edge-state::platform`; Core cannot depend on that crate.

## Runtime and renderer boundary

Core carries bounded opaque `RuntimePayload` values. `ObjectBinding` records
declared resource locations. Activation metadata separately supplies verified
objects, renderer requirements, evidence expectations, and capture protection.
Core does not parse fit modes, transitions, Website options, or Layout styling.

The existing Edge projection bridge still constructs the shipped renderer
document. It preserves the existing wire contract and Runtime inputs.
It is not a template for a second native presentation engine.
A new host must consume Runtime contracts and provide opaque projection output.
Presentation Model and Runtime remain the owners of presentation rules.
Moving the legacy bridge into Core would violate that boundary.

The architectural scenarios have these implementation destinations:

| Change                          | Destination                                                |
| ------------------------------- | ---------------------------------------------------------- |
| New Runtime transition          | Runtime or Presentation Model; Core payload passes through |
| New Website presentation option | Runtime or Presentation Model; Core payload passes through |
| New Layout visual property      | Runtime or Presentation Model; Core payload passes through |
| Replace WPE                     | Renderer adapter and host lifecycle                        |
| Add a WKWebView host            | macOS adapter and platform composition                     |
| Change local media grants       | Edge resource adapter                                      |

A new resource field still needs a declared binding and verified object.
A new renderer requirement still needs explicit semantic metadata.
These requirements do not make Core an owner of visual fields.
Core and Edge tests preserve unknown Runtime fields while resolving only
declared bindings. Core offline tests also preserve them across activation
and restart.

Packaged and connected profiles are independent. Host features, presentation
schemas, declarative capabilities, and Widget components have separate sets.
Runtime readiness supplies live support. An absent set stays empty.
A newer renderer cannot extend the installed release's packaged support.

Core does not contain Unix sockets, renderer UID/PID checks, process-lineage
inspection, `tcmedia` grants, Base64 IPC encoding, or Linux service APIs.
Edge owns the expiry clock and generation-bound grants.
Display-sleep and cursor policy stay in the platform composition.

## Requirement and evidence map

These checks exercise the implementations after extraction. Passing an older
stage does not qualify a later changed head.

| Requirement                                              | Implementation and evidence                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Five shared crates; no Edge dependency                   | Root workspace; `check-player-architecture.py`; dependency-direction tests                        |
| No I/O in generic values                                 | `player-types`; host-supplied clocks and IDs                                                      |
| SQLite durability and migration compatibility            | `player-state` state tests and migration baseline; unchanged shipped migration bytes              |
| Verified CAS, resume, pins, eviction, crash recovery     | `player-cas` tests; Linux `SpaceProbe`; secure no-follow opening on Linux and macOS               |
| Identity before credentials; redacted secrets            | `player-client` identity gate and credential tests; Core pairing and relationship tests           |
| Private credential persistence                           | Edge file stores; existing owner-only and atomic-write tests                                      |
| Native schedule and temporary-presentation precedence    | Core selection tests and shared schedule corpus                                                   |
| Command redelivery and restart guarantees                | Core and Edge command integration tests                                                           |
| Manifest replacement and target-bound preparation        | Core manifest and worker tests; Edge slow-preparation and repair tests                            |
| Configuration ownership and revision acceptance          | Core configuration tests; opaque host projection; Edge Runtime/platform projections               |
| Offline restart, pending promotion, and verified pins    | Core offline driver tests; Edge playback suite                                                    |
| Semantic activation and explicit evidence                | Core renderer coordination and tracking tests; unknown-field preservation tests                   |
| Independent packaged and connected support               | Core profile tests; Runtime readiness and WPE forwarding tests                                    |
| Renderer recovery and safe mode                          | Core recovery tests; Edge disconnect, stall, and safe-mode integration tests                      |
| Protected capture, preview, Watch Live                   | Core broker and lease tests; Edge capture and playback integration tests                          |
| Activity persistence and proof of play                   | Core Activity worker and parity tests; real-server parity qualification                           |
| Telemetry cadence and bounded outbox                     | Core telemetry tests; Edge measured gauges                                                        |
| Truthful optional hardware support                       | Core display/network decision tests; Edge CEC/DDC and network tests                               |
| Edge IPC and media security                              | Unchanged IPC golden fixtures; Unix credentials, UID/PID, lineage, grant, and verified-CAS tests  |
| Edge updater, migration, sandbox, and rollback           | Existing helper crash matrices; packaged systemd migration/update qualification                   |
| Release version, dependency closure, and reproducibility | Root workspace release contract tests; Edge SBOM and release tests                                |
| Conservative affected-area selection                     | Registration, exclusion, and nested-workspace tests; unknown crates select all relevant consumers |
| Linux and macOS shared builds                            | Shared Rust CI on both hosts from each extraction stage                                           |
| Runtime and independent Player agreement                 | Runtime/Electron/WPE conformance; Android and Activity fixtures at their existing owners          |

## Qualification status

Stage 9 passed all selected CI at its final head `a04ef59c` in PR #1268.
Stage 10 passed shared Rust on Linux and macOS and all Edge qualification
at `ca164bfb` in PR #1287. Its broader PR validation is red.
Studio has one duplicate-locator failure and five visual mismatches that also
failed on main. iOS Core tests timed out. These checks remain unresolved.
Stage 11 passed local checks, the full Linux daemon suite, selected shared
PR validation, and all Edge qualification at `4f7d8cdd` in PR #1288.
Stage 12 changes need their own checks and selected qualification.

No stage is complete while its selected checks are pending or failing.
Physical WPE, display hardware, and power-cycle qualification remain the
existing M11 work recorded in [`tilecast-edge-next.md`](tilecast-edge-next.md).

## Remaining macOS platform work

A macOS Player must supply these adapters and services:

- WKWebView Runtime hosting, readiness support, evidence, capture, and commands.
- A renderer adapter with secure verified-object delivery and generation retirement.
- Keychain or another private credential and pairing-session store.
- Local state and CAS locations with SQLite WAL and secure file-opening support.
- Free-space measurement, device facts, timezone, and fresh IDs.
- Window, fullscreen, cursor, display-sleep, and power integration.
- Bonjour discovery and native lifecycle or startup integration.
- Truthful optional display and network providers, or unsupported results.
- Platform update delivery, packaging, signing, sandbox policy, and notarization.

The host must connect the semantic projection and service ports.
It must not recreate pairing rules, reconciliation, manifest lifecycle,
offline selection, command idempotency, Activity, recovery, or CAS guarantees.
No Core change is needed merely to name macOS, WKWebView, a Keychain store,
a filesystem location, or a different renderer transport.

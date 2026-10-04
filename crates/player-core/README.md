# Player Core

`player-core` implements behavior shared by native Tilecast Players.
It has no dependency on Edge or its renderer wire contract.
Read [the ownership contract](../../docs/player-core.md) before a change.

The foundation contains native schedule selection, durable command delivery,
Activity session semantics, and the Tilecast CAS origin adapter.
Scheduling, command coordination, and Activity modules are private.
The crate exports the types and operations that hosts consume.

`PlayerCore::new(Dependencies)` receives durable state and a host clock.
`commands(handlers)` constructs the command coordinator.
`run(...)` drives delivery for the verified server relationship.
Hosts supply fixed typed handlers and lifecycle signals.
Edge supplies the migration probation hold outside Core.

Activity uses semantic signals and an injected clock and ID source.
It preserves the existing event vocabulary and persisted session encoding.
Edge translates its renderer wire values into these signals.
Edge still owns Activity outbox delivery until the reconciliation extraction.

The shared recovery ladder chooses renderer actions from meaningful evidence.
Edge executes those actions through its RendererPort adapter.
Core tracks acceptance, errors, and evidence for the current connection and
activation. Stale observations cannot accept an activation or prove content.
Evidence logs and content-item tracking remain bounded.
The foundation does not claim to implement the complete native lifecycle.

## Renderer contract groundwork

Prepared activations carry opaque, bounded Runtime presentation data.
`RuntimePayload` holds that data with separate verified-object bindings.
Core does not model transitions, fit, Website options, Widget visuals, Layout
properties, or status styling. Projection supplies explicit renderer requirements,
evidence expectations, and capture protection metadata.
Binding locations contain empty strings until the host resolves them.
The host chooses its resource transport for the valid generation.
The types reject invalid bindings, oversized data, and unlisted objects.

Separate packaged and connected profiles check host features, presentation
schemas, declarative capabilities, and Widget component versions.
Release support cannot replace a missing session advertisement.

`RendererPort` defines semantic activate, clear, command, capture,
and restart operations. Prepared activations are immutable and check object
membership in both documents and Runtime context.
Edge uses the shared decoded-capture dimensions, size, and JPEG signature checks.
Base64 decoding stays in Edge.

Core serializes capture requests across periodic preview and Watch Live.
It owns protected-state checks, the ten-second timeout, and request cleanup.
Edge decodes only requested replies on the capture caller's task.
Core owns periodic preview leases, capture cadence, uploads, fault suspension,
and capability policy. Hosts supply captures, time, and their provider identity.
Core also owns Watch Live leases, capture cadence, frame replacement, and
post-capture lease and protected-state checks. Edge owns socket delivery and
checks protection again before sending a frame.

Core correlates renderer command results with at most eight pending requests.
Disconnects, timeouts, and canceled callers release their registrations.
Startup Website data clearing waits for support, retries failures on readiness,
and completes only once after success. Edge maps wire results and failure text.

Edge now routes prepared activations through its RendererPort adapter.
A temporary Edge projection bridge removes resource URLs before the port call.
Resource encoding, IPC, and media grants stay in Edge.
The port owns its renderer endpoint and the session's cached generation grants.
The activation coordinator does not assemble media capabilities.
Edge owns its media-expiry clock, display-sleep policy, and cursor configuration.
Runtime readiness supplies live schema and declarative support plus discovered
Widget versions. WPE forwards those namespaces alongside its host features.
Core checks both packaged and connected profiles before activation.
Core coordinates activation generations, evidence, and recovery timers.
Core creates recovery Activity events with the existing escalation metadata.
Hosts retain Runtime projection inputs and construct status payloads.
Stage 8 completion requires green selected qualification jobs.

Run `make player-check` and `make player-test` from the repository root.
The shared suite runs on Ubuntu and macOS.
Command crash-point tests use real SQLite with a controllable clock.
Edge integration tests continue to use the same shared implementations.

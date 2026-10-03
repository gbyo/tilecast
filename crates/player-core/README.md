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
The foundation does not claim to implement the complete native lifecycle.

## Renderer contract groundwork

The draft renderer extraction adds semantic prepared-document types.
`Resource::Object` identifies a verified object by digest.
`RuntimePayload` holds Runtime data with separate object bindings.
Binding locations contain empty strings until the host resolves them.
The host chooses its resource transport for the valid generation.
The types reject invalid bindings, oversized data, and unlisted objects.

Separate packaged and connected profiles check host features, presentation
schemas, declarative capabilities, and Widget component versions.
Release support cannot replace a missing session advertisement.

`RendererPort` defines semantic configure, activate, clear, command, capture,
and restart operations. Prepared activations are immutable and check object
membership in both documents and Runtime context.
Edge uses the shared decoded-capture dimensions, size, and JPEG signature checks.
Base64 decoding stays in Edge.

Edge now routes prepared activations through its RendererPort adapter.
A temporary Edge projection bridge removes resource URLs before the port call.
Resource encoding, IPC, and media grants stay in Edge.
The port owns its renderer endpoint and the session's cached generation grants.
The activation coordinator does not assemble media capabilities.
Profile adoption, activation policy, recovery coordination, and capture coordination
extraction remain incomplete.
The existing Edge implementation remains active until those consumers move.

Run `make player-check` and `make player-test` from the repository root.
The shared suite runs on Ubuntu and macOS.
Command crash-point tests use real SQLite with a controllable clock.
Edge integration tests continue to use the same shared implementations.

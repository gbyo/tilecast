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

Renderer supervision and recovery remain in Edge until the RendererPort stage.
The foundation does not claim to implement the complete native lifecycle.

Run `make player-check` and `make player-test` from the repository root.
The shared suite runs on Ubuntu and macOS.
Command crash-point tests use real SQLite with a controllable clock.
Edge integration tests continue to use the same shared implementations.

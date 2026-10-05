# Player Types

Portable native Player values: canonical IDs, SHA-256 digests, bounded strings,
timestamps, injected wall clocks, and the closed capability vocabulary.

This crate performs no I/O. Hosts generate random UUIDs and pass them to
`from_uuid`. Hosts implement `WallClock`; tests can enable `test-util` for
`ManualClock`. Edge owns IPC session IDs, framing, sockets, and wire DTOs.
Existing Edge wire modules reexport the same generic types, so parsing and
serialization stay unchanged.

Run `make player-check player-test` from the repository root. The dependency
boundary and extraction order are specified in
[`docs/player-core.md`](../../docs/player-core.md).

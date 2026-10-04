# Player State

One SQLite database contains native Player metadata and historical Edge tables.
All seven shipped migrations move byte for byte. Opening still uses WAL,
`synchronous = FULL`, foreign keys, `BEGIN IMMEDIATE` migrations, newer-schema
refusal, and optional integrity checking. Errors never recreate the database.

Core-owned repositories cover binding, manifests, CAS metadata, commands,
configuration, playback, renderer recovery, capabilities, daemon identity and
Activity outbox. The Edge crate `edge-state::platform` owns update jobs, Linux
Presentation Network recovery, and legacy import bookkeeping. Those repositories
are absent from this crate. Edge callers temporarily retain compatibility
reexports; new shared consumers use this crate directly.

The physical tables stay in the same database for crash and rollback
compatibility. A future host may leave historical Edge tables unused. Keep state
on a local filesystem that supports SQLite WAL. See
[`docs/player-core.md`](../../docs/player-core.md) for ownership and qualification.

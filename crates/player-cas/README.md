# Player CAS

The shared native Player content store owns verification, immutable objects,
partial downloads, resume, pins, eviction, cache limits, source fallback, and
crash reconciliation. Expected size and SHA-256 must match before bytes commit.
The write, fsync, verification, rename, directory sync, and metadata sequence is
unchanged.

The consuming crate owns `SpaceProbe::available_bytes(path)`. Edge's adapter
calls its existing statvfs measurement; tests supply fixed answers. The store
also receives its clock and state database.

Secure opening uses the existing Unix flags on Linux and macOS: no final
symlink following, no FIFO blocking, and size and regular-file checks on the
opened file. Verified renderer reads also require the committed size. Parent
directories stay within the host-owned private store; this is not an arbitrary
filesystem access API. Link, directory, oversize, FIFO, corruption, restart,
resume and eviction tests run on both supported shared-Rust targets.

Edge retains a temporary `edge-cas` adapter with compatibility exports. No shared
crate depends on it. See [`docs/player-core.md`](../../docs/player-core.md).

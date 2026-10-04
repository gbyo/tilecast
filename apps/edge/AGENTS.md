# Tilecast Edge agent guide

This file applies to `apps/edge/`. The repository `AGENTS.md` also applies.
Read [`docs/tilecast-edge.md`](../../docs/tilecast-edge.md) and
[`docs/tilecast-edge-next.md`](../../docs/tilecast-edge-next.md) before a
change. The architecture document is binding. If a change must deviate from
it, stop and write the complete tradeoff first.

Read [`docs/player-core.md`](../../docs/player-core.md) for native Player
ownership and extraction order. It supplements the Linux architecture without
changing process, privilege, wire, persistence, or update guarantees. Shared
values are implemented in `crates/player-types`, and durable state in
`crates/player-state`. Historical Edge-only repositories use
`edge-state::platform`. Verified storage lives in `crates/player-cas`;
`edge-cas::space` supplies Linux free-space providers.
`crates/player-client` owns portable server transport. `edge-server` owns
file stores and Electron import. `crates/player-core` owns native selection,
command delivery, Activity sessions, the CAS origin adapter, renderer recovery
decisions, meaningful-evidence rules, and connection-bound acceptance and
evidence tracking. Core coordinates activation generations, profile checks,
recovery timing, and recovery Activity events. Edge keeps Runtime projection
inputs and constructs status payloads. Edge keeps
renderer transport and decoding. Core owns capture serialization and periodic
preview policy and Watch Live lease and frame coordination. Edge owns media
transport, its expiry clock, display-sleep policy, and cursor configuration.
Runtime presentation data stays opaque to Core. Edge keeps
wire command-result conversion; Core owns result correlation and startup
Website data-clear retry policy. Edge also keeps
fixed command handlers, the migration hold, renderer signal adapters, and
Activity outbox delivery until their extraction stages.
The root Cargo workspace migration is qualified. Remaining shared behavior
extraction follows the contract.
Core owns pairing orchestration and server relationship, credential-rejection,
retry, and persisted clock-sampling policy. Edge supplies private stores,
device metadata, and status surfaces. The server socket and reconciliation
loop remain in Edge until their extraction is complete.
Core owns configuration acceptance, manifest target reconciliation, and native
manifest resource-claim validation and verified preparation, repair, and pinning.
Runtime presentation fields stay opaque.
Core owns native configuration values and active-hours policy. Edge separates
Runtime configuration projection from its Linux platform configuration.
Core owns manifest preparation-worker supervision and target-bound cancellation.
Core owns telemetry sampling, interval counters, serialization, and bounded
offline queue policy. Edge supplies semantic observations and measured gauges.
Edge retains renderer projection and activation coordination until their extraction is complete.

## Fixed decisions

- Edge 1 is a Linux signage player. The Tilecast Server is the only
  authority, and `tilecastd` reconciles directly from it over the ordinary
  player API.
- A player keeps playing from its own SQLite state and verified CAS content
  when the server is unreachable. It never needs another screen.
- One identity model: the normal device credential and installation identity
  check. Do not add node certificates, an Edge CA or an Edge signing
  authority.
- `tilecastd` runs as the fixed `tilecast` account. The renderer runs as the
  same account in a separate, more restricted unit.
- The Linux renderer is WPE WebKit 2.54+ on the WPEPlatform API. Do not add
  Cog, libwpe, WPEBackend-fdo or an Electron renderer bridge.
- Electron and WPE host the shared Tilecast Player Runtime
  (`packages/player-runtime`). Presentation behavior belongs in the runtime,
  never in C. The WPE host stays boring: WPEPlatform and web view lifecycle,
  URI schemes, the `TilecastRuntimeHostV1` adapter and output integration.
  Decide behavior from runtime capabilities, never from a host name, and do
  not add a second WPE-specific runtime.
- The transition is one way: legacy Electron installation, one-time verified
  import (`tilecastd import-legacy`), Edge plus WPE. Do not add shadow modes,
  dual runtimes or a second credential.
- `tilecastd` remains the Linux composition root and process authority. Shared
  native Player behavior moves to Player Core in the documented extraction
  sequence. Presentation behavior stays in Presentation Model and Player Runtime.
  Linux lifecycle, providers, IPC, media transport, legacy import, and updates
  remain Edge-owned. What only the tilecast account's user session can reach
  (PipeWire and WirePlumber) belongs in `tilecast-session-bridge`, which sends
  bounded Tilecast concepts over the `session_bridge` IPC role and never
  audio samples, device names or PipeWire object IDs.
- Prefer the Linux facility to Tilecast code: kernel CEC and i2c-dev (no
  `cec-ctl` or `ddcutil` processes, and no libddcutil in `tilecastd`, because
  it starts shell processes), GStreamer `level` for audio levels,
  libwireplumber for the audio graph, the existing `tilecast-networkd` helper
  for NetworkManager, systemd-logind for idle inhibition, udev and systemd
  for device access. See `docs/tilecast-edge-m9-reuse-review.md`.
- Updates are Player releases of the `edge` family (M10). `tilecastd`
  downloads and verifies them; only the root helper `tilecast-edge-update`
  installs them, through the one `edge-release` installer that the migrator
  also uses. Do not add a second installer, `systemd-sysupdate`, a package
  manager or a subprocess (`tar`, `zstd`, `cp`) to the update path. The
  evaluation is `docs/tilecast-edge-m10-sysupdate-evaluation.md`.
- The update helper has five fixed operations and takes no path, unit name
  or command from a request. It never holds the device credential and has
  no network. Add a capability or relax its sandbox only with an update to
  `docs/tilecast-edge-update-threat-review.md`. The guard units share the
  helper's sandbox; a test compares them line by line.
- An unconfirmed candidate always rolls back after a reboot, and only the
  previous release's helper (the guard) decides that. A rollback never
  migrates `state.db` backwards or recreates it.
- Peer delivery, mesh, relayed state, the Context Engine and PTP are not part
  of Edge 1 (`docs/tilecast-edge-future.md`). Do not add runtime support for
  them.

## Review rules

The rules are in [`docs/tilecast-edge.md`](../../docs/tilecast-edge.md) §19.
The ones most often relevant here:

1. No new root privilege without a written threat-boundary review.
2. No shell invocation with interpolated values. `tilecastd` starts no
   processes.
3. No arbitrary path from server, renderer or legacy input. CAS paths come
   from digests. Download paths pass `OriginBlobSource` validation.
4. Bound every network read, body, frame, list and string. Use the bounded
   types in `edge-protocol`.
5. Content bytes are not trusted until the content store verifies hash and
   size. A source never decides integrity.
6. A durable state transition that can duplicate a command or update needs a
   crash-point test.
7. No secret in logs, tests, fixtures or screenshots. `DeviceCredential`
   redacts itself in `Debug`; keep it so.
8. An IPC protocol change needs fixtures in
   `packages/edge-protocol/fixtures` and tests on the Rust and C sides.
9. Never infer health from process or socket liveness when meaningful
   playback evidence is available.
10. Test release I/O in the packaged sandbox, not only in unit tests.
    systemd's seccomp options change what a syscall returns: for example,
    `RestrictSUIDSGID=` makes `openat2` fail with `ENOSYS`, so the helper
    uses `edge_platform::fs::open_regular_no_links`. `ci/run-migrate-e2e.sh`
    runs the real units.

## Identity invariants

- Verify public installation identity before the device credential is sent.
  `AuthenticatedServer` exists only after `ServerClient::verify_installation`.
- The credential lives in `identity/device-credential` (mode 0600) and never
  crosses IPC.
- Delete the device credential only when the server says it is invalid or
  revoked.
- The player ID is the legacy `playerInstallationId`. It is set once and
  never changes.

## Engineering conventions

- Rust 1.98, edition 2024, root workspace lints. `unsafe_code` is denied.
- Format with `cargo fmt` (`max_width = 120`). Run `make edge-check` and
  `make edge-test` from the repository root. These select Edge packages.
  `--workspace` also includes future native products.
- Edge release version is `apps/edge/release/VERSION`. Do not read it from
  root package metadata. Keep one root lockfile and toolchain.
- Keep the dependency direction in [`README.md`](README.md).
- Shared Player crates must not depend on Edge or its wire layer. Run
  `python3 scripts/ci/check-player-architecture.py` from the repository root.
- Preserve SQLite migration bytes. Shared physical schema compatibility does
  not give Core ownership of historical Edge repositories.
- Keep comments for behavior that the code does not show.
- Prefer real components and small fakes over mocks: tests run real sockets
  and real SQLite on loopback and temporary directories.
- Before a completion claim, run the workspace checks, `ci/test-linux.sh` in
  the Linux image, and the end-to-end scripts that cover the change.

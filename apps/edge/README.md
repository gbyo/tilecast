# Tilecast Edge

Tilecast Edge is the Linux player platform that replaces the Electron Linux
Player. It has three processes:

- `tilecastd` is the unprivileged daemon. It owns the server relationship,
  the device credential, state, the content store, supervision and machine
  integration.
- `tilecast-renderer-wpe` is the display engine: a small WPE WebKit host for
  the shared Tilecast Player Runtime (`packages/player-runtime`, the same
  runtime the Electron player hosts). It shows what `tilecastd` sends and
  reports what happened. See [`renderer-wpe/README.md`](renderer-wpe/README.md)
  and [`docs/player-runtime.md`](../../docs/player-runtime.md).
- `tilecast-session-bridge` is a small user-session process for what only
  the tilecast account's session can see: the PipeWire audio inventory
  through WirePlumber, and derived microphone levels for the Noise Meter.
  See
  [`docs/tilecast-edge.md`](../../docs/tilecast-edge.md) §4.4 and
  [`session-bridge/`](session-bridge/).

Two root programs install and change releases. Neither is a long-running
service, and neither can read the device credential:

- `tilecast-edge-migrate` installs the first release and runs the one-way
  migration from the Electron player (M7). An operator starts it.
- `tilecast-edge-update` stages, activates, confirms and rolls back signed
  updates (M10). Its socket starts it for `tilecastd`'s requests, and the
  update guard units run the previous release's copy of it. See
  [`docs/tilecast-edge-update-threat-review.md`](../../docs/tilecast-edge-update-threat-review.md).

The Tilecast Server is the only authority. `tilecastd` reconciles directly
from it and keeps playing from local state when it is unreachable.

Milestones M1 to M10 are software-complete and merged. Physical hardware
qualification (M11) is not started, so Edge is not qualified for production
screens yet.

The design is [`docs/tilecast-edge.md`](../../docs/tilecast-edge.md). The
current state and the next work are in
[`docs/tilecast-edge-next.md`](../../docs/tilecast-edge-next.md). Review rules
for this directory are in [`AGENTS.md`](AGENTS.md).

## Crates

| Crate                   | Responsibility                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edge-protocol`         | Contracts only: IDs, digests, time, bounded text, capabilities, the IPC v1 messages. No I/O.                                                                            |
| `edge-state`            | SQLite state with embedded migrations and typed repositories.                                                                                                           |
| `edge-platform`         | Paths, systemd notify and watchdog, disk probes, capability providers, display control (kernel CEC and DDC/CI; `display/kernel.rs` is the one audited `unsafe` module). |
| `edge-cas`              | The content-addressed store: verified commit, crash reconciliation, pins, eviction, the `BlobSource` trait and the multi-source `Fetcher`.                              |
| `edge-ipc`              | The versioned Unix socket server and client (length-prefixed frames, handshake, peer UID policy).                                                                       |
| `edge-server`           | The Tilecast Server client: URL policy, identity gate, device credential, heartbeat, one-time legacy import, origin `BlobSource`.                                       |
| `edge-release`          | Signed releases: the update envelope, the release manifest, the verified archive reader, and the one installer (stage, verify, activate) for migration and updates.     |
| `tilecastd`             | The daemon: lifecycle, IPC handler, presentation engine, supervisor, server link, `import-legacy`.                                                                      |
| `tilecastctl`           | The operator command line over IPC.                                                                                                                                     |
| `tilecast-edge-migrate` | The root installer and the one-way migration from the Electron player (M7).                                                                                             |
| `tilecast-edge-update`  | The root update helper: five fixed operations on its socket, the root transaction record, and the guard (M10).                                                          |

### Dependency direction

A crate depends only on crates above it in this list. `edge-protocol` has no
internal dependency. Only `tilecastd` combines the server client, the content store and the state.

```text
edge-protocol
├── edge-state
├── edge-platform
├── edge-ipc
├── edge-cas          (protocol, state, platform)
├── edge-server       (protocol, state, cas)
├── edge-release      (protocol, platform)
├── tilecastctl       (protocol, ipc, platform)
├── tilecastd         (all of the above)
├── tilecast-edge-migrate (protocol, ipc, platform, release)
└── tilecast-edge-update  (protocol, ipc, platform, release)
```

Rules that follow from the direction:

- Only `edge-server` holds the device credential, and only an
  `AuthenticatedServer` (obtained after the installation identity check) can
  send it.
- The root programs do not depend on `edge-server`, `edge-cas` or
  `edge-state`. The update helper reads a content-store object only through
  a path that it makes from the digest, and copies it before it verifies it.
- `edge-server`'s origin source and local files are `BlobSource`
  implementations. The content store verifies every byte from either. A new
  source is a new `BlobSource`, never a second write path.

## Build and test

Toolchain: Rust 1.98 (`rust-toolchain.toml`). From this directory:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Linux is the target platform. Run the same checks in the development image:

```sh
docker build -t tilecast-wpe-dev -f renderer-wpe/ci/Dockerfile renderer-wpe/ci
docker build -t tilecast-edge-dev -f renderer-wpe/ci/Dockerfile.edge renderer-wpe/ci
docker run --rm -v "$PWD/../..:/src" -v tilecast-edge-target:/target tilecast-edge-dev /src/apps/edge/ci/test-linux.sh
```

End-to-end checks:

- `renderer-wpe/ci/run-e2e.sh` builds the daemon and the WPE renderer and runs
  the headless scenarios (status surface, daemon restart, renderer crash,
  image, H.264 video, transitions, render-tree widget, layout).
- `ci/e2e_server.py` runs a real Tilecast Server against PostgreSQL, pairs a
  screen through the HTTP API, then runs `tilecastd import-legacy`, the
  identity gate, the ordinary heartbeat and revocation with the real binaries.
  Run it from the repository root: `apps/edge/ci/e2e_server.py`. WPE content
  activation is exercised only when `--renderer`, `--runtime-dir`, and
  `--gst-plugin-dir` are supplied together.
- `ci/run-e2e-server.sh` runs the same script with a real WPE renderer in the
  `tilecast-edge-e2e` image (`ci/Dockerfile.e2e`: Go, PostgreSQL and FFmpeg
  added to `tilecast-edge-dev`). It adds the content phase: an uploaded image
  and video in a playlist, a Clock layout (time-bound widgets tick in place),
  a QR Code layout, and offline restart from the cache.

- `ci/run-migrate-e2e.sh` runs the migrator and the update helper under real
  systemd in the `tilecast-edge-migrate-e2e` image (`ci/Dockerfile.migrate`),
  with a real server. After the M7 phases (install, import failure, crash,
  power loss during settlement, acceptance), `ci/update_e2e.py` runs the M10
  updates: A, a resumed download and a confirmed update from 0.1.0 to 0.2.0;
  B, a power loss while 0.3.0 is provisional, rolled back at boot by 0.2.0's
  helper; C, a broken 0.4.0 that the guard rolls back and never activates
  again.

M9 hardware checks:

- `ci/run-kernel-cec.sh` (Linux host with sudo) loads the `vivid` driver,
  runs `cec-follower` as the TV and drives the player adapter through the
  kernel CEC UAPI, with `cec-ctl` as the reference.
- `cargo test -p tilecastd --test presentation_network` runs the Presentation
  Network client against the real `tilecast-networkd` script with a fake
  `nmcli` (needs `python3`).
- `session-bridge` builds with CMake (`gio`, `json-glib`, `gstreamer-1.0`,
  `wireplumber-0.5`); `ctest` checks its frames against the IPC fixtures.

Every test daemon uses empty `dev.hardware_dev_dir` and
`dev.hardware_sys_dir` roots, so no test reaches a real display.

`tilecastd/tests/playback.rs` (Linux) runs a real daemon against a fake
server and a scripted renderer for the manifest races: supersession, stale
evidence, restarts during a trial, failed and corrupt downloads, and typed
incompatibility.

The repository `Makefile` has `edge-check`, `edge-test`, `edge-linux` and
`edge-e2e` targets.

## Packaging

[`packaging/`](packaging/) has the systemd units, the user units of the
session bridge, the `sysusers.d`, `tmpfiles.d`, `modules-load.d` and udev
files, and the installation and migration procedure.

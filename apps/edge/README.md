# Tilecast Edge

Tilecast Edge is the Linux player platform that replaces the Electron Linux
Player. It has two processes:

- `tilecastd` is the unprivileged daemon. It owns the server relationship,
  the device credential, state, the content store, supervision and machine
  integration.
- `tilecast-renderer-wpe` is the display engine: a small WPE WebKit host for
  the shared Tilecast Player Runtime (`packages/player-runtime`, the same
  runtime the Electron player hosts). It shows what `tilecastd` sends and
  reports what happened. See [`renderer-wpe/README.md`](renderer-wpe/README.md)
  and [`docs/player-runtime.md`](../../docs/player-runtime.md).

The Tilecast Server is the only authority. `tilecastd` reconciles directly
from it and keeps playing from local state when it is unreachable.

The design is [`docs/tilecast-edge.md`](../../docs/tilecast-edge.md). The
current state and the next work are in
[`docs/tilecast-edge-next.md`](../../docs/tilecast-edge-next.md). Review rules
for this directory are in [`AGENTS.md`](AGENTS.md).

## Crates

| Crate           | Responsibility                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `edge-protocol` | Contracts only: IDs, digests, time, bounded text, capabilities, the IPC v1 messages. No I/O.                                               |
| `edge-state`    | SQLite state with embedded migrations and typed repositories.                                                                              |
| `edge-platform` | Paths, systemd notify and watchdog, disk probes, capability providers.                                                                     |
| `edge-cas`      | The content-addressed store: verified commit, crash reconciliation, pins, eviction, the `BlobSource` trait and the multi-source `Fetcher`. |
| `edge-ipc`      | The versioned Unix socket server and client (length-prefixed frames, handshake, peer UID policy).                                          |
| `edge-server`   | The Tilecast Server client: URL policy, identity gate, device credential, heartbeat, one-time legacy import, origin `BlobSource`.          |
| `tilecastd`     | The daemon: lifecycle, IPC handler, presentation engine, supervisor, server link, `import-legacy`.                                         |
| `tilecastctl`   | The operator command line over IPC.                                                                                                        |

### Dependency direction

A crate depends only on crates above it in this list. `edge-protocol` has no
internal dependency. Only `tilecastd` depends on more than one service crate.

```text
edge-protocol
├── edge-state
├── edge-platform
├── edge-ipc
├── edge-cas          (protocol, state, platform)
├── edge-server       (protocol, state, cas)
├── tilecastctl       (protocol, ipc, platform)
└── tilecastd         (all of the above)
```

Rules that follow from the direction:

- Only `edge-server` holds the device credential, and only an
  `AuthenticatedServer` (obtained after the installation identity check) can
  send it.
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

`tilecastd/tests/playback.rs` (Linux) runs a real daemon against a fake
server and a scripted renderer for the manifest races: supersession, stale
evidence, restarts during a trial, failed and corrupt downloads, and typed
incompatibility.

The repository `Makefile` has `edge-check`, `edge-test`, `edge-linux` and
`edge-e2e` targets.

## Packaging

[`packaging/`](packaging/) has the systemd units, the `sysusers.d` file and
the installation and migration procedure.

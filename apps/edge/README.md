# Tilecast Edge

Tilecast Edge is the Linux player platform that replaces the Electron Linux
Player. It has two processes:

- `tilecastd` is the unprivileged daemon. It owns the server relationship,
  identity, state, the content store, the peer fabric, supervision and
  machine integration.
- `tilecast-renderer-wpe` is the display engine. It shows what `tilecastd`
  sends and reports what happened. See [`renderer-wpe/README.md`](renderer-wpe/README.md).

The design is [`docs/tilecast-edge.md`](../../docs/tilecast-edge.md), with
Amendment A1 (WPE-first renderer, one-time migration). The current state and
the next work packages are in
[`docs/tilecast-edge-next.md`](../../docs/tilecast-edge-next.md). Review rules
for this directory are in [`AGENTS.md`](AGENTS.md).

## Crates

| Crate           | Responsibility                                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edge-protocol` | Contracts only: IDs, digests, time, bounded text, canonical JSON, signed envelopes (server change, revocation snapshot, node statement), capabilities, the renderer IPC v1 messages. No I/O. |
| `edge-state`    | SQLite state with embedded migrations and typed repositories.                                                                                                                                |
| `edge-platform` | Paths, systemd notify and watchdog, disk probes, capability providers.                                                                                                                       |
| `edge-cas`      | The content-addressed store: verified commit, crash reconciliation, pins, eviction, the `BlobSource` trait and the multi-source `Fetcher`.                                                   |
| `edge-identity` | Node key, CSR, peer certificate verification, revocation set, rustls mTLS configurations, renewal schedule.                                                                                  |
| `edge-ipc`      | The versioned Unix socket server and client (length-prefixed frames, handshake, peer UID policy).                                                                                            |
| `edge-server`   | The Tilecast Server client: URL policy, identity gate, device credential, one-time legacy import, Edge enrollment, change feed, origin `BlobSource`.                                         |
| `edge-cdn`      | The mTLS peer blob service, the peer `BlobSource` and peer ranking.                                                                                                                          |
| `edge-mesh`     | The Zenoh fabric: TLS-only sessions, presence, signed node statements, object availability, change hints.                                                                                    |
| `tilecastd`     | The daemon: lifecycle, IPC handler, presentation engine, supervisor, server link, fabric, `import-legacy`.                                                                                   |
| `tilecastctl`   | The operator command line over IPC.                                                                                                                                                          |

### Dependency direction

A crate depends only on crates above it in this list. `edge-protocol` has no
internal dependency. Only `tilecastd` depends on more than one service crate.

```text
edge-protocol
├── edge-state
├── edge-platform
├── edge-identity
├── edge-ipc
├── edge-cas          (protocol, state, platform)
├── edge-server       (protocol, state, cas, identity)
├── edge-cdn          (protocol, cas, identity)
├── edge-mesh         (protocol, identity)
├── tilecastctl       (protocol, ipc, platform)
└── tilecastd         (all of the above)
```

Rules that follow from the direction:

- `edge-mesh` never moves content bytes. It returns verified claims, and
  `tilecastd` turns them into `edge-cdn` sources.
- `edge-cdn` and `edge-server` are both `BlobSource` implementations. The
  content store verifies every byte from either.
- Only `edge-server` holds the device credential. Only `edge-identity`
  decides fabric membership (`verify_peer`).

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
  screen through a locally trusted HTTPS endpoint, then runs `tilecastd
  import-legacy`, Edge enrollment, authenticated player WebSocket presence,
  server manifest fetch, assigned-image origin download and CAS verification,
  server restart/reconnect, clock sampling, disable/enable and live revocation
  with the real binaries. It does not yet prove WPE activation.
  Run it from the repository root: `apps/edge/ci/e2e_server.py`.

The repository `Makefile` has `edge-check`, `edge-test`, `edge-linux` and
`edge-e2e` targets.

## Packaging

[`packaging/`](packaging/) has the systemd units, the `sysusers.d` file and
the installation and migration procedure.

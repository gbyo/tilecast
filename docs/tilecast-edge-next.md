# Tilecast Edge: state and next work

This document is the implementation ledger for Tilecast Edge 1. It records what exists, what is proven, what is missing, and how to continue without breaking the architecture.

Read in this order:

1. [`tilecast-edge.md`](tilecast-edge.md): the Edge 1 architecture. It is binding. If a change must deviate from it, stop and write the complete tradeoff first.
2. [`apps/edge/AGENTS.md`](../apps/edge/AGENTS.md): fixed decisions and review rules for the code.
3. [`apps/edge/README.md`](../apps/edge/README.md): crates, dependency direction, build and test commands.
4. This document.

Work that is not part of Edge 1 is in [`tilecast-edge-future.md`](tilecast-edge-future.md). Do not start it from here.

## 1. Current state

### 1.1 What exists and is proven

| Area                          | State                                                                                                                                                               | Proof                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts (`edge-protocol`)   | IDs, digests, time, bounded text, capability model, IPC v1.                                                                                                         | Unit tests; golden IPC fixtures in `packages/edge-protocol/fixtures/ipc` (`tests/fixtures.rs`).                                                                                        |
| State (`edge-state`)          | SQLite with embedded migrations, newer-schema refusal, integrity check after an unclean shutdown, typed repositories.                                               | `tests/state.rs`.                                                                                                                                                                      |
| Daemon lifecycle              | `Type=notify`, watchdog gated on a state query, recovery mode on state failure, clean shutdown with WAL checkpoint.                                                 | `tilecastd/tests/daemon.rs`.                                                                                                                                                           |
| Local IPC (`edge-ipc`)        | Versioned framing, handshake, UID policy, role checks, backpressure, renderer supersession.                                                                         | `tests/ipc.rs` and a policy unit test.                                                                                                                                                 |
| `tilecastctl`                 | `status`, `capabilities`, `cache`, `self-test`.                                                                                                                     | Used by both end-to-end scripts.                                                                                                                                                       |
| WPE renderer                  | WPEPlatform (drm, wayland, headless), the trusted runtime, the `tcmedia` scheme and `tcmediasrc` GStreamer source.                                                  | `renderer-wpe/ci/run-e2e.sh`: status surface, daemon restart, renderer crash, image, H.264 video, transitions, render-tree widget, layout. Real WPE WebKit 2.54 in the headless image. |
| Supervision                   | Evidence-based recovery ladder, safe mode, incompatible-presentation surface.                                                                                       | `supervisor.rs` unit tests; headless crash scenarios.                                                                                                                                  |
| Content store (`edge-cas`)    | Verified commit order, crash reconciliation, one writer per digest, pins, LRU by domain, free-space reserve, multi-source fetch with resume and integrity fallback. | `tests/cas.rs`.                                                                                                                                                                        |
| Server client (`edge-server`) | URL policy, identity gate by type, device credential at rest, ordinary heartbeat, origin `BlobSource` with `If-Range` resume.                                       | Unit tests; `tests/server.rs` against a fake server; `ci/e2e_server.py` against the real server.                                                                                       |
| Legacy import                 | One-time, read-only, idempotent import of the Electron player's identity, binding, credential, command idempotency, playback flag, clock offset and verified media. | `tests/server.rs`; `ci/e2e_server.py`.                                                                                                                                                 |
| Server link in the daemon     | Identity gate, then `POST /api/v1/player/heartbeat`; credential deleted only on `device_credential_invalid` or `device_credential_revoked`; bounded retry.          | `ci/e2e_server.py`: heartbeat visible on the screen record, revocation removes the credential.                                                                                         |
| Capabilities                  | Provider registry with timeouts and degradation; systemd, host time sync, WPE platform, renderer and state-store capabilities.                                      | `edge-platform` unit tests; `tests/state.rs`.                                                                                                                                          |

All Rust checks pass on macOS and in the Linux image (`apps/edge/ci/test-linux.sh`). The server has no Edge-specific code.

### 1.2 What a migrated screen does today

A screen migrated with `tilecastd import-legacy`:

- keeps its player ID (the legacy `playerInstallationId`), server binding and device credential;
- verifies installation identity and sends the ordinary heartbeat, so Studio shows it as a contacted screen;
- deletes its credential when the server reports it revoked;
- shows the status surface in the WPE renderer.

It does **not** yet:

- hold the player WebSocket (M2);
- fetch the manifest, so it plays no server content (M3);
- run commands (M4);
- pair on its own; a fresh installation without legacy state cannot bind (M5);
- report proof of play or telemetry (M8).

Do not migrate a production screen before milestones M2 to M5 and M7 are done.

## 2. Invariants

These hold across every milestone.

1. **One credential owner.** Only `edge-server` reads the device credential, and only `AuthenticatedServer` sends it. Obtain one only through `ServerClient::verify_installation`.
2. **Identity before credential.** Normalize the URL with `url_policy::normalize_server_url`, read `/api/v1/system/identity`, require the bound installation ID, then send the credential.
3. **Credential deletion.** Delete it only on `ServerError::CredentialRejected`. Never on a network error, 5xx or `screen_disabled`.
4. **The server is the only authority.** Server state arrives only from the authenticated server. Push events wake reconciliation; they never replace it.
5. **Offline first.** Readiness and playback never wait for the server. A failed reconciliation never replaces the last good state.
6. **Bytes are verified.** Every `BlobSource` feeds the content store, which checks size and SHA-256 before promotion. Add sources; do not add a second write path.
7. **The renderer holds nothing secret.** It gets content references for objects listed in the current activation and reports evidence. Everything else is in `tilecastd`.
8. **One-way migration.** Never modify or delete legacy files. No shadow mode, no dual runtime, no second credential.
9. **Health from evidence.** Supervisor decisions use meaningful playback evidence, not process or socket liveness.

## 3. Next work

The milestones are in [`tilecast-edge.md`](tilecast-edge.md) §18.1. M1 is this foundation. The open pull requests continue it:

| Milestone                | Pull request | Notes                                                                                                                             |
| ------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| M2 Server presence       | Edge W1      | Player WebSocket, fallback heartbeat, server clock sampling. Builds on `AuthenticatedServer::player_heartbeat` and `server_link`. |
| M3 Manifests and content | Edge W2      | Manifest reconciliation, CAS preparation, the daemon-owned media capability channel, schedule selection.                          |

Each later milestone uses the same three headings in its pull request description:

- **Use:** existing code to build on. Do not write a second version of it.
- **Implement:** the work.
- **Do not change:** the invariants in §2.

## 4. Known limitations

- **Physical hardware:** the renderer is proven in the headless image only. DRM on real display hardware and Wayland kiosks need device validation (M11).
- **Renderer media access:** in this foundation the renderer opens CAS objects read-only through `tcmedia`, limited to digests in the current activation. The daemon-owned media capability channel (M3) removes the renderer's CAS read access.
- **Safe mode** lasts until the daemon restarts; there is no clear command yet (M4).
- **Heartbeat fields** are minimal: version, uptime, storage and cache usage. Playback fields arrive with M2 and M3.

## 5. Test map

| Command                                                         | Covers                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `cd apps/edge && cargo test --workspace`                        | All Rust unit and integration tests.                                      |
| `apps/edge/ci/test-linux.sh` (in `tilecast-edge-dev`)           | The same on Linux, with fmt and clippy.                                   |
| `apps/edge/renderer-wpe/ci/run-e2e.sh` (in `tilecast-edge-dev`) | Daemon plus real WPE renderer scenarios.                                  |
| `apps/edge/ci/e2e_server.py`                                    | Real server pairing, legacy import, identity gate, heartbeat, revocation. |

An IPC protocol change needs fixtures in `packages/edge-protocol/fixtures` and tests on the Rust and C sides.

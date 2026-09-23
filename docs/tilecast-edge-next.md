# Tilecast Edge: state and next work

This document is the handoff for the next implementation phase of Tilecast
Edge. It records what exists, what is proven, what is missing, and how to
continue without breaking the architecture.

Read in this order:

1. [`tilecast-edge.md`](tilecast-edge.md), including Amendment A1. The RFC is
   binding. A1 supersedes the Electron-renderer and shadow-mode sections.
2. [`apps/edge/AGENTS.md`](../apps/edge/AGENTS.md): fixed decisions and
   review rules.
3. [`apps/edge/README.md`](../apps/edge/README.md): crates, dependency
   direction, build and test commands.
4. This document.

Each work package below uses three headings:

- **Use**: existing code to build on. Do not write a second version of it.
- **Implement**: the work.
- **Do not change**: invariants the work must keep.

## 1. Current state

### 1.1 What exists and is proven

| Area                                     | State                                                                                                                                                                                        | Proof                                                                                                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts (`edge-protocol`)              | Canonical JSON (JCS subset), signed envelopes (`server.change`, `server.snapshot`, `node.statement`), IPC v1, capability model, bounded types.                                               | 47 unit tests; cross-language fixtures in `packages/edge-protocol/fixtures` reproduced byte for byte by the Go signer (`internal/edge/fixtures_test.go`).                              |
| State (`edge-state`)                     | SQLite with embedded migrations, integrity check after unclean shutdown, typed repositories for every table.                                                                                 | 12 tests.                                                                                                                                                                              |
| Daemon lifecycle                         | `Type=notify`, watchdog, recovery mode on state failure, clean shutdown with WAL checkpoint.                                                                                                 | `tilecastd/tests/daemon.rs`.                                                                                                                                                           |
| Renderer IPC                             | Versioned framing, handshake, UID policy, backpressure, renderer supersession.                                                                                                               | 11 integration tests plus a policy unit test.                                                                                                                                          |
| WPE renderer                             | WPEPlatform (drm, wayland, headless), `tcmedia` scheme and `tcmediasrc` GStreamer source, the reference DOM runtime unmodified.                                                              | `renderer-wpe/ci/run-e2e.sh`: status surface, daemon restart, renderer crash, image, H.264 video, transitions, render-tree widget, layout. Real WPE WebKit 2.54 in the headless image. |
| Content store (`edge-cas`)               | Verified commit order, crash reconciliation, single writer per digest, pins, LRU by domain, free-space reserve, multi-source fetch with resume.                                              | 12 tests.                                                                                                                                                                              |
| Server Edge authority (Go)               | Authority and CA keys under `TILECAST_EDGE_ROOT`, pinned public identity, CSR validation, certificate issuance, outbox plus serialized signer, revocation hook inside credential revocation. | 5 PostgreSQL integration tests; `internal/edge` unit tests.                                                                                                                            |
| Identity (`edge-identity`)               | Node key, CSR, `verify_peer`, revocation set, TLS 1.3 mTLS configurations.                                                                                                                   | 3 unit and 3 integration tests.                                                                                                                                                        |
| Server client and import (`edge-server`) | URL policy, identity gate by type, device credential at rest, one-time legacy import, enrollment with independent response verification, change feed consumer, origin `BlobSource`.          | 3 unit and 6 integration tests against a fake server; `ci/e2e_server.py` against the real server.                                                                                      |
| Peer CDN (`edge-cdn`)                    | mTLS blob service, peer `BlobSource`, ranking and suppression.                                                                                                                               | 4 unit and 3 socket tests (resume, strict HTTP, foreign CA, live revocation, corrupt peer fallback).                                                                                   |
| Mesh (`edge-mesh`)                       | Zenoh 1.10 peer mode, TLS only, presence, signed statements, object availability, change hints.                                                                                              | 1 unit and 2 loopback TLS tests (discovery, reconnect, foreign CA, revoked member).                                                                                                    |
| Fabric in the daemon                     | Interface policy, blob service and mesh after enrollment, shared feed applier, relay, `fabric::peer_sources`.                                                                                | `tilecastd/tests/fabric.rs`: two daemons, peer fetch, relayed revocation.                                                                                                              |

All Rust checks pass on macOS and in the Linux image
(`apps/edge/ci/test-linux.sh`). The Go suite passes with PostgreSQL.

### 1.2 What a migrated screen does today

A screen migrated with `tilecastd import-legacy`:

- keeps its node ID (the legacy `playerInstallationId`), server binding and
  device credential;
- enrolls an Edge certificate, pins the Edge CA and authority, and reconciles
  the signed change feed;
- posts Edge status, which `GET /api/v1/edge/nodes` shows;
- holds normal player WebSocket presence with an HTTP heartbeat fallback;
- runs the peer fabric when `mesh.enabled`;
- shows the status surface in the WPE renderer.

It does **not** yet:

- fetch the manifest, so it plays no server content;
- run commands;
- report proof of play or telemetry;
- pair on its own (a fresh installation without legacy state cannot bind).

Do not migrate a production screen before W0 through W5 and the real playback
acceptance path are done.

## 2. Invariants (do not change)

These hold across every work package.

1. **One credential owner.** Only `edge-server` reads the device credential,
   and only `AuthenticatedServer` sends it. Obtain one only through
   `ServerClient::verify_installation`.
2. **Identity before credential.** Normalize the URL with
   `url_policy::normalize_server_url`, read `/api/v1/system/identity`, require
   the bound installation ID, then send the credential.
3. **Credential deletion.** Delete it only on `device_credential_invalid` or
   `device_credential_revoked` (`ServerError::CredentialRejected`). Never on a
   network error, 5xx or `screen_disabled`.
4. **The Edge key stays in `tilecastd`.** Generated by `enrollment::enroll`,
   stored mode 0600, never sent over IPC.
5. **Pinned trust.** The first enrollment pins the CA and authority key.
   `EnrollError::TrustChanged` refuses a different one.
6. **Monotonic feed.** Reconcile with `after = last applied sequence`. The
   signed `previousSequence` chain proves continuity. Integer gaps are normal.
   Peer changes go through the same verifier and never set the baseline.
7. **Server authority.** Zenoh carries hints. A hint wakes reconciliation; it
   never replaces a server read.
8. **Bytes are verified.** Every `BlobSource` feeds the content store, which
   checks size and SHA-256 before promotion. Add sources; do not add a second
   write path.
9. **Media never travels over Zenoh.** Mesh payloads are capped at 64 KiB.
10. **Fabric membership is `verify_peer`.** Discovery, addresses and
    liveliness never imply trust.
11. **The renderer holds nothing secret.** It gets content URIs for digests
    listed in the current activation and reports evidence. Everything else is
    in `tilecastd`.
12. **One-way migration.** Never modify or delete legacy files. No shadow
    mode, credential leasing or CSR delegation.
13. **Health from evidence.** Supervisor decisions use meaningful playback
    evidence, not process or socket liveness.

## 3. Work packages

Priority P0 blocks production use. P1 completes Edge v1. P2 follows.

### W0 (P0, server) Back up and restore the Edge root

The server backup archives the database, media and updates. It does not
include `TILECAST_EDGE_ROOT` (`/data/edge`). After a restore the
`edge_authority` row exists but its key files do not, so every Edge endpoint
answers `edge_authority_unavailable` and every enrolled node is stranded. This
is correct recovery behavior (keys are never regenerated silently), but the
backup is incomplete.

- **Use:** `internal/backup` (`files.go` staging, activation and rollback for
  `mediaRoot` and `updatesRoot`; `manifest.go` path validation);
  `edge.LoadOrInitAuthority` for the post-restore check.
- **Implement:**
  1. Add the Edge root as a third archived root when Edge is enabled, with the
     same staging, activation, rollback and validation steps.
  2. Decide and document how archives protect the two private keys. They are
     installation secrets equal in weight to the database.
  3. After restore, call `Service.Initialize` again and report
     `ErrAuthorityMissing` in the restore result.
  4. Integration test: back up, delete `/data/edge`, restore, enroll a node.
- **Do not change:** a missing authority never generates new keys.

Until W0 lands, operators must copy `/data/edge` with every backup
([`deployment.md`](deployment.md)).

### W1 (P0) Player presence: heartbeat and socket

The normal HTTP heartbeat fallback and authenticated WebSocket are implemented.
The real-server E2E covers online presence, server restart/reconnect,
disable/enable without credential loss, clock sampling and live revocation.
Playback identifiers will be populated when W2 activates server content.

- **Use:** `tilecastd::server_link` (one task, one credential owner, backoff);
  `AuthenticatedServer` (add methods there); the reference
  `apps/player-linux/src/core/socket.ts` and the heartbeat in
  `apps/player-linux/src/core/player.ts`; `docs/player-protocol.md`.
- **Implement:** the authenticated WebSocket with fallback heartbeat, the same
  fields and cadence as the Linux player, and server clock offset
  (`playback::put`, `core/clock.ts`). Feed renderer and capability state into
  the heartbeat fields the server already accepts.
- **Do not change:** server status authority (`internal/devices/status.go`).
  Edge status (`/player/edge/status`) never updates `lastContactAt`.
- **Done when:** a migrated screen shows `online` in Studio, survives server
  restart, and a live revocation disconnects it (extend `ci/e2e_server.py`).

### W2 (P0) Manifest, downloads and activation

The identity-gated server client now reads the existing manifest endpoint with
bounded response size and conditional ETags. The daemon has a validation
boundary for the server-compiled manifest's target screen, asset identities,
hash/size claims and origin paths. It also derives the exact required-download
variants from playlists, branding, website fallbacks, layouts and Brand Bug,
and records variants requiring streaming separately. It is not yet connected
to preparation.
SQLite now has binding-scoped pending, active and previous manifest records,
with atomic promotion after a future preparation step. Preparation,
scheduling, renderer media capabilities and activation remain open. The final
RFC requires replacing the foundation's raw digest media URI/CAS-root access
before real server content is activated.

- **Use:**
  - `edge_cas::Fetcher` with sources in this order:
    `tilecastd::fabric::peer_sources(context, digest, size)`, then
    `edge_server::origin::OriginBlobSource::new(server, download_path)`;
    pass `tilecastd::fabric::peer_observer(context, digest)`.
  - `PresentationEngine::activate` and the CAS pins
    (`PinReason::PendingPresentation`, `ActivePresentation`).
  - The imported cached manifest (`legacy` summary `manifestSha256`,
    `Domain::LegacyState`) for offline start; replace the `Migration` pins
    (`legacy::PIN_HOLDER`) after the first server activation.
  - The reference `core/manifest.ts` (`requiredDownloads`, cache identity),
    `core/schedule.ts`, `core/selection.ts`, `core/download.ts`.
  - Wake on `feed::Wake::Change(ChangeType::ScreenPresentationChanged)` and
    `Wake::Resynced`; the server link already produces them.
- **Implement:** fetch `/api/v1/player/manifest` with ETag, prepare every
  required variant into the CAS, activate at item boundary, keep the previous
  manifest for offline playback, and port schedule selection. Replace the
  development fixture source; keep the fixture for CI.
- **Server:** publish `screen.presentation.changed` (and
  `screen.configuration.changed`) change envelopes through `edge.AppendChange`
  inside the transactions that change assignments. Only `edge.node.revoked` is
  published today.
- **Do not change:** RFC §52.1: do not build a second presentation compiler.
  Content URIs stay `tcmedia://sha256/<hex>` and every referenced digest is in
  `content[]`.

### W3 (P0) Commands

- **Use:** `edge_state::repo::commands` (`observe`, `advance`,
  `import_completed`); the imported legacy keys; `core/commands.ts`.
- **Implement:** poll, acknowledge and report results. Record `executing`
  before a disruptive command. Add crash-point tests for every transition.
- **Do not change:** a command that the legacy player ran must not run again.
  No arbitrary execution; each command type is a typed handler.

### W4 (P0) Pairing for new installations

- **Use:** `setup.submit_server_url` (currently answers "not yet"),
  `url_policy`, `ServerClient`, `core/pairing.ts`,
  `daemon::set_node_identity(.., NodeIdentitySource::Generated, ..)`.
- **Implement:** pairing session, visible code on the setup surface, private
  poll, one-time enrollment, credential save. Generate the node ID before the
  pairing request; the server screen's `player_installation_id` must equal it.
- **Do not change:** never poll with the visible code; never store the poll
  secret after enrollment.

### W5 (P0) Installer

- **Use:** `apps/edge/packaging/` (units, `sysusers.d`, `tmpfiles.d`, the
  procedure in `packaging/README.md`).
- **Implement:** a package or installer script that performs the documented
  procedure, including rollback on a failed import, and a signed release
  artifact per `docs/player-updates.md`.
- **Do not change:** no self-replacing binaries; the installer is the only
  privileged step.

### W6 (P1) Proof of play and telemetry

- **Use:** renderer evidence already reaches `PresentationEngine::progress`
  (`EvidenceKind`); `docs/activity.md`; `docs/activity-event-contract.md`.
- **Implement:** the player activity events with the same definitions.
- **Do not change:** the load-bearing metric definitions in those documents.

### W7 (P1) Studio view of Edge nodes

- **Use:** `GET /api/v1/edge/nodes` (Owner and Administrator).
- **Implement:** a Spectrum 2 view: Edge version, renderer state, mesh state
  and peer count, cache use, certificate expiry, capabilities.
- **Do not change:** Edge presence is a separate fact from server status
  (RFC §13.7). Do not merge them.

### W8 (P1) Mesh configuration from the server

- **Use:** `EdgeConfig.mesh` (operator), `edge_mesh::Transport`,
  `ChangeType::EdgeMeshConfigurationChanged`.
- **Implement:** signed, typed server policy for enabling the mesh and peer
  delivery, server-provided seeds (private addresses only, hints), and the
  emergency disables in RFC §47.4.
- **Do not change:** seeds never imply trust; the operator file can always
  turn the mesh off.

### W9 (P1) Authority rotation

- **Use:** `AuthorityTrust.keys` (already a list with epochs), `authority_keys`
  table, `EnrollError::TrustChanged`.
- **Implement:** overlapping epochs announced by a change signed with the old
  key; nodes accept the new key only through that path.
- **Do not change:** a node never trusts a new CA or authority from an
  unauthenticated or unsigned source.

### W10 (P1) Zenoh ACL

After the keyspace in `edge_mesh::keys` is final, add default-deny Zenoh ACLs
that map certificate subjects to their own `nodes/<id>/*` keys (RFC §13.10).
Keep the application checks: they stay mandatory.

### W11 (P2) Renderer breadth

Website, YouTube, Span and remaining render-tree features, each through the
WPE navigation, permission and isolation review (review rule 13).

## 4. Known limitations

- **Mesh interface policy:** the default is the IPv4 default-route interface,
  never wireless unless `mesh.interfaces` names it. IPv6-only LANs and
  multi-homed hosts need explicit configuration.
- **Revoked members can still form a Zenoh link.** Zenoh verifies the chain,
  not the revocation set. Their presence, statements and holder claims are
  ignored, and the blob service refuses them. ACLs (W10) close the link-level
  gap.
- **Liveliness is not signed.** It is used only as a presence hint and to know
  when to ask for statements.
- **Blob service slow readers:** a slow peer holds a transfer permit until its
  connection ends. Transfers are bounded (4) and connections bounded (64).
- **Change relay fan-out:** every node relays each applied change once. This
  is fine for school-size fleets.
- **Physical hardware:** the renderer is proven in the headless image only.
  DRM on real display hardware and Wayland kiosks need device validation.

## 5. Test map

| Command                                                         | Covers                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| `cd apps/edge && cargo test --workspace`                        | All Rust unit and integration tests.                         |
| `apps/edge/ci/test-linux.sh` (in `tilecast-edge-dev`)           | The same on Linux, with fmt and clippy.                      |
| `apps/edge/renderer-wpe/ci/run-e2e.sh` (in `tilecast-edge-dev`) | Daemon plus real WPE renderer scenarios.                     |
| `apps/edge/ci/e2e_server.py`                                    | Real server pairing, import, enrollment, status, revocation. |
| `cd apps/server && TEST_DATABASE_URL=… go test ./...`           | Server Edge authority, issuance, feed, revocation hook.      |

A protocol change needs fixtures in `packages/edge-protocol/fixtures` and a
test in both languages.

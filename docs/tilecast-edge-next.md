# Tilecast Edge: state and next work

This document is the handoff for the next implementation phase of Tilecast
Edge. It records what exists, what is proven, what is missing, and how to
continue without breaking the architecture.

Read in this order:

1. The current `main` version of [`tilecast-edge.md`](tilecast-edge.md). It is
   binding and supersedes this handoff wherever they differ. Amendment A1 and
   older handoff text do not override the current RFC.
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
| Contracts (`edge-protocol`)              | Foundation JCS and signed-envelope contracts (`server.change`, `server.snapshot`, `node.statement`), IPC v1, capabilities and bounded types. These do not yet implement current RFC §15's three-stream/checkpoint model. | Foundation tests and fixtures pass; they do not prove conformance to the current signed-stream RFC. |
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

This table records foundation behavior. It is not evidence that P0 is complete
against the current RFC. In particular, the existing global change feed,
authority recovery, migration flow and packaging predate the final hardening
in `main`; use the RFC's per-security, per-policy and per-screen streams,
encrypted Edge Recovery Bundle, two-phase migration fence, and systemd socket
ownership when finishing those areas.

### 1.2 What a migrated screen does today

A screen migrated with `tilecastd import-legacy`:

- keeps its node ID (the legacy `playerInstallationId`), server binding and
  device credential;
- enrolls an Edge certificate, pins the Edge CA and authority, and reconciles
  the signed change feed;
- conditionally fetches and validates the assigned player manifest, prepares
  supported image/video assets through verified CAS, and sends prepared
  server candidates to the presentation controller;
- posts Edge status, which `GET /api/v1/edge/nodes` shows;
- holds normal player WebSocket presence with an HTTP heartbeat fallback;
- runs the peer fabric when `mesh.enabled`;
- shows the status surface in the WPE renderer.

The new manifest-to-WPE path has not yet been proven by one real-server E2E.
The headless renderer suite uses fixture content and does not prove an assigned
server presentation appeared on screen. Layouts, widgets and websites are also
not supported by the current manifest mapper. Commands, fresh-install pairing
and the production installer remain absent.

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

### W0 (P0, server) Edge trust backup and restore

W0 is not implemented. Do not satisfy it by adding `/data/edge` to the
ordinary unencrypted archive. Current RFC §§12.1–12.11 define a trust realm,
independent security lineage, recoverable security snapshot and encrypted
Edge Recovery Bundle (ERB). The ordinary backup must not contain raw CA or
authority private keys.

- **Use:** `apps/server/internal/backup` staging/activation/rollback and path
  validation; `apps/server/internal/edge.LoadOrInitAuthority` and
  `Service.Initialize`.
- **Implement:** ERB creation/import using a maintained authenticated
  encryption format and operator-held recovery material; pair each ordinary
  backup with security lineage/generation/head and an ERB fingerprint; stage
  restored trust files until DB/files validate; overlay the matching or newer
  security snapshot before publishing recovery state; create a fresh opaque
  `stateIncarnationId` for rollback-style restore; preserve security lineage
  and revocations; quarantine cross-installation mismatch pending explicit
  trust reset/re-enrollment. Integrate ERB pointers into the existing
  prepare/activate/finalize rollback transaction.
- **Prove:** back up, enroll a node, restore after removing live recovery
  material, restart/reinitialize, confirm the existing trust is recovered and
  enroll/renew; reject malformed, stale and cross-installation ERBs; inject
  restore failures before and after activation and prove DB/files/recovery
  pointers roll back together.
- **Do not change:** never silently regenerate missing authority keys or move
  security generation backward. Do not claim whole-machine snapshot rollback
  detection when every witness rolled back together.

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

W2 is partially implemented on PR #530. The server client fetches the
existing player manifest with a bounded response and conditional ETags. The
daemon validates screen/asset identity and download claims, prepares required
image/video variants peer-first then origin through the existing verified CAS,
stores active/pending/previous manifest records, and resolves schedule and
availability selection. A server-manifest controller restores cached state,
requests activation at item boundaries or bounded grace/takeover conditions,
and promotes pending state only after renderer acceptance plus activation
evidence. Version-scoped pins retain pending/active media and clear migration
pins after confirmed activation. WPE image and H.264 access now uses the
daemon's opaque renderer-generation capability channel; the renderer receives
no CAS path or raw-digest authority.

`apps/edge/ci/test-linux.sh` and the real-WPE headless fixture suite have
passed for this slice. They prove daemon/WPE fixture playback and recovery,
not the complete real-server assignment-to-WPE lifecycle. The W2 PR description
lists the checks run for its current code; do not treat those suites as proof
of the missing server-to-WPE acceptance path.

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
- **Implement next:** complete one real-server E2E from assignment through
  manifest reconciliation, CAS verification, WPE render and daemon-accepted
  meaningful progress; then change assignment, reconcile authoritative state,
  prepare the replacement and prove boundary/grace activation. Add offline
  cached start, missing/corrupt peer with origin fallback, corrupt manifest
  preserving the current presentation, renderer/daemon restart and update
  during preparation cases. Finish every content kind the assigned
  presentation requires or reject it during preflight while preserving the
  last usable presentation.
- **RFC alignment gate:** the current code still uses the older global change
  feed and direct mutable manifest polling. Current RFC §§15–16 require fixed
  security/policy/per-screen streams, a materialized projection at its exact
  signed watermark, immutable presentation objects, and peer/server hints as
  wakeups only. Reconcile server publication and node reconciliation with that
  model before calling W2 complete; a feed hint or manifest response must not
  become an alternate authority. Reuse the existing Tilecast manifest domain
  semantics for presentation compilation.
- **Packaging gate:** install the media/control/admin sockets using RFC
  §27.1-owned socket units. The daemon currently binds its reconnectable
  media socket itself.
- **Do not change:** use opaque `tcmedia://cap/<opaque-capability>` grants
  scoped to renderer and presentation generations; keep peer/origin bytes on
  the verified CAS path; never give WPE the CAS root. Do not build a second
  presentation compiler.

### W3 (P0) Commands

- **Status:** command persistence/import exists, but no complete server poll,
  typed executor, durable result reporting or crash-point lifecycle is
  connected to the daemon.
- **Use:** `edge_state::repo::commands` (`observe`, `advance`,
  `import_completed`); the imported legacy keys; `core/commands.ts`.
- **Implement:** port the current command contract with explicit
  idempotent/reconcilable, at-most-once-initiation and retryable-with-
  reconciliation classes. Persist durable `executing` state before a
  disruptive side effect; report status/results; add restart tests around
  receive → persist → execute → complete/report. Bind authorization to the
  state incarnation and reconcile old pending work after restore.
- **Do not change:** preserve imported idempotency keys; never re-run a
  legacy-executed command. No shell or arbitrary executable input. Commands
  and update authorization stay direct server authority, not peer-relayed
  state.

### W4 (P0) Pairing for new installations

- **Status:** fresh installation pairing is not implemented. `submit_server_url`
  remains unavailable; legacy import is not a pairing substitute.
- **Use:** `setup.submit_server_url` (currently answers "not yet"),
  `url_policy`, `ServerClient`, `core/pairing.ts`,
  `daemon::set_node_identity(.., NodeIdentitySource::Generated, ..)`.
- **Implement:** fresh pairing with a pre-generated durable node/player ID,
  visible six-character code, separate private polling credential, one-time
  enrollment, credential persistence, and transition from setup to playback.
  Use secure bootstrap constraints below. Keep legacy migration separate:
  RFC §41 requires WPE/content preflight, a bounded server migration fence,
  staged replacement credential, actual playback evidence and confirmation
  that revokes the preserved legacy bearer.
- **Do not change:** never poll with the visible code or persist the poll
  secret after enrollment. HTTP plus matching installation ID is insufficient
  to establish Edge CA/authority trust; follow current RFC §10.1 and fail
  explicitly when secure trust bootstrap is unavailable.

### W5 (P0) Installer

- **Status:** package units and a written legacy migration procedure exist;
  there is no production installer, signed compatible release set, or RFC
  migration state machine.
- **Use:** `apps/edge/packaging/` (units, `sysusers.d`, `tmpfiles.d`, the
  procedure in `packaging/README.md`).
- **Implement:** preflight the exact installed WPE profile and current/near-
  horizon assigned content before transferring credential authority; use a
  root-owned migration lock and service mutual exclusion; stage a compatible
  signed Edge release set, import legacy state read-only, and implement
  crash-safe abort/confirm/rollback steps from RFC §§30 and 41. Confirmation
  must revoke the preserved legacy bearer; post-confirmation rollback is Edge
  release rollback or explicit server-assisted legacy recovery, never offline
  reuse of the old bearer. Sign releases with the established offline release
  authority, separate from the online Edge authority. Add systemd-owned
  renderer/control/media/admin sockets and test real permissions/activation.
- **RFC reconciliation:** current `main` specifies the fixed service account
  `tilecast-edge`; the older `apps/edge/AGENTS.md` and packaging files say
  `tilecast`. Resolve that conflict in favor of the current RFC before
  shipping, including filesystem/socket ownership and the restricted renderer
  unit.
- **Do not change:** `tilecastd` is not root and never replaces itself; the
  installer/updater is the privileged boundary. Do not ship an unsigned or
  independently activated daemon/renderer/runtime combination.

### W6 (P1) Proof of play and telemetry

- **Use:** renderer evidence already reaches `PresentationEngine::progress`
  (`EvidenceKind`); `docs/activity.md`; `docs/activity-event-contract.md`.
- **Implement:** the player activity events with the same definitions.
- **Do not change:** the load-bearing metric definitions in those documents.

### W7 (P1) Studio view of Edge nodes

- **Use:** `GET /api/v1/edge/nodes` (Owner and Administrator).
- **Implement later:** the canonical shadcn Base UI + Rhea Studio surface for
  Edge version, renderer state, mesh state/peer count, cache use, certificate
  expiry and capabilities. See `docs/studio-rhea-redesign-plan.md`.
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

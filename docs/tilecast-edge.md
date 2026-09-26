# Tilecast Edge

## Edge 1: the Linux player architecture

**Status:** Accepted architecture for Edge 1
**Product:** Tilecast
**Subsystem:** Tilecast Edge (Linux player)
**Date:** 2026-09-23
**Audience:** maintainers and contributors who work on `apps/edge`, the Linux packaging, and the server player API that Edge uses.

> Fabric development is paused until the Edge 1 and WPE work in this document is complete (see [`tilecast-edge-future.md`](tilecast-edge-future.md)).

> This document is the Edge 1 design. It is prescriptive. The implementation state and the verification ledger are in [`tilecast-edge-next.md`](tilecast-edge-next.md). Work that is not part of Edge 1 is recorded in [`tilecast-edge-future.md`](tilecast-edge-future.md) and is not a requirement here.

---

## 1. Decision

Tilecast Edge 1 is a reliable Linux signage player. It replaces the Electron Linux Player with two processes:

- `tilecastd`, an unprivileged Rust daemon that owns everything except drawing pixels;
- `tilecast-renderer-wpe`, a small C/GLib host for WPE WebKit. It hosts the shared Tilecast Player Runtime, which draws what `tilecastd` sends and reports what happened on screen.

```text
Tilecast Server
      │
 HTTPS / WebSocket
      │
  tilecastd
      │
 ┌────┴────┐
SQLite    CAS
      │
 local IPC
      │
WPE WebKit
      │
   Display
```

The core decisions are:

1. **The Tilecast Server is the only authority.** `tilecastd` reconciles authoritative state directly from the server over the ordinary player API. No other process, screen or device is a source of server state.
2. **A player works alone during an outage.** When the server or WAN is unavailable, the player keeps playing already-reconciled local state from SQLite and verified content from the content-addressed store (CAS). It does not need another screen to receive or relay anything.
3. **One identity model.** Edge uses the normal Tilecast device credential (`tc_device_<public-id>.<secret>`), the normal installation identity check, and the normal pairing flow. There is no second identity hierarchy, node certificate or Edge-specific signing authority.
4. **WPE WebKit is the only Linux renderer.** The renderer uses WPE WebKit 2.54 or later through the WPEPlatform API. There is no Electron renderer, no Electron fallback and no dual runtime.
5. **Electron is legacy only.** An existing Electron installation moves to Edge through a one-time, verified migration (§14). `apps/player-linux` stays in the repository as the legacy-state source and the rollback target until the migration period ends. It hosts the same shared Player Runtime as Edge, so a rollback shows the same presentation.
6. **SQLite for metadata, files for bytes.** Durable metadata is in one SQLite database. Media and other immutable bytes are files in a SHA-256 content-addressed store.
7. **Health comes from evidence.** The daemon judges renderer health from meaningful playback evidence, never from process or socket liveness.

## 2. Goals

Edge 1 is complete when a Linux screen:

- plays the same content as the Electron player, from the same server, with the same Studio experience;
- starts from cached state and keeps playing through a server or WAN outage;
- survives a renderer crash, a daemon restart, a power loss and an unclean shutdown without operator action;
- verifies every downloaded byte before use and never shows a partial or corrupt file;
- keeps the device credential inside `tilecastd` and never exposes it to the renderer, logs or IPC clients;
- migrates from Electron once, with a working rollback before the migration is accepted;
- reports true capabilities (display backend, media support, host time synchronization) instead of a generic platform name;
- installs and updates without leaving a machine that cannot play.

## 3. Not in Edge 1

These are deliberately outside Edge 1. They must not become requirements of Edge 1 work, and Edge 1 code must not carry runtime support for them:

- peer-to-peer content delivery, peer CDN, peer blob servers and peer ranking;
- a mesh or pub/sub fabric (Zenoh or any other), peer presence or peer discovery;
- relaying server state between screens, signed change feeds, signed node statements and peer catch-up;
- node certificates, an installation Edge CA, node-to-node mTLS, peer revocation and distributed signing or recovery machinery;
- soft coordinator roles, failover, local server-on-player operation;
- the Context Engine and CEL rules evaluated on the player;
- PTP and distributed clock work beyond the server offset (§13);
- an Edge-specific Studio fleet view or Edge-specific server endpoints;
- replacing PostgreSQL, replicating the server database, or any consensus protocol;
- arbitrary remote shell, scripts or device access;
- a dedicated Tilecast operating-system image.

[`tilecast-edge-future.md`](tilecast-edge-future.md) records which of these may return in Edge 1.5 or Edge 2, and under which conditions.

## 4. Processes and privilege

### 4.1 `tilecastd`

`tilecastd` is the durable player process. It runs as the fixed unprivileged `tilecast` account under the system unit `tilecast-edge.service`. It never runs as root and starts no other processes.

It owns:

- the server URL, installation identity, pairing and the device credential;
- the REST and WebSocket connections to the server;
- manifests, player configuration, commands and local scheduling;
- the content store and all downloads;
- SQLite state and crash recovery;
- the renderer relationship: what to show, whether it is shown, and recovery;
- capability probing;
- update staging;
- the bounded telemetry and Activity outbox;
- local administration over IPC (`tilecastctl`).

The fixed `tilecast` account is used because an existing Electron kiosk already runs as it, and because DRM, input and audio device access on signage machines is granted to that account. The security boundary between the daemon and the renderer is not a second account. It is the versioned Unix socket, its file mode, the `SO_PEERCRED` UID check, and systemd filesystem namespacing of the renderer unit.

### 4.2 Renderer

`tilecast-renderer-wpe` runs in its own unit, `tilecast-renderer.service`, as the same account with a narrower sandbox. It is disposable: systemd restarts it, and `tilecastd` restores the current presentation when it reconnects.

It receives a complete, validated, prepared presentation and returns evidence. It does not receive the device credential, the state database, the identity directory, arbitrary host paths, server API access, or any way to run a program. It cannot see the legacy home directory.

### 4.3 Privileged helpers

Edge 1 adds no general root daemon. Operations that need root keep the existing narrow-helper model: the Presentation Network helper (`tilecast-networkd`) stays a root-owned process with a fixed NetworkManager allowlist, and `tilecastd` talks to it over a Unix socket. Display control and input use udev rules and group membership, not root.

A new root operation needs a written threat-boundary review before it is added.

## 5. Filesystem layout

```text
/etc/tilecast-edge/edge.toml          optional, root-owned operator configuration
/var/lib/tilecast-edge/               StateDirectory, 0700 tilecast
    state.db                          SQLite metadata
    identity/                         0700: device-credential (0600)
    cas/sha256/<ab>/<64 hex>          verified immutable objects
    partial/<64 hex>.part             resumable downloads
    updates/                          staged release artifacts
    diagnostics/                      bounded local diagnostics
/run/tilecast-edge/                   RuntimeDirectory, 0750
    edge.sock                         IPC socket, 0660 tilecast:tilecast
/opt/tilecast-edge/<version>/         installed release
/opt/tilecast-edge/current            symbolic link to the active release
```

Rules:

- CAS and partial paths derive only from a validated lowercase SHA-256 digest. No filename, URL, MIME type or server string becomes part of a path.
- `cas/` and `partial/` are on the state directory's filesystem, so promotion is an atomic `rename(2)` followed by a directory `fsync`.
- The device credential is a file, never a database value.
- The state database is never served to any client.
- The renderer unit cannot read `identity/`, `state.db` or `partial/`.

## 6. Local state

### 6.1 Database

One SQLite database holds every piece of metadata that must survive a restart. Connection settings are fixed: WAL journal, `synchronous = FULL`, foreign keys on, and a busy timeout. `synchronous = FULL` is not relaxed to gain speed; hot paths are optimized individually.

Migrations are compiled into the binary and applied in order, each in its own `BEGIN IMMEDIATE` transaction. A database with a newer schema than the build knows is refused, not rewritten. A shipped migration is never edited.

Nothing deletes or recreates the database automatically. Any open, migration or integrity failure puts the daemon in **recovery mode** (§11.4). Starting empty would silently lose the server binding and could strand a paired screen.

The schema stores no secrets and no media bytes. Every table that can grow names its bound, and its repository enforces the bound.

### 6.2 Write amplification

Reads never cause one write each. CAS access times are batched in memory and flushed once a minute. Status and capability snapshots replace the current row; they are never an unbounded history.

### 6.3 Unclean shutdown

The daemon records a running marker at start and clears it on clean shutdown. A start that finds the marker set runs an integrity check and marks every CAS object as suspect. A suspect object is re-hashed before its next use.

## 7. Local IPC

The IPC contract is `edge_protocol::ipc`, protocol version 1. It is renderer-neutral.

- **Transport:** an `AF_UNIX` stream socket at `/run/tilecast-edge/edge.sock`, mode `0660`. The daemon checks the client UID with `SO_PEERCRED` against its allowlist.
- **Framing:** a big-endian `u32` length, then one UTF-8 JSON object. A length of zero or more than 4 MiB closes the connection.
- **Handshake:** the client sends `hello` with a role and a version range. The daemon picks the highest common version or rejects. Roles are `renderer` and `tilecastctl`; administrative methods also need the daemon's own UID or root.
- **Messages:** requests and responses (client to daemon only), events in either direction with a per-direction sequence, and `goodbye`.
- **Strictness:** every frame rejects unknown members; every string and list has an explicit bound.
- **Reconnect:** the daemon is the source of truth. On connect it sends `renderer.configure`. After `renderer.ready` it sends the current activation, with its original identifier, only when the renderer supports every feature it needs.

What never crosses the socket: the device credential, Presentation Network secrets, raw server responses, arbitrary filesystem paths from a client, executables, shell fragments and media bytes.

Golden fixtures for every frame type are in `packages/edge-protocol/fixtures/ipc`. The Rust and C sides test against them.

## 8. Server relationship

### 8.1 Authority

The server owns organization data, screens, pairing and credentials, content, playlists, layouts, schedules, takeovers, configuration policy, update authorization, Activity and incidents. Edge 1 moves none of this to the player.

`tilecastd` is the only process on the machine that talks to the server as the player.

### 8.2 Identity and credential

Edge keeps every existing player invariant:

1. The server address is normalized with the player URL policy: HTTP and HTTPS only; public hosts need HTTPS; HTTP is allowed only for private IPv4, link-local, localhost and `.local`; HTTPS is never downgraded; explicit ports are kept.
2. Before the stored credential is sent, `GET /api/v1/system/identity` must report the installation ID the player is bound to. In code this is a type: only `ServerClient::verify_installation` produces an `AuthenticatedServer`, and only an `AuthenticatedServer` can send the credential.
3. A mismatch stops the server link. The credential is never sent to the other server. An explicit reset is required.
4. The credential is deleted only when the server answers `device_credential_invalid` or `device_credential_revoked`. Network errors, 5xx answers and `screen_disabled` retry with backoff.
5. Redirects are never followed with the credential attached.
6. The credential is stored as `identity/device-credential`, mode 0600, and its `Debug` form is redacted.

### 8.3 Contact and reconciliation

`tilecastd` uses the ordinary player API: pairing, `POST /player/heartbeat`, the player WebSocket, the manifest, configuration and command endpoints, and authenticated asset downloads. The server computes screen status from this contact exactly as for every other player. Edge 1 adds no Edge-specific server endpoint.

The WebSocket is a wake-up path. Periodic reconciliation always runs as well, so a lost push never leaves a screen stale. Push events cause a reconciliation; they never replace one.

### 8.4 Offline behavior

Readiness, the renderer and playback never wait for the server. At start the daemon activates what it already has:

- the last accepted, fully prepared manifest and configuration from SQLite;
- the content it references, verified and pinned in the CAS;
- the local schedule, evaluated with the last server clock offset (§13).

A failed reconciliation or preparation never replaces the last good state. A new manifest becomes active only after every object it needs is verified and pinned.

## 9. Content store

### 9.1 Identity and invariants

An object's identity is the SHA-256 of its bytes. These invariants do not change without an update to this document:

1. **Only verified bytes are promoted.** An object is promoted only after its full size and SHA-256 match, computed over the final partial file after `fsync`.
2. **Commit order** is: fsync partial, verify, `rename` into `cas/`, fsync the directory, insert the metadata row. Reconciliation at open repairs every crash point: an orphan partial without a row is deleted, a row without a file is dropped, and an object file without a row is re-hashed and adopted or deleted.
3. **Objects are immutable.** Nothing is written in place under `cas/`.
4. **Pins win.** Eviction never removes a pinned object and never touches a partial that has an active writer.
5. **One writer per digest.** Concurrent fetches of the same object are serialized.
6. **Suspect objects are re-hashed** before use after an unclean shutdown (§6.3).

### 9.2 Sources

For Edge 1, a needed object comes from:

1. the local verified CAS, when it is already present; or
2. the Tilecast Server origin, through an authenticated player download path.

Local files (the legacy import and development fixtures) use the same verified commit path.

The origin source keeps the Electron player's resume rules: `Range` with `If-Range` set to the server's strong validator; a `200` answer to a range request restarts from zero; `401`, `403`, `404` and `410` end that source; other failures are transient and keep the partial. Download paths come from the manifest and must be plain `/api/v1/player/` paths without a query, fragment or dot segment.

Sources implement one trait, `edge_cas::BlobSource`, and the `Fetcher` tries them in order. A source never decides integrity; the store does. This is the extension seam for a later source such as a release-artifact store. Edge 1 carries no peer source.

### 9.3 Pins, limits and eviction

Pins have a reason and a holder: the active and pending presentation, prefetch, updates, renderer releases, migration and manual. Timed pins expire. The store keeps a byte limit and a reserved free-space floor; eviction removes unpinned objects, least recently used first, cheaper domains (media) before update and renderer artifacts.

### 9.4 Scrubbing

`tilecastctl` can verify one object on request. A corrupt object is removed; the next preparation that needs it fetches it again. Background scrubbing, when added, uses the same verification and is rate-limited.

## 10. Renderer

### 10.1 Baseline

- WPE WebKit 2.54 or later, through WPEPlatform only. No Cog, libwpe or WPEBackend-fdo.
- Platforms: `drm` on dedicated signage (no compositor), `wayland` on development machines and existing kiosk compositors, `headless` in CI.
- A small C11/GLib host. Presentation policy and business logic stay in `tilecastd`.

### 10.2 Trusted runtime

Electron and WPE host the shared Tilecast Player Runtime (`@tilecast/player-runtime`, [`player-runtime.md`](player-runtime.md)). Both load the same built artifact from `tilecast://runtime/index.html`, so presentation behavior stays identical during migration. The runtime owns the display DOM, playback lifecycle, transitions and evidence. The WPE host owns only the WPEPlatform and web view lifecycle, the URI schemes, the script bridge and output integration, and it stays small: presentation policy never moves into C.

The host adapter (`web/tilecast-bridge.js`) implements the runtime's versioned host contract, `TilecastRuntimeHostV1`, and exposes only its typed members. Behavior follows the capabilities the adapter advertises, never the host's name. Runtime file names are validated against a fixed grammar: top-level files and `fonts/<name>`. Host-to-page delivery calls one fixed function with typed arguments; no script source is built from strings. The runtime document's CSP is `script-src 'self'` and `style-src 'self'`, with no inline allowance.

### 10.3 Media access

The renderer reads media only through `tcmedia://`, and only for objects that the current activation or plugin state lists, with the declared size. It never receives a directory to browse and never receives a path from the page. The target is a daemon-owned media capability channel: `tilecastd` grants short-lived per-activation capabilities and serves the bytes itself, so the renderer needs no filesystem access to the CAS at all.

### 10.4 Evidence and compatibility

The renderer reports `renderer.ready` with the features it can show, then acceptance, rejection, progress and item errors. Progress counts only when it is meaningful for the item kind (for example, advancing video time or a painted image). A presentation that needs a feature the renderer does not advertise is not sent; the screen shows an explicit "unavailable" surface and status reports the reason.

### 10.5 Websites

Website and YouTube playback need an isolation design (network policy, permissions, storage partitioning, navigation limits) before the renderer advertises them. Until then they are reported as incompatible, never shown in a weakened form. Website credentials remain out of scope.

## 11. Supervision and recovery

### 11.1 systemd

- `tilecast-edge.service` is `Type=notify`. `READY=1` is sent once state and IPC are up. Readiness never waits for the server.
- The watchdog is pinged at half the configured interval, and only while the daemon can answer a trivial state query in time. A wedged state thread stops the pings, and systemd restarts the daemon.
- On SIGTERM the daemon sends `STOPPING=1`, cancels its tasks, says goodbye to IPC sessions, waits at most ten seconds, records a clean shutdown and checkpoints the WAL.
- The renderer is a separate unit and keeps its last frame while the daemon restarts.

### 11.2 Recovery ladder

The ladder is the Electron player's, adapted to a separate renderer process: re-activate the prepared presentation, reload the renderer's trusted runtime, ask the renderer to exit so systemd restarts it, then safe mode after repeated exhaustion inside a window. Each rung is spaced; sustained healthy evidence clears the ladder. The daemon never restarts itself for a renderer fault.

### 11.3 Safe mode

Safe mode shows a status surface instead of content and stops the ladder. It is reported in status. Activation leaves the safe-mode surface in place until the daemon restarts or the `exit_safe_mode` command clears it.

### 11.4 Recovery mode

If the state database cannot be opened, migrated or verified, the daemon stays up in recovery mode: IPC, `tilecastctl status` and the watchdog work, the renderer shows a recovery surface, and nothing is recreated. A restart loop cannot fix a corrupt database.

## 12. Capabilities

A capability describes one thing the device can or cannot do, with a state and a reason: `available`, `degraded`, `blocked`, `supported` (implemented but not usable right now) or `unsupported`. Code decides behavior from capabilities and presentation requirements, never from a platform name.

Providers probe the machine independently, each with a timeout. A provider that fails keeps its last known capabilities, marked `degraded` with `provider_probe_failed`. The daemon adds capabilities it knows from live state: the renderer and the state store. Only the current snapshot is stored; its revision moves only on a material change.

Edge 1 providers: systemd notify and watchdog, host time synchronization, the WPE platform backends, the renderer, and the state store. Display control (CEC and DDC), audio and input providers are added with their features (§18).

## 13. Time

Wall time answers "when" (schedule boundaries, pin expiry, report timestamps). Monotonic time answers "how long" (timeouts, backoff, progression of running playback). Wall time comes from an injected clock, so tests control it.

The player keeps the Electron player's server clock offset: it samples server time from the WebSocket and stores the last offset, so a restart without the server still schedules correctly. Synchronized playback anchors once at activation and then advances with the renderer's monotonic clock, so a later wall-clock correction never jumps active playback.

Host time synchronization (chrony, systemd-timesyncd) is reported as a capability. Edge 1 does not add PTP or a distributed clock.

## 14. Migration from Electron

### 14.1 Model

```text
legacy Electron player
        ↓
one-time migration
        ↓
tilecastd + WPE
```

There is no shadow mode, no dual runtime, no credential leasing and no second credential. The screen keeps its server record, its `playerInstallationId` and its device credential.

### 14.2 Legacy import

`tilecastd import-legacy` reads the Electron player's data directory (`$XDG_DATA_HOME/tilecast-player`, default `~/.local/share/tilecast-player`) read-only and imports:

- `installation.json`: the player installation ID, stored once as the player ID;
- `credential.json`: server URL, installation ID, screen ID and name, and the device credential;
- persisted command idempotency, the playback-disabled flag and the last server clock offset;
- cached media, only when size and SHA-256 match an entry in the saved manifest.

Imported state is untrusted until checked. The saved URL is normalized with the player URL policy, `/api/v1/system/identity` must report the saved installation ID, and only then is the credential stored. The import sends no authenticated request.

The import is bounded (every file is size-limited and strictly parsed, symbolic links are not followed), idempotent and crash-safe. A completed import is not repeated. It refuses to run while `tilecastd` runs. It never modifies, moves or deletes legacy files. Pairing sessions, updater stages, AirPlay files, Presentation Network radio state and website storage are not imported.

### 14.3 Cutover

The installer:

1. installs the Edge release and units without enabling them;
2. runs the local WPE self-test on the actual display backend, and checks the cached legacy manifest for presentations that the installed renderer reports as incompatible;
3. stops and disables the legacy unit; the legacy AppImage and data stay in place;
4. runs `tilecastd import-legacy`;
5. enables `tilecast-edge.service` and `tilecast-renderer.service`;
6. waits for a connected server link and meaningful playback evidence of the current presentation for a bounded settlement window.

Only one stack is enabled at a time. The legacy player is a systemd user unit, so the installer, not a unit dependency, enforces this: it disables the legacy unit before it enables Edge, re-enables it only after it disables Edge, and holds a migration lock for the whole cutover. The importer refuses to run beside a running daemon. Because both stacks use the same device credential, this local mutual exclusion is the control that prevents two processes from acting as one screen.

### 14.4 Rollback and acceptance

Until the migration is accepted, rollback is: stop and disable the Edge units, then re-enable the preserved legacy unit. The legacy files were never changed, and the credential is the same, so the legacy player resumes where it stopped. The installer rolls back automatically when step 2 or step 6 of §14.3 fails.

Acceptance is a local decision that ends the rollback window. After acceptance a later maintenance release may remove the legacy AppImage and data. A revoked credential is revoked for both stacks; re-pair the screen in Studio in that case.

A server-side migration session with a separate candidate credential is not part of Edge 1. It becomes worth its complexity only if field evidence shows legacy players being restarted beside Edge; [`tilecast-edge-future.md`](tilecast-edge-future.md) records it as deferred.

## 15. Updates

Release authorization stays on the server, as for the Android and Electron players. Edge 1 update basics:

- releases are signed artifacts published from the fixed release workflow; the player verifies the signature and digest before staging;
- artifacts are downloaded through the CAS like any other object and pinned while staged;
- a release is installed into a new `/opt/tilecast-edge/<version>/` directory; activation switches the `current` link atomically; the previous version stays for rollback;
- success is provisional until the new version reconnects and reports meaningful playback; otherwise the previous version is restored;
- the state schema migration of a new version runs only after activation, and a downgraded daemon refuses a newer schema (§6.1) instead of writing to it.

`tilecastd` never replaces its own binaries in place. The privileged activation step is a narrow, separately reviewed helper (§4.3).

## 16. Local administration and observability

`tilecastctl` maps each command to one fixed IPC method: `status`, `capabilities`, `cache`, and `self-test` (show the status surface). No command reads the credential or the database directly, and no command runs anything on the host. Mutating methods need the daemon's UID or root.

Logs are structured JSON on stderr, captured by journald. Every event has `component` and `event` fields. Digests are logged in short form. Credentials, Presentation Network secrets, website URLs with query strings and server response bodies are never logged.

Telemetry and Activity events use a bounded outbox in SQLite (at most 500 rows, oldest dropped first with a counter), so reports survive restarts and outages without unbounded growth.

## 17. Security invariants

1. The device credential stays in `tilecastd`, in a mode 0600 file, and is sent only after the installation identity matches.
2. The renderer holds no secret, gets no arbitrary path, and cannot run a program.
3. Content bytes are not trusted until the store verifies size and SHA-256.
4. No path is ever built from server, renderer or legacy input.
5. Every network read, body, frame, list and string is bounded.
6. Operator configuration is root-owned and strictly parsed; unknown keys fail `tilecastd check-config`.
7. No new root privilege without a written threat-boundary review.
8. No shell invocation with interpolated values.
9. Public server hosts need HTTPS; HTTPS is never downgraded.
10. Nothing in Edge 1 accepts server state from any source except the authenticated server.

## 18. Roadmap

### 18.1 Edge 1

Edge 1 ships as a sequence of reviewable milestones. Each one keeps the tree releasable.

| Milestone                      | Scope                                                                                                                                                                                                                                                                                                                                           | Exit criteria                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 Foundation                  | Rust workspace, `tilecastd` lifecycle under systemd, SQLite state and recovery mode, local IPC, `tilecastctl`, WPE renderer on drm, wayland and headless, renderer supervision, CAS with origin downloads, identity gate, device credential, minimal heartbeat, legacy import, capability registry, Linux CI and WPE headless end-to-end tests. | Workspace checks and Linux image checks pass; the headless scenarios pass; the real-server script passes import, identity gate, heartbeat and revocation. |
| M2 Server presence             | Player WebSocket with fallback heartbeat, server clock sampling, full heartbeat fields.                                                                                                                                                                                                                                                         | Studio shows a migrated screen as online; socket loss falls back to heartbeat; reconnect after server restart.                                            |
| M3 Manifests and content       | Manifest fetch and validation, CAS preparation from the origin, atomic activation, pinning, daemon-owned media capability channel, local schedule selection.                                                                                                                                                                                    | Downloaded image and video playback; restart offline from cached state; a failed preparation keeps the previous manifest.                                 |
| M4 Configuration and commands  | Player configuration synchronization; durable commands with idempotency; restart, reload and display commands.                                                                                                                                                                                                                                  | A command runs at most once across daemon restarts and redelivery.                                                                                        |
| M5 Pairing                     | Pairing sessions and setup surface for a new installation; manual URL entry; LAN discovery through Avahi.                                                                                                                                                                                                                                       | A clean machine pairs, is approved and plays without legacy state.                                                                                        |
| M6 Offline resilience          | Server outage, WAN outage, power-loss and clock-change qualification.                                                                                                                                                                                                                                                                           | Documented crash-point and outage tests pass.                                                                                                             |
| M7 Migration installer         | Preflight, cutover, settlement window, automatic rollback, acceptance.                                                                                                                                                                                                                                                                          | Migration and rollback tested on each supported host type.                                                                                                |
| M8 Proof of play and telemetry | Activity events through the outbox, bounded player telemetry.                                                                                                                                                                                                                                                                                   | Activity compliance matches an Electron player on the same schedule.                                                                                      |
| M9 Hardware parity             | CEC and DDC display control, Presentation Network helper client, audio output, Noise Meter capture through PipeWire.                                                                                                                                                                                                                            | Capability matrix on reference hardware.                                                                                                                  |
| M10 Updates                    | Signed Edge releases, server-authorized deployment, atomic switch, provisional success and rollback.                                                                                                                                                                                                                                            | An update and a forced rollback on reference hardware.                                                                                                    |
| M11 WPE qualification          | DRM/KMS on reference hardware, Wayland kiosks, website isolation.                                                                                                                                                                                                                                                                               | Physical-device validation recorded in the ledger.                                                                                                        |
| M12 Production rollout         | Pilot, staged migration, Electron retirement plan.                                                                                                                                                                                                                                                                                              | Pilot fleet stable for an agreed period.                                                                                                                  |

### 18.2 Edge 1.5 and Edge 2

Edge 1.5 may add optional peer content delivery, only if measurements from production Edge 1 fleets show that origin bandwidth or time to prepared playback is a real problem. Edge 2 may add an optional local coordinator or server-on-player mode, and selected concepts from the experimental Fabric work where they demonstrably help. Both are described, with their entry conditions, in [`tilecast-edge-future.md`](tilecast-edge-future.md).

## 19. Review rules

1. No new root privilege without a written threat-boundary review.
2. No shell invocation with interpolated values. `tilecastd` starts no processes.
3. No arbitrary path from server, renderer or legacy input. CAS paths come from digests. Download paths pass `OriginBlobSource` validation.
4. Bound every network read, body, frame, list and string. Use the bounded types in `edge-protocol`.
5. Content bytes are not trusted until the content store verifies hash and size. A source never decides integrity.
6. A durable state transition that can duplicate a command or an update needs a crash-point test.
7. An optional provider failure must not stop playback initialization.
8. Every capability distinguishes unsupported, blocked and degraded, with a reason code.
9. Aggregate high-rate data before persistence or network use.
10. No secret in logs, tests, fixtures or screenshots. `DeviceCredential` redacts itself in `Debug`; keep it so.
11. An IPC protocol change needs fixtures in `packages/edge-protocol/fixtures` and tests on both sides.
12. A WPE change that touches remote website content needs a navigation, permission and data-isolation review.
13. Never claim a physical display state was confirmed when only a command was sent.
14. Never infer health from process or socket liveness when meaningful playback evidence is available.
15. Do not add runtime support for work listed in §3. Propose it in [`tilecast-edge-future.md`](tilecast-edge-future.md) first.

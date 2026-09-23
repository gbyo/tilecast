# Tilecast Edge

## Canonical Architecture and Implementation Plan

**Status:** Proposed implementation RFC
**Product:** Tilecast
**Subsystem:** Tilecast Edge (Fabric)
**Date:** 2026-09-22
**Repository baseline reviewed:** `gbyo/tilecast` at current `main` through `aa9cdfef693abc5f84b67f98eb618038de6ed35f` during the latest deep review
**Audience:** Tilecast maintainers and contributors implementing the Linux/Edge runtime, server support, and Tilecast Studio administration UI.

> This file is the implementation plan. It is intentionally prescriptive. Where it conflicts with an older exploratory note about Tilecast Edge, this file wins unless a later ADR/RFC explicitly changes a decision.

---

## 1. Executive decision

Tilecast Edge turns Linux Tilecast installations from independent kiosk clients into a secure, cooperative local edge fabric.

The central Tilecast Server remains the **authoritative control plane**. Tilecast Edge is the **local execution and distribution plane**. Edge nodes may relay server-signed state, distribute immutable content to one another, maintain local context, coordinate optimization roles, operate hardware, and continue working through server or internet outages, but they never become a second source of truth for Tilecast's organization data.

The final Linux architecture is:

```text
                            TILECAST SERVER
                   authoritative control plane
            PostgreSQL · Studio · policy · publication
               signing · deployments · audit/activity
                               │
                     HTTPS / WebSocket
                               │
                     ───── school LAN ─────
                               │
         ┌─────────────────────┴─────────────────────┐
         │             TILECAST EDGE FABRIC          │
         │                                            │
         │  Zenoh: presence, events, queries, hints  │
         │  mTLS: authenticated node-to-node trust   │
         │  HTTPS Range: peer content distribution   │
         │                                            │
         │  ┌────────────┐         ┌────────────┐     │
         │  │ tilecastd  │◄───────►│ tilecastd  │     │
         │  │ Library    │         │ Cafeteria  │     │
         │  └──────┬─────┘         └──────┬─────┘     │
         │         │                       │           │
         │         └───────► other peers ◄─┘           │
         └─────────────────────┬─────────────────────┘
                               │
                    local Unix-domain IPC
                               │
                    tilecast-renderer-wpe
                      WPE WebKit 2.54.x
                               │
                       DRM/KMS / Wayland
                               │
                              HDMI
```

The core decisions are:

1. **Create a new unprivileged Rust daemon, `tilecastd`.** It owns Linux device identity, central-server connectivity, durable state, peer mesh, content cache, clock authority, hardware capabilities, Linux integrations, update staging, telemetry, and renderer orchestration.
2. **Embed Zenoh in `tilecastd`.** Use peer mode for LAN presence, pub/sub, query/reply, and fast propagation. Do not require a standalone `zenohd` broker for normal installations.
3. **Do not send large media through Zenoh.** Zenoh carries metadata and events. Immutable bytes move over a separate mTLS HTTP Range service backed by a content-addressed store.
4. **Every peer is cryptographically authenticated.** Being on the LAN is never sufficient. Each Edge node has an installation-scoped certificate and private key generated on the node.
5. **Server authority is cryptographically portable.** Small server-signed Edge change envelopes and immutable content objects can be relayed by peers without turning peers into authorities.
6. **Use SQLite locally.** It becomes the durable transactional state store for Edge metadata; immutable media remains ordinary files in a SHA-256 content-addressed store.
7. **Use CEL for Context Engine conditions.** The server validates rules, and Edge evaluates a deliberately bounded, cross-tested subset locally.
8. **Use Linux-native platform services.** Avahi/D-Bus for mDNS, NetworkManager through the existing narrow privilege boundary, PipeWire for audio, udev for hardware discovery, linuxptp for optional PTP, and systemd for lifecycle/watchdog supervision.
9. **WPE WebKit is the Linux renderer.** Target a tested stable WPE WebKit 2.54.x build through WPEPlatform, not legacy Cog/libwpe/WPEBackend-fdo. The first-party renderer is a small C/GLib host supervised by `tilecastd`.
10. **Electron is legacy-only.** New Edge installations never ship, select, or fall back to Electron. `apps/player-linux` remains temporarily as a behavioral reference and legacy-state source while the one-time migration path is supported; production Edge playback is WPE-only.
11. **Tilecast Studio Edge UI follows the canonical shadcn Base UI + Rhea Studio plan.** `docs/studio-rhea-redesign-plan.md` is being implemented as a separate concurrent workstream and is the source of truth for Studio shell, component architecture and information architecture. Edge surfaces integrate into that resulting Rhea implementation; Edge work must not independently redesign Studio, recreate the shell, or revive Spectrum 2.
12. **No physical-neighbor choreography in this project.** That idea is explicitly deferred. Edge does not need a building topology or animated network map.

---

## 2. Product goals

Tilecast Edge exists to make a group of Linux players behave like one resilient local system while keeping Tilecast understandable and self-hostable.

### 2.1 Required outcomes

When Edge is complete:

- Publishing new content should wake the local fleet almost immediately rather than waiting for each player's five-minute reconciliation floor.
- If one node already has a 500 MB video, nearby nodes should normally fetch it from that node rather than downloading another copy from the Tilecast Server.
- A server-signed content/configuration change should be able to propagate across the LAN even when some nodes cannot currently reach the server.
- A server or WAN outage must not stop already-prepared playback, local schedules, local context evaluation, peer content sharing, hardware controls, or renderer recovery.
- A renderer crash must not tear down the server connection, mesh, cache, hardware providers, or node health reporting.
- The Linux machine must expose real capabilities rather than being treated as a generic `platform == linux` bucket.
- Sensors and host media devices should become typed Tilecast inputs without adding an arbitrary script/shell plugin system.
- Edge should know the quality/source of its clock and use monotonic progression so clock corrections do not jump active playback.
- Studio should make the fabric understandable to an administrator without requiring networking expertise.
- A compromised or malformed peer must not be able to make another node activate untrusted configuration, accept corrupt media, expose credentials, or execute arbitrary host operations.

### 2.2 Secondary outcomes

- Reduce server bandwidth and origin load.
- Reduce the time from publish to prepared playback across a building.
- Make Linux update distribution efficient by peer-seeding signed artifacts.
- Create a clean path toward a dedicated Tilecast Linux appliance image later.
- Make Android able to participate in selected Edge concepts later without requiring Android parity in Edge v1.

---

## 3. Explicit non-goals

The following are deliberately **not** part of Tilecast Edge v1:

- Replacing PostgreSQL or replicating the Tilecast Server database to players.
- Raft, Paxos, distributed consensus, or a second authoritative Tilecast server.
- Allowing peers to edit playlists, schedules, users, permissions, or organization settings.
- Arbitrary remote shell execution.
- Arbitrary scripts triggered by Context Engine values.
- Arbitrary Linux device access exposed to Studio.
- Trusting a node because it is on the same subnet.
- Routing or bridging the Presentation Network Wi-Fi to Ethernet.
- Automatically turning an Edge node into a PTP grandmaster.
- Treating Zenoh's hybrid logical clock as the authoritative wall clock.
- Uploading microphone audio to the server or mesh for Noise Meter.
- Cross-screen physical choreography or display-neighbor topology.
- Requiring multicast to work. Multicast discovery is an optimization, never a dependency.
- Requiring proprietary cloud services.
- Maintaining Electron as an Edge compatibility renderer or runtime fallback. Existing Electron installs are supported only long enough to perform the documented one-time migration to Edge/WPE.
- Building Tilecast OS as a prerequisite for Edge. A controlled appliance image is a later delivery option.

---

## 4. Why the current repo is ready for this split

The existing Linux player already contains most of the behavior that belongs in an Edge daemon. The problem is ownership: all of it currently lives in or beside Electron.

The current `apps/player-linux/src/core/player.ts` is a large orchestrator that owns identity verification, pairing, server connection, manifest/config/command synchronization, scheduling, takeovers, downloads, health, updates, and supervisor behavior. The renderer is already comparatively dumb and receives resolved presentation state.

The migration therefore does **not** require inventing a new product model. It moves proven runtime responsibilities into a process that is independent from the rendering engine.

### 4.1 Existing behavior that must be preserved

The current player already has important invariants that Edge must keep:

- installation-ID verification before sending a saved device credential;
- separate dashboard, pairing, and player authentication boundaries;
- cached-first startup;
- periodic reconciliation in addition to WebSocket push;
- resumable `.part` downloads with `Range`/`If-Range`;
- SHA-256 plus byte-size verification before promotion;
- atomic promotion of prepared content;
- prior-active-manifest preservation during failed preparation;
- server-corrected time and local monotonic progression for synchronized playback;
- persistent command idempotency;
- meaningful-playback health rather than process-liveness-as-health;
- a bounded recovery ladder and safe mode;
- Linux CEC/DDC capability probing and typed commands;
- Presentation Network sidecar semantics where Ethernet remains the default route;
- root privilege isolated in a narrow helper rather than granted to Electron;
- signed Linux player updates;
- activity/telemetry semantics where players report measurements and the server derives incidents.

Tilecast Edge is successful only if these properties survive the migration.

### 4.2 Existing modules and their future owner

| Current code | Current role | Future owner |
| --- | --- | --- |
| `core/pairing.ts` | installation ID, enrollment, credential | `tilecastd` identity/server modules |
| `core/api.ts` | authenticated server REST | `tilecastd` server client |
| `core/socket.ts` | server WebSocket/liveness | `tilecastd` server client |
| `core/manifest.ts` | manifest reconciliation/preparation | `tilecastd` presentation sync |
| `core/config.ts` | player configuration | `tilecastd` configuration |
| `core/download.ts` | verified/resumable downloads | Edge CAS/download manager |
| `core/storage.ts` | JSON files + media cache | Edge SQLite + CAS |
| `core/clock.ts` | server clock correction | Edge Clock Authority |
| `core/schedule.ts` / selection | local playback selection | Edge presentation engine |
| `core/commands.ts` | idempotent persistent commands | `tilecastd` command engine |
| `core/self-update.ts` | AppImage update | Edge update manager |
| `core/supervisor.ts` | recovery ladder/safe mode | `tilecastd` renderer supervisor |
| `core/system-probe.ts` | diagnostics/network | Edge platform providers |
| `core/telemetry.ts` | bounded player metrics | Edge telemetry |
| `main/discovery.ts` | JS Bonjour discovery | Edge Avahi provider |
| `main/display-control.ts` | CEC/DDC host calls | Edge display provider |
| `main/presentation-network.ts` | network helper client | Edge NetworkManager provider |
| `main/airplay.ts` | UxPlay host lifecycle | Edge external-presentation provider |
| `main/hardware.ts` | Electron-specific tuning | legacy reference only; WPE host qualification replaces it |
| `preload.ts` synchronization | timeline projection | `tilecastd` presentation engine |
| `renderer/renderer.ts` | browser presentation surface | behavioral source for the trusted WPE web runtime |
| `renderer/noise-meter.ts` | browser microphone measurement | migrate to Edge PipeWire input |

### 4.3 What stays on the central server

The server remains responsible for:

- the canonical organization and screen records;
- pairing approval and credential lifecycle;
- content, playlists, layouts, widgets, sources, forms, review/publishing, schedules, groups, takeovers and configuration policy;
- manifest/presentation compilation;
- update deployment authorization;
- server-side Context Engine definitions and server-owned context sources;
- Edge certificate authority and Edge change signing;
- audit/activity/incidents;
- the authoritative API used by Studio;
- permanent history that belongs in the organization record.

Edge deliberately does not move those responsibilities out of the modular Go server.

---

## 5. Target repository layout

Use a new Edge workspace rather than placing Rust inside `apps/player-linux`.

```text
apps/
  server/
  dashboard/
  player-android/
  player-linux/                 # legacy Electron source/state format; never an Edge renderer

  edge/
    Cargo.toml                   # Rust workspace
    rust-toolchain.toml

    tilecastd/
      src/

    tilecastctl/
      src/

    crates/
      edge-ipc/
      edge-state/
      edge-identity/
      edge-server/
      edge-mesh/
      edge-cas/
      edge-context/
      edge-clock/
      edge-capabilities/
      edge-platform/
      edge-update/
      edge-observability/

    renderer-wpe/
      CMakeLists.txt
      src/

packages/
  edge-protocol/
    schemas/
    fixtures/

  player-renderer-web/
    src/                         # extracted trusted DOM renderer runtime
    static/

  manifest-schema/
  layout-schema/
  design-tokens/
```

### 5.1 Why Rust for `tilecastd`

Rust is the preferred implementation language for the daemon because:

- Zenoh's native/reference implementation and primary API are Rust;
- Linux systems integration is a natural fit for Rust's ownership and concurrency model;
- high-throughput peer serving and hashing can be implemented without a garbage-collected runtime;
- D-Bus, udev, TLS, HTTP and SQLite have mature Rust libraries;
- it avoids making the core daemon depend on Zenoh's Go/CGo binding boundary.

The Go Tilecast Server remains Go. This is not a server rewrite.

### 5.2 Why C/GLib for `tilecast-renderer-wpe`

WPE WebKit 2.54 made WPEPlatform stable and the recommended new embedding API. Its supported embedding API is a C/GObject API. The renderer host should therefore be a deliberately small C/GLib process rather than introducing a large home-grown Rust FFI layer before there is a mature official Rust WPEPlatform binding.

The C process should be boring:

- create the WPE display/view;
- load the trusted Tilecast runtime;
- bridge strict messages to `tilecastd`;
- handle lifecycle/navigation/permissions;
- expose screenshots/progress events;
- exit cleanly on fatal engine failure.

Presentation policy and business logic stay in Rust.

### 5.3 Build systems

- Rust workspace: Cargo.
- WPE renderer: CMake + `pkg-config` checks for `wpe-webkit-2.0` and `wpe-platform-2.0`.
- Shared browser renderer: existing TypeScript toolchain.
- Root `Makefile` gains `edge-check`, `edge-build`, `edge-test`, `renderer-wpe-build` targets without changing the current server/dashboard/Android entry points.

---

## 6. Process and privilege architecture

### 6.1 `tilecastd`

`tilecastd` is the durable Linux player brain.

It runs as the fixed unprivileged `tilecast` account under a **system** systemd service. It must not run as root and must not inherit a logged-in user's broad session privileges. The WPE launcher is also unprivileged; renderer authority is limited by dedicated Unix sockets, filesystem permissions, `SO_PEERCRED`, the daemon-recorded renderer instance/process identity, and WebKit's subprocess sandbox rather than by granting the renderer any administrative API.

It owns:

- device identity;
- server URL and installation identity;
- pairing/enrollment;
- server bearer credential storage/use;
- central REST/WebSocket connections;
- manifests/configuration/commands;
- local scheduling and presentation selection;
- Edge node identity/certificate lifecycle;
- Zenoh;
- peer HTTPS server/client;
- CAS and local SQLite state;
- Context Engine;
- Clock Authority;
- capability registry;
- renderer selection and supervision;
- NetworkManager helper client;
- CEC/DDC provider;
- Avahi provider;
- PipeWire provider where session access is available;
- udev/hardware providers;
- update download/staging;
- bounded telemetry/activity outbox;
- local administration IPC.

### 6.2 Renderers

The WPE renderer is disposable and unprivileged.

It receives a complete, validated, prepared presentation contract and reports evidence about what actually happened on screen. Its access to `tilecastd` is granted only through renderer-specific Unix IPC. `SO_PEERCRED`, socket permissions, the renderer-instance generation and daemon-recorded process identity bind that connection to the WPE child that `tilecastd` launched. The renderer never self-asserts an administrative role in JSON.

It does not receive:

- the Tilecast device bearer credential;
- Edge node private keys;
- Presentation Network credentials;
- arbitrary server API access;
- direct NetworkManager control;
- arbitrary host paths;
- arbitrary shell execution.

The renderer process may be killed and recreated without disrupting the Edge mesh or prepared content.

### 6.3 Privileged helper

Preserve the existing `tilecast-networkd` philosophy.

Initially:

```text
tilecastd (unprivileged)
        │
        └──── AF_UNIX ────► tilecast-networkd (root)
                              NetworkManager only
```

Do **not** immediately turn it into a broad root daemon.

If later milestones need another root-only operation, create either:

- another narrowly scoped helper; or
- a carefully versioned `tilecast-privd` whose operation allowlist remains fixed, typed, path-bounded and independently validated.

Even a future `tilecast-privd` must never expose `exec`, arbitrary file writes, arbitrary D-Bus calls, or arbitrary NetworkManager properties.

Prefer udev rules and dedicated Unix groups for CEC, I²C/DDC, input and DRM access instead of routing those operations through root.

### 6.4 PipeWire session boundary

PipeWire is commonly per-user/session. A system `tilecastd` must not assume that `/run/user/<uid>/pipewire-0` always exists or is reachable.

For a dedicated appliance, run PipeWire/WirePlumber under the controlled `tilecast-edge` service/session identity (or an equivalently isolated media-session identity) so `tilecastd` can connect predictably. If the renderer needs PipeWire audio output, grant `tilecast-renderer` access only to the required PipeWire socket/session using a deliberate ACL/group boundary; do not collapse the daemon and renderer back into one Unix account.

For generic existing Linux desktops where that cannot be guaranteed, PipeWire capabilities may be `unavailable` and a later optional user-session bridge can expose only the typed operations Edge needs. Lack of PipeWire must never break playback.

---

## 7. Filesystem layout

Recommended production layout:

```text
/var/lib/tilecast-edge/
    state.db
    identity/
        active -> generations/<generation-id>/
        generations/
            <generation-id>/
                node-key.pem             0600 tilecast-edge:tilecast-edge
                node-cert.pem            0644 tilecast-edge:tilecast-edge
                edge-ca-bundle.pem       0644 tilecast-edge:tilecast-edge
                authority-keyring.json   0644 tilecast-edge:tilecast-edge
                identity.json            0600 tilecast-edge:tilecast-edge
        device-credential                0600 tilecast-edge:tilecast-edge
        trusted-checkpoint.json          0600 tilecast-edge:tilecast-edge
    cas/
        sha256/
            ab/
                <64-hex-hash>
    staging/
    diagnostics/

/run/tilecast-edge/                       root:root 0755
    renderer/                             root:tilecast-renderer 0750
        control.sock
        media.sock
    admin/                                root:tilecast-admin 0750
        admin.sock
    health/                               tilecast-edge:tilecast-edge 0700

/opt/tilecast-edge/
    releases/
        <component>/<version>/
    sets/
        <release-set-id>/manifest.json
    current-set -> sets/<release-set-id>/
    previous-set -> sets/<release-set-id>/
    rollback-state/
    launcher/                             immutable privileged package
```

The active identity generation changes with one atomic pointer switch after the complete key/certificate/CA/keyring set is durable. Do not leave one mutable key beside a separately replaced certificate.

`authority-keyring.json` contains the verified public authority transition chain and currently trusted authority epochs. `edge-ca-bundle.pem` may contain overlapping installation CA certificates only during an explicit CA rotation plan.

`trusted-checkpoint.json` is the minimal non-reconstructible anti-rollback state used after destructive SQLite recovery. It contains no private key and no server bearer secret.

Runtime socket directories are not owned by `tilecast-edge.service`. Create/own them through the socket units or `tmpfiles.d` so their lifetime does not disappear when the service stops and each allowed group can traverse only its directory.

The stable service entrypoint is an immutable launcher outside the mutable release set. It resolves `current-set`, verifies the selected set/component paths, and execs that set's `tilecastd`. systemd never points at an obsolete `current -> releases/<version>` symlink.

Rollback metadata for a pending software release lives outside the candidate release directory and candidate database schema.

### 7.1 Filesystem rules

- state/identity directories are owner-only;
- renderer/admin runtime access uses the explicit group-controlled subdirectories above;
- CAS paths derive only from validated lowercase SHA-256 hex;
- partial filenames derive from the hash plus a fixed suffix;
- secrets are not stored in ordinary SQLite unless an explicit encrypted-secret abstraction is introduced;
- SQLite is never remotely downloadable;
- **the WPE renderer never receives the CAS root or direct CAS filesystem permission**;
- renderer media is exposed through daemon-owned capability reads over the renderer media channel;
- identity/release-set pointer changes use atomic replacement + parent-directory fsync where supported.

## 8. Local state: SQLite plus immutable files

The existing atomic JSON state files are robust for a single Electron process but become awkward once Edge needs transactional relationships between cache metadata, peer changes, context, commands, updates and renderer checkpoints.

Use SQLite for metadata.

### 8.1 Database settings

At database initialization:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Use `synchronous=FULL` for the database that contains command-idempotency and update-transition state. If profiling proves this too write-heavy on poor flash media, optimize individual non-critical measurement paths rather than globally weakening durability.

Use `rusqlite` with a bundled SQLite build in release packaging so Edge does not depend on an unexpectedly old system SQLite.

### 8.2 Proposed local tables

Keep immutable blob facts separate from mutable references and pin ownership.

```text
schema_meta
server_identity
screen_state
server_sync_state
trusted_checkpoint
objects
object_references
object_pins
object_partials
peers
peer_transfer_scores
stream_cursors
stream_records
current_state
resource_watermarks
context_candidates
context_effective
context_rules
context_replay_watermarks
command_idempotency
update_state
capability_state
renderer_state
playback_checkpoint
activity_outbox
```

`objects` contains facts that are intrinsic to one verified blob:

```text
hash
size_bytes
verified_at
created_at
last_accessed_at
source_kind
```

Do not store one `pinned_reason`, one logical domain, or one authorization bit on the blob row. The same bytes may be referenced by several domains and may be pinned by several independent owners.

`object_references` records logical uses such as media, Edge Object, renderer bundle, or update artifact. It carries reference-specific metadata such as content type, original identity, peerability, and authorization class.

`object_pins` is many-to-one:

```text
hash
owner_kind
owner_id
reason
created_at
PRIMARY KEY (hash, owner_kind, owner_id)
```

An object remains non-evictable while any pin exists. Releasing one active presentation, prefetch, takeover, update, or rollback owner cannot remove another owner's protection.

Transfer single-flight leases are process-local by default. If a later implementation persists leases, every row must carry a boot/process generation plus expiry, and startup must clear stale generations before waiting on them.

`trusted_checkpoint` stores only the minimum anti-rollback state required to decide whether peer state is safe after restart. Destructive SQLite recovery must not silently recreate this trust state from peers.

### 8.3 Write amplification

Do not update `last_accessed_at` synchronously on every media read. Batch cache-touch timestamps in memory and flush them periodically. Playback progress checkpoints should likewise be cadence-bounded.

---

## 9. Local IPC contract

### 9.1 Transport

Use separate AF_UNIX stream sockets for renderer and administrative clients:

```text
/run/tilecast-edge/renderer.sock
/run/tilecast-edge/admin.sock
```

Create these sockets with systemd socket units so ownership and mode do not depend on the unprivileged daemon calling `chown(2)`:

```text
renderer.sock  owner: tilecast-edge   group: tilecast-renderer   mode: 0660
media.sock     owner: tilecast-edge   group: tilecast-renderer   mode: 0660
admin.sock     owner: tilecast-edge   group: tilecast-admin      mode: 0660
```

The socket units pass their listening file descriptors to `tilecastd`. The daemon does not recreate them with its process umask.

`tilecastd` must inspect peer credentials (`SO_PEERCRED` on Linux) and reject unexpected UIDs even when filesystem permissions appear correct. Socket choice plus peer credentials determine the maximum role available to the connection. A client-provided JSON `role` is descriptive/negotiated metadata, never the authorization decision.

Filesystem permission on `admin.sock` is the group-membership gate for read-only administration. Do not assume `SO_PEERCRED` reports supplementary groups; it reports the peer process identity, while the Unix socket mode/group controls whether that process could connect. Mutating recovery operations require peer UID 0 or another separately documented local authorization mechanism.

A future user-session bridge must receive its own dedicated socket and allowed UID/group policy; it must not gain renderer or administration authority merely by connecting to one of these sockets.

### 9.2 Encoding

For v1, use a deliberately simple cross-language wire format:

```text
4-byte unsigned big-endian payload length
UTF-8 JSON object
```

Rules:

- maximum ordinary frame: 4 MiB;
- unknown required protocol versions fail closed;
- JSON decoders reject malformed field types;
- commands include a request ID;
- responses include the request ID;
- unsolicited events use a separate event envelope;
- bounded JPEG preview frames may use Base64 initially because existing previews are already capped; add a binary frame type only if profiling justifies it.

JSON is chosen because the clients are Rust, Node/TypeScript and C/GLib during migration. Presentation media bytes never travel through the JSON control framing. Renderer media reads use the separate `media.sock` contract defined below.

### 9.3 Handshake

Every control connection begins with an explicit compatibility range and instance identity:

```json
{
  "type": "hello",
  "protocol": {
    "min": 1,
    "max": 1
  },
  "role": "renderer",
  "client": "tilecast-renderer-wpe",
  "version": "0.1.0",
  "rendererInstance": "c4c7..."
}
```

Allowed protocol roles are closed, for example:

- `renderer`
- `tilecastctl`
- `session_bridge`

Socket choice plus OS peer identity authorize the maximum role. The claimed role must agree with that authorization.

The daemon creates a random renderer-instance generation for every renderer launch and passes it through a protected environment/file descriptor or other launch-time channel. Renderer control and media requests must present the active generation after handshake. A stale renderer process from an earlier generation cannot reconnect and report readiness/progress for the new instance merely because it has the same Unix UID.

The server replies with the selected protocol version, Edge version, active renderer instance, screen identity safe for that role, and enabled message capabilities.

Daemon and renderer release metadata also declares IPC `minProtocol`/`maxProtocol`. An update may not activate a daemon/renderer pair with no common IPC version.

### 9.4 Renderer contract

The daemon sends concepts such as:

```text
presentation.activate
presentation.clear
presentation.identify
plugin.state
sync.position
renderer.command.retry_item
renderer.command.skip_item
preview.request
```

The renderer sends:

```text
renderer.ready
renderer.progress
renderer.item_error
renderer.website_state
renderer.preview
renderer.health
renderer.capabilities
```

The actual schemas live in `packages/edge-protocol/schemas/` and fixtures are consumed by Rust, TypeScript, and C tests.

No renderer message can name an executable, shell fragment, arbitrary path or server credential.

### 9.5 Renderer media capability channel

Tilecast-owned media uses a capability URI that is meaningful only to the current renderer instance/presentation generation:

```text
tcmedia://cap/<opaque-capability>
```

Do **not** put a raw SHA-256 digest in the authority portion and do not give WPE/GStreamer the CAS root.

When `tilecastd` prepares a presentation generation it creates random, unguessable media capabilities mapping:

```text
capability -> {
  rendererInstance,
  presentationGeneration,
  sha256,
  size,
  contentType,
  allowedReadMode,
  expiresWhenGenerationRetires
}
```

Capabilities exist only for `prepared`, `active`, or `draining` generations and are invalidated when the generation retires or renderer instance changes.

WPE's GStreamer backend still requires a Tilecast-owned `GstURIHandler` source for `tcmedia`. `WEBKIT_GST_ALLOWED_URI_PROTOCOLS` only allows the protocol through WebKit's media pipeline; it is not an origin/sandbox/capability boundary.

The GStreamer source receives only the opaque capability and reads bytes through a daemon-created inherited/connected media channel. It never opens `/var/lib/tilecast-edge/cas` itself.

The daemon-side media service:

1. binds the connected renderer process/instance;
2. validates the opaque capability;
3. verifies the referenced presentation generation remains prepared/active/draining;
4. resolves the capability to one already-verified blob;
5. accepts only bounded HEAD/read/seek/range operations;
6. prevents enumeration and arbitrary-hash probing;
7. expires every capability on renderer/presentation retirement.

Prefer an inherited connected socket/socketpair or FD-backed channel over a reconnectable bearer-token socket. If a reconnectable `media.sock` is retained, it still requires OS peer/process validation plus current renderer generation.

Remote website content never receives the opaque media capabilities. More importantly, untrusted website WebViews/contexts must be configured so they cannot instantiate the privileged Tilecast media pipeline/source at all. Do not rely only on capability secrecy to separate hostile remote pages from trusted runtime media.

Image/widget/runtime resources use a separate trusted local scheme/world. Remote website origins cannot access Tilecast runtime/media handlers or the native bridge.

Presentation generations remain:

```text
prepared -> active -> draining -> retired
```

The previous generation remains readable through its capabilities until the renderer acknowledges the transition boundary or a bounded drain timeout expires.

## 10. Trust model

Tilecast Edge has three distinct trust relationships. They must not be collapsed.

### 10.1 Tilecast Server ↔ player

The ordinary player API keeps Tilecast's existing device-bearer/server-URL policy.

However, **Edge trust bootstrap is a stronger boundary than ordinary LAN player authentication**.

V1 requires an authenticated encrypted bootstrap channel before a node may:

- accept/install an Edge CA/trust realm for the first time;
- enroll/renew an Edge node certificate;
- accept a replacement trust realm;
- accept a recovery re-anchor;
- receive a migration confirmation that establishes the new Edge credential/trust state.

Accepted v1 bootstrap channel:

```text
HTTPS to the configured Tilecast Server
with normal certificate/hostname validation
and no silent HTTP downgrade
```

The public installation-ID probe remains useful to prevent credential misdelivery, but installation ID over plain HTTP is not cryptographic server authentication.

Private-LAN HTTP may remain supported for existing legacy/basic player behavior under the current product policy, but Edge mesh/trust enrollment stays disabled until the server has a secure bootstrap channel.

A future alternative for HTTP-only LAN deployments must be an explicitly reviewed authenticated-encryption/PAKE or out-of-band trust protocol. Do not approximate it with a short pairing code or an unauthenticated fingerprint fetched over the same HTTP connection.

The saved device credential is never sent to a peer.

### 10.2 Edge peer ↔ Edge peer

### 10.2 Edge peer ↔ Edge peer

Peers authenticate with installation-scoped mTLS certificates.

Being on the same LAN is not proof of membership.

### 10.3 Server-signed data ↔ any Edge node

Server-generated relayable state is signed with a **new Edge authority key**, separate from the existing offline player-update signing key.

This distinction is required because the current player-update private key intentionally belongs only in the release/CI signing environment and must not be installed on Tilecast Server. Edge needs a server-online signing key for dynamic changes.

### 10.4 Key classes

| Key | Private key location | Purpose |
| --- | --- | --- |
| Existing player release signing key | CI/offline release environment only | Player/Edge release manifests |
| Edge authority signing key | Tilecast Server persistent data volume | Dynamic signed Edge change envelopes/objects |
| Edge installation CA key | Tilecast Server persistent data volume | Node mTLS certificates |
| Edge node key | Generated/stored only on node | Node certificate and peer identity |
| Player device credential | Node only; hash on server | Central player API authentication |

Do not reuse one key solely because all are Ed25519-capable identities.

---

## 11. Edge node enrollment and certificate lifecycle

### 11.1 Node ID

Reuse the stable Linux `playerInstallationId` as the durable Edge node identifier.

Do not create a second unrelated device identity unless a future multi-screen-per-host architecture requires it.

### 11.2 Enrollment and proof of possession

After ordinary Tilecast player enrollment succeeds:

1. `tilecastd` creates an Ed25519 node private key locally.
2. It creates a PKCS#10 CSR or equivalent signed enrollment request proving possession of that private key.
3. The request carries only the public key plus bounded request metadata.
4. It calls the authenticated Edge enrollment endpoint with the verified existing device credential.
5. The server obtains authoritative installation ID, `playerInstallationId`, screen ID, trust realm, purpose and policy from authenticated database state. It does **not** trust identity values merely because the CSR subject/SAN asks for them.
6. The server verifies CSR proof-of-possession and enrollment rate/overlap limits.
7. The server issues the node certificate.
8. The response returns the node certificate, Edge CA chain, authority keyring/transition material, trust/security coordinates, mesh protocol range, and renewal threshold.
9. The private key never leaves the node.

Enrollment/renewal is rate-limited per credential, node ID and source address. V1 also bounds the number of simultaneously valid overlapping node certificates during renewal/rebinding.

### 11.3 Exact CA and leaf profiles

Both CA and leaf certificate profiles are normative protocol contracts with checked-in DER/golden fixtures.

Initial installation CA profile:

```text
version                 X.509 v3
subject key             Ed25519
signature               Ed25519
basicConstraints        CA=true, pathLen=0, critical
keyUsage                keyCertSign + cRLSign, critical
extendedKeyUsage        absent
validity                explicit bounded lifetime/rotation overlap
custom identity         installationId + trustRealmId
```

Initial node leaf profile:

```text
version                 X.509 v3
subject key             Ed25519
signature               Ed25519
basicConstraints        CA=false, critical
keyUsage                digitalSignature, critical
extendedKeyUsage        clientAuth + serverAuth, critical
serial                  positive unique random 128-bit value
validity                server UTC with documented notBefore skew
SAN/custom OIDs         installation ID, trustRealmId, durable node ID,
                        screen binding, certificateGeneration, purpose
purpose                 tilecast-edge-node
```

Do not rely on common-name text for authorization.

The player installation ID is the durable node identity; screen ID is the current authorization binding at issuance. Every certificate has a unique serial and public-key fingerprint.

Peers validate:

- trust realm and installation ID;
- purpose;
- durable node ID/current screen authorization;
- CA chain/profile;
- leaf BasicConstraints/KeyUsage/EKU;
- exact certificate instance;
- monotonic per-node `certificateGeneration`;
- current security state's minimum accepted certificate generation;
- validity;
- revocation/disabled-node state.

The server allocates certificate generations from recovered security state, not from ordinary restored device rows. Issuing a replacement certificate does not immediately invalidate the still-valid previous generation; the security state raises `minimumAcceptedCertificateGeneration` only when the replacement is committed/old generation is retired. This allows bounded overlap while preventing a stale restored server from minting a certificate generation that newer peers accept.

Exact OID numbers/DER encodings are allocated in E0. Fixtures include wrong CA path length, missing critical extensions, wrong EKU, wrong purpose, wrong realm/installation/node/screen, malformed CSR and CSR-without-valid-proof-of-possession.

### 11.4 Rotation

Recommended initial leaf policy:

- validity: 180 days;
- renew when fewer than 30 days remain;
- retry with bounded exponential backoff;
- keep the still-valid old certificate until replacement generation is durable;
- atomically switch the complete identity generation;
- retire/revoke the superseded certificate instance after the replacement is usable.

Power loss must not pair a new private key with an old certificate or incomplete authority/CA material.

CA rotation is rarer and separate from leaf renewal. It uses an explicit overlapping trust window and updated ERB before removing the old CA.

### 11.5 Revocation and lifecycle

Maintain distinct sets:

```text
revoked certificate instances -> serial/fingerprint
disabled durable nodes        -> playerInstallationId/nodeId
```

Certificate renewal/rebinding revokes only the superseded instance.

Screen archive/disable, explicit node decommissioning, hardware replacement of the underlying installation identity, credential/security repair and related current Tilecast lifecycle mutations must have explicit Edge consequences in the same authoritative transaction/outbox path.

A bearer credential repair that keeps the physical node may rotate only certificate instances. Hardware replacement with a new `playerInstallationId` disables the old durable node.

Security state is identified by `securityLineageId + securityGeneration + stateDigest`.

Revocation applies to new and established sessions. A newer accepted security generation immediately rejects matching application data and closes matching Zenoh/peer-HTTPS sessions.

Certificate-instance revocations may leave the active security set only after `notAfter` plus maximum documented clock/replay safety margin. Durable node disablement follows the underlying device lifecycle instead.

Certificate expiry is a second safety boundary. Do not add online OCSP as an Edge availability dependency.

## 12. Server-side Edge trust, security lineage, recovery and secrets

Edge adds online private trust/security state that ordinary Tilecast database/media backups cannot safely represent alone.

### 12.1 Trust realm

Every Edge installation has a random `trustRealmId`.

A trust realm contains:

- installation Edge CA/private key;
- Edge online authority signing-key chain;
- current security lineage;
- externally recoverable current security snapshot/checkpoint.

`trustRealmId` appears in Edge certificates and signed Edge protocols.

Loss of the private trust realm is not an ordinary restore. Without a usable recovery bundle, create a new trust realm and re-enroll Edge nodes.

### 12.2 Ordinary state incarnation

Configuration/content history uses opaque random `stateIncarnationId`.

Create a new incarnation only for an explicit rollback-style restore/re-anchor where ordinary authoritative state may be older than state already accepted by players.

Incarnations are not numerically ordered.

A node changes ordinary state incarnation only through the direct authenticated recovery re-anchor.

Resource revisions and **policy/screen** stream sequences are comparable only inside one state incarnation.

### 12.3 Security lineage is independent of ordinary incarnation

Security state must continue across ordinary content/config restore.

A random `securityLineageId` identifies one continuous security history inside a trust realm. `securityGeneration` is its monotonic sequence.

The security stream therefore does **not** include `stateIncarnationId` in its identity or freshness rules.

A node that still uses ordinary incarnation A may accept a newer valid security generation from the same trust realm/lineage while the server is preparing/re-anchoring ordinary incarnation B.

This preserves revocation/key updates across an unrelated ordinary-state recovery.

### 12.4 Recoverable security snapshot

A digest alone is insufficient to recover security state.

The externally recoverable security snapshot contains enough canonical state to reconstruct/validate the current security generation, including at least:

```text
trustRealmId
securityLineageId
securityGeneration
securityHeadDigest

activeAuthorityEpoch
authority keyring + activation/retirement boundaries

revoked certificate instances
disabled durable node IDs

per-node:
  highestIssuedCertificateGeneration
  minimumAcceptedCertificateGeneration

per-screen device-credential authorization:
  credentialAuthorizationGeneration
  currently authorized credential public IDs/credential IDs

security policy/version fields required by the security stream
```

The snapshot has a normative `securityStateDigest` and is authority-signed.

It does **not** contain raw player credential secrets/hashes. Therefore an external security snapshot can reject a resurrected old credential, but cannot recreate a newer credential row/secret missing from the restored database. In that case recovery requires credential repair/re-pairing.

### 12.5 Player device credentials are security state

Current Tilecast device credentials live in PostgreSQL and can otherwise be resurrected by an old database restore.

After Edge security is enabled, device authentication additionally checks the recovered security projection:

- credential public/row ID must be in the current allowed set for that screen;
- its authorization generation must meet the current security state;
- revoked/superseded credentials remain rejected even if an old DB row says `revoked_at IS NULL`.

Every credential issue/replacement/revocation that changes the allowed set advances security state.

This includes the Electron → Edge migration credential confirmation in §41.

### 12.6 Authority-key activation/retirement

Authority rotation is part of the security lineage.

A transition at security generation G is signed by the authority key active at G and declares the next authority epoch active beginning at G+1.

Rules:

- security record G+1 and later use the new active authority;
- old authority keys remain **historical-verification only** below their retirement boundary;
- a retired key cannot sign a new current-state document, snapshot, object grant, recovery re-anchor, or stream extension;
- ordinary policy/screen documents include `securityGenerationAtIssue`;
- verifier confirms that `authorityEpoch` was active at that security generation;
- if a node is missing history across an authority retirement boundary, it obtains a current active-authority snapshot/checkpoint rather than accepting an unanchored old-key extension from a peer.

This prevents a compromised retired signing key from manufacturing fresh current state.

The offline software release-signing key is separate from this online Edge authority.

### 12.7 Crash-safe managed restore

A managed rollback restore uses an **externally supplied/recovered security witness** before ordinary re-anchor.

Order:

1. restore/validate PostgreSQL/media/update files;
2. import/validate the matching or newer ERB/security snapshot;
3. overlay/reconcile recovered security state so revoked credentials/certs/nodes cannot reappear;
4. create a new random ordinary `stateIncarnationId`;
5. materialize and durably sign the global policy projection/checkpoint for the new incarnation;
6. persist a recovery root describing the new incarnation + policy checkpoint;
7. atomically mark that recovery root active;
8. expose direct re-anchor for screens only after their own screen projection/snapshot is ready.

Do not require every screen's immutable content/projection to be rebuilt before the installation recovery root becomes active.

A screen may continue its previously trusted cached presentation while disconnected. When it contacts the restored server, the server prepares that screen's new-incarnation projection/snapshot first and only then sends the direct re-anchor for that screen.

Keep enough previous-incarnation recovery material during this transition to handle nodes that have not re-anchored yet.

The security stream remains on its existing lineage and can continue independently throughout this process.

### 12.8 Edge Recovery Bundle

The ordinary Tilecast backup archive must not contain raw Edge CA/authority private keys in its unencrypted tar payload.

Use a separate encrypted **Edge Recovery Bundle (ERB)** protected by operator-held recovery material that is not stored inside the bundle.

Conceptual contents:

```text
formatVersion
installationId
trustRealmId

Edge CA private/public material
online authority private/public keyring + transition chain

full canonical current security snapshot
securityLineageId
securityGeneration
securityHeadDigest
securityStateDigest

createdAt
bundle checksum/authentication metadata
```

The ERB deliberately does **not** restore ordinary screen/policy incarnation/projection state. Ordinary state always comes from the selected database backup and receives a fresh `stateIncarnationId` when rollback recovery is required.

A newer ERB may accompany an older ordinary DB backup because security is allowed to move forward while ordinary state rolls back.

Use a maintained authenticated-encryption format such as age or an equivalent reviewed container.

Backup integration:

- force/obtain a durable security snapshot before recording the backup recovery point;
- record the paired security lineage/generation/head digest and ERB fingerprint in backup metadata;
- restore accepts the matching or newer security snapshot/ERB, never an older one;
- cross-installation ERB mismatch requires explicit trust reset;
- a stale/missing ERB never causes the server to publish lower security state.

### 12.9 Existing restore transaction integration

Tilecast's restore path already keeps pre-restore database/files so a failed restore can roll back.

Edge recovery files participate in the same prepare/activate/finalize contract:

- stage imported ERB/security snapshot and new recovery-root files separately;
- do not replace active trust/recovery pointers before database/file restore validation succeeds;
- if restore rolls back to pre-restore DB/files, restore the pre-restore active recovery pointers too;
- only finalize/remove old recovery material after the whole restore succeeds.

A failed restore must not leave a new trust/incarnation pointer beside the old database.

### 12.10 What rollback can and cannot be detected

Tilecast can make **managed restore** rollback-safe when it has a witness outside the state being rolled back: operator-supplied ERB/security checkpoint, hardware monotonic storage, or another explicitly trusted external witness.

Tilecast cannot automatically detect an arbitrary hypervisor/full-disk snapshot rollback if **every** database, trust file, recovery pointer and monotonic counter is rolled back together and no external witness is presented.

Do not claim otherwise.

For installations that require protection from arbitrary whole-machine snapshot rollback, add one of:

- operator-required external ERB/checkpoint during recovery;
- TPM/secure monotonic storage;
- separately protected recovery service/volume;
- another reviewed monotonic witness.

Without such a witness, a rolled-back server must be treated as potentially stale until an administrator performs Edge recovery/re-anchor.

### 12.11 Cross-installation restore

Never combine restored installation B with installation A's Edge trust realm.

A confirmed cross-installation restore must either import the matching ERB for B or quarantine old trust material and enter trust-reset/re-enrollment.

Do not issue Edge certificates, security state, or ordinary signed state while database installation identity and recovered trust realm disagree.

## 13. Zenoh fabric design

## 13. Zenoh fabric design

Zenoh is the local fabric's coordination transport. It is **not** the authoritative database and it is **not** the primary large-object transport.

### 13.1 Deployment mode

Embed the Zenoh Rust library directly into `tilecastd` and open a peer-mode session.

Default behavior:

```text
mode = peer
multicast scouting = enabled
multicast address = 224.0.0.224:7446
gossip = enabled
peer autoconnect = enabled
```

Zenoh's documented peer mode uses multicast scouting on the local network and gossip to propagate knowledge of peers. This is a good fit for a school LAN, but Edge must not assume multicast works everywhere.

### 13.2 Transport

For Edge v1, prefer **TLS over TCP** for Zenoh sessions.

Why not start with QUIC?

- Edge mesh messages are small control/metadata messages;
- TCP/TLS is well understood on school networks and firewalls;
- QUIC does not materially improve a 500-byte context update;
- large object transfer is handled independently;
- reducing transport combinations makes the first reliability matrix much smaller.

QUIC remains a benchmark-driven future option.

Recommended ports:

| Purpose | Protocol | Default |
| --- | --- | ---: |
| Zenoh multicast scouting | UDP multicast | 7446 |
| Zenoh peer session | TCP + mTLS | 7447 |
| Edge peer blob service | HTTPS + mTLS | 7448 |
| mDNS/Avahi | UDP multicast | 5353 |

All ports must be configurable because schools may have policy conflicts.

### 13.3 TLS-only scouting

A critical Zenoh detail: scouting can otherwise negotiate any supported transport. Edge must explicitly restrict Zenoh link protocols to TLS.

The shipped/tested configuration fixture must include the full mutual-authentication posture, not only listener credentials. Conceptually:

```json
{
  "mode": "peer",
  "transport": {
    "link": {
      "protocols": ["tls"],
      "tls": {
        "root_ca_certificate": "...",
        "enable_mtls": true,
        "listen_private_key": "...",
        "listen_certificate": "...",
        "connect_private_key": "...",
        "connect_certificate": "...",
        "close_link_on_expiration": true,
        "verify_name_on_connect": false
      }
    }
  }
}
```

`verify_name_on_connect` is deliberately false only because Edge peers are reached through changing private IP addresses while certificates bind Tilecast logical node identity, not those IP addresses. This setting must never broaden trust to public WebPKI roots.

The pinned Zenoh/rustls build must prove that outbound peer verification accepts **only** the installation Edge CA. Current Zenoh releases have had behavior where a configured private root is added to the default WebPKI roots on the connector side. If the selected version still behaves that way, Tilecast must patch/vendor the connector verifier or use another supported connector path that constructs an installation-CA-only root store. A publicly trusted non-Tilecast certificate must fail the E5 transport test even when endpoint-name verification is disabled.

Do not describe an arbitrary signed nonce as a TLS channel binding. Tilecast node identity must be established by one of these tested mechanisms:

1. Zenoh exposes the authenticated peer certificate/subject strongly enough for Tilecast to verify the certificate SAN/OID node identity and bind it to the transport; or
2. every node-originated Tilecast payload carries a node-signed application envelope containing the durable node ID, active certificate serial/fingerprint, message kind/key, payload digest and replay field, and receivers verify that the keyspace identity matches the signed identity.

If the transport exposes a standard TLS exporter/channel-binding value, Tilecast may include that value in a signed session statement. A random nonce without a transport exporter is not sufficient to prove that the statement belongs to that TLS session.

All accepted paths verify the installation CA, certificate purpose, installation ID, durable node ID, exact certificate instance, current revocation generation and certificate validity. A CA-valid peer must not be able to publish as another node merely by choosing that node's keyspace.

A node discovered over multicast is still not connected as a usable Tilecast peer until TLS mutual authentication and the selected logical-node binding both succeed.

The JSON fixture above contains only keys supported by the pinned Zenoh configuration schema.

For v1, TLS session resumption is an **implementation gate**, not a fictional Zenoh config key. The pinned Zenoh/rustls integration must either expose a supported hook that disables resumption or Tilecast must patch/vendor the TLS connector/listener so resumed sessions cannot bypass exact certificate-instance and current-security validation.

Likewise, zero-RTT/early application data must be disabled in the actual pinned TLS stack. Do not add undocumented configuration keys and assume they work.

If the selected Zenoh/rustls version cannot prove both properties, E5 does not enable production mesh.

### 13.4 Interface selection

The Edge fabric must not accidentally migrate onto the Presentation Network Wi-Fi used by AirPlay.

Network-interface policy:

1. prefer the interface carrying the default route to Tilecast Server;
2. prefer Ethernet when it is available and healthy;
3. allow operator-configured interface allow/deny lists;
4. explicitly exclude NetworkManager profiles with the `tilecast-presentation-` namespace;
5. do not advertise or serve the peer CDN over an interface marked Presentation Network;
6. do not install routes to make peers reachable across isolated networks;
7. never bridge Presentation Network Wi-Fi and Ethernet.

If no permitted LAN interface exists, Edge remains a valid standalone player with mesh capability `unavailable`.

### 13.5 Multicast failure fallback

Multicast discovery can fail across VLANs, AP isolation and managed Wi-Fi. Edge therefore has a seed path.

The server's effective Edge configuration may include a small list of **recently observed private-address peer endpoints** for the same installation. `tilecastd` tries those addresses using mTLS; once it reaches one peer, Zenoh gossip can reveal others.

Rules:

- seed addresses are hints, not trusted identities;
- certificate verification still decides whether the endpoint is a valid peer;
- stale seed failures are cheap and bounded;
- server-provided seeds are never required for an already-connected LAN fabric;
- manual static seeds may be configured by an operator for segmented networks;
- nodes report only endpoints they actually bound on permitted Edge interfaces, including protocol/port and interface identity;
- the server validates reported addresses as bounded private/link-local policy allows and never turns an arbitrary player-supplied host/port into an unrestricted scan target.

Do not infer the advertised LAN endpoint only from the source address of the status HTTP request. Reverse proxies, containers and multi-homed hosts can make that address unrelated to the peer listener.

### 13.6 Zenoh namespace

Use one installation-scoped namespace:

```text
tilecast/<installation-id>/...
```

The namespace is routing, not authorization.

V1 layout aligns with the fixed stream topology:

```text
tilecast/<installation>/nodes/<opaque-session>/liveliness
tilecast/<installation>/nodes/<node-id>/summary
tilecast/<installation>/nodes/<node-id>/capabilities
tilecast/<installation>/nodes/<node-id>/clock
tilecast/<installation>/nodes/<node-id>/cache/events

tilecast/<installation>/streams/security/latest
tilecast/<installation>/streams/security/query
tilecast/<installation>/streams/policy/latest
tilecast/<installation>/streams/policy/query
tilecast/<installation>/streams/screen/<screen-id>/latest
tilecast/<installation>/streams/screen/<screen-id>/query

tilecast/<installation>/objects/has/<sha256>
tilecast/<installation>/context/<scope>/<scope-id>/<key>
tilecast/<installation>/roles/<role>/candidate
```

Exact stream IDs inside signed protocol documents are:

```text
security/<installation-id>
policy/<installation-id>
screen/<screen-id>
```

Avoid overly broad subscriptions where narrow keys suffice. Authorization still verifies the authenticated node and signed application document; key naming alone is not a security boundary.

### 13.7 Liveliness

Liveliness is only a discovery hint. It is not proof of node identity or authorization.

A Tilecast node must not publish an identity-bearing key such as `nodes/<node-id>/liveliness` unless the implementation can cryptographically bind that key to the authenticated transport identity. Current Zenoh ACL key expressions are static, so the RFC must not assume that a certificate identity can be substituted into a dynamic key path.

Two acceptable v1 designs exist:

1. the pinned Zenoh build exposes the authenticated peer certificate/subject strongly enough that Tilecast can bind the transport to the certificate's durable node ID before accepting identity-bearing liveliness; or
2. Zenoh liveliness uses an opaque connection/session key, while the actual node-presence document is a separately signed application message containing node ID, certificate fingerprint, boot/session generation, capabilities and replay data.

A CA-valid node must not be able to declare another node's liveliness by choosing that node's key expression.

Liveliness loss is not authority loss. Playback, signed state, cache validity and command state do not depend on a liveliness token remaining present.

### 13.7.1 Generic node-signed message envelope

When Zenoh transport identity is not sufficient for a message's authorization, use a domain-separated node envelope:

```text
schema
trustRealmId
installationId
nodeId
certificateFingerprint
bootId
messageSequence
kind
key
payloadDigest
issuedAt
expiresAt/null
signature
```

`bootId` is a random 128-bit identifier generated on daemon boot. `messageSequence` is a decimal-string counter increasing within `(nodeId, bootId)`.

The signed `payloadDigest` is SHA-256 over the canonical payload bytes for that message kind; `key` binds the logical Zenoh/application key so a valid payload cannot be replayed under another namespace.

Sign with `TilecastEdge/node-message/v1`.

Receivers persist/recently retain replay watermarks for accepted boot IDs according to the message type's maximum lifetime. Message types define bounded max age/expiry; an old signed node summary cannot remain fresh indefinitely.

Context observations keep their more specific source-epoch/source-sequence envelope and signing domain.

### 13.8 Queryables

Use Zenoh queryables for request/reply operations where multiple peers may respond, especially:

- `who has object <sha256>?`;
- `what change sequence range can you provide?`;
- `what is your current node summary?` after discovery;
- diagnostic peer probes.

Do not use queryables for remote shell-like RPC.

### 13.9 QoS classes

Define a fixed mapping rather than letting every feature choose ad hoc priorities.

Suggested classes:

| Edge message | Reliability | Priority intent | Congestion behavior |
| --- | --- | --- | --- |
| certificate revocation hint | reliable | Control | block/bounded retry |
| takeover/change-available hint | reliable | Control | block/bounded retry |
| configuration/change-feed hint | reliable | Interactive high | block/bounded retry |
| context effective-value change | reliable | Data high | bounded retry |
| node/capability summary | reliable | Data | replace/coalesce |
| cache add/evict announcement | best effort | Data low | drop |
| frequent sensor gauge | best effort | Real-time/data | drop/coalesce |
| diagnostics trace hint | best effort | Background | drop |

The signed/durable object itself is never considered delivered merely because the hint was delivered. Hints wake reconciliation; state remains independently retrievable.

### 13.10 ACL posture

Use **default-deny** Zenoh ACL policy once the exact key schema is stable.

Node certificates should map to authenticated subjects. Policy should allow an Edge node only the key families it needs. Examples:

- node can publish its own node summary, not another node's summary;
- node can query object availability;
- node can answer object-availability queries for itself;
- only server-signed payloads are accepted into authoritative `changes` processing even if a peer can relay them;
- sensor publication keys are limited to the originating node/screen scope.

Current Zenoh ACL key expressions are static and must not be assumed to substitute the authenticated node ID into `nodes/<node-id>/...` dynamically. If the pinned Zenoh version does not provide identity-bound key templates/runtime ACL updates, do one of the following:

- generate explicit per-node ACL entries and use a tested safe reload/restart strategy; or
- treat Zenoh ACL as coarse defense-in-depth and enforce own-node keyspace at the signed application-envelope layer.

Because configuration mistakes could partition the fleet, ship ACLs only after integration tests exercise the exact final keyspace. mTLS plus application-level identity/signature/scope checks remain mandatory regardless of Zenoh ACL.

### 13.11 HLC usage

Zenoh can attach hybrid logical clock timestamps. Edge may preserve these for tracing and duplicate diagnostics, but must not use them to decide:

- schedule time;
- content authority;
- Context Engine source precedence;
- certificate validity;
- update ordering;
- server revision ordering.

Those use explicit server sequence/revision fields and Clock Authority.

---

## 14. Peer content CDN

The peer CDN is the primary bandwidth-saving feature of Tilecast Edge.

### 14.1 Content-addressed store

Every peerable object is keyed by SHA-256:

```text
/var/lib/tilecast-edge/cas/sha256/<first-two-hex>/<64-hex-hash>
```

The hash is the byte identity. Original upload filenames and logical content identities are reference metadata only.

The blob table stores only immutable/intrinsic facts:

```text
hash
size_bytes
verified_at
created_at
last_accessed_at
source_kind
```

Logical references are stored separately so one blob can simultaneously represent media, an Edge Object, a renderer bundle, or an update artifact without collapsing their policy.

Reference metadata may include:

```text
hash
reference_kind
reference_id
content_type
peerable
authorization_class
etag
```

Every CAS path derives only from validated lowercase SHA-256 hex. Blob lookup never accepts an arbitrary filesystem path.

### 14.2 Peerability, confidentiality and hash-level policy

Being hash-addressed does not imply every enrolled node may read the bytes.

Reference classes remain:

```text
installation_peerable
target_granted
origin_only
never_on_player
```

However, **confidentiality is enforced at the byte/hash level**.

If the exact same bytes/hash are referenced by several live logical objects with different classes, compute one effective sharing policy no more permissive than the strictest live reference.

Examples:

- one `installation_peerable` + one `target_granted` reference → hash is not installation-peerable;
- two `target_granted` references with different audiences → caller needs a grant whose audience/reference policy authorizes that hash;
- any `origin_only` reference that requires byte confidentiality prevents peer serving of that hash unless the server intentionally creates a differently encoded/encrypted byte variant with another hash.

Do not claim the same plaintext hash is both installation-public and target-confidential.

If product semantics require the same logical content at two confidentiality levels, create distinct protected/encrypted variants so their byte identities differ.

#### installation_peerable

Any active authenticated Edge node in the trust realm may fetch the hash. Use only when installation-wide byte confidentiality is acceptable.

#### target_granted

Peer transfer requires a valid server-signed object grant.

Conceptual grant core:

```text
schema
trustRealmId
securityLineageId
securityGenerationAtIssue
stateIncarnationId/null
hash
size
audienceScreenId or audienceNodeId
referenceKind
referenceId
grantGeneration
issuedAt
notAfter
authorityEpoch
```

`notAfter` is mandatory for `target_granted`; null/unbounded target grants are not allowed.

Grant maximum lifetime is bounded by server policy and trusted time. Short-lived grants reduce future-fetch exposure but do not revoke bytes already delivered legitimately.

Sign with `TilecastEdge/object-grant/v1` using the currently active online authority.

A newer security state may raise a per-reference/per-audience minimum grant generation for future fetches. Peers that cannot prove sufficiently current security state must fail closed for security-sensitive grant classes.

For content requiring immediate/strong revocation semantics, use `origin_only` or an encrypted target-specific object/key design. Tilecast cannot make plaintext bytes disappear from a node that was previously authorized to receive them.

#### origin_only

Authenticated Tilecast Server may serve the object, peers never do.

#### never_on_player

Secrets/private records are not projected to player storage at all.

Never peer-share:

- device bearer credentials;
- Edge private keys;
- Presentation Network credentials;
- dashboard sessions;
- website cookie/storage partitions;
- private form attachments unless explicitly projected under an approved byte-level policy;
- screenshots/live-preview frames;
- raw microphone/audio samples;
- arbitrary logs;
- unapproved/sensitive Data Source configuration;
- server private signing/CA keys.

A screen-specific presentation being non-applicable to another screen is not a confidentiality control; choose the effective byte-sharing class deliberately.

### 14.3 Peer object endpoint

Each node exposes a small mTLS HTTPS service only on permitted Edge interfaces.

V1 endpoints:

```http
HEAD /v1/blobs/sha256/<hash>
GET  /v1/blobs/sha256/<hash>
Tilecast-Object-Grant: <optional signed grant>
```

No upload endpoint, directory listing, arbitrary path, redirect handling, or generic URL fetcher.

Responses use one canonical immutable validator shared with server origin:

```http
ETag: "sha256:<hash>"
Accept-Ranges: bytes
Cache-Control: private, immutable
Content-Length: ...
```

Origin and peers emit the same content-addressed ETag for the same bytes.

Range handling accepts only one bounded range. Resume requires a `206` whose `Content-Range` starts at the exact local length and whose total equals expected size.

### 14.4 Peer authorization

Before serving bytes:

1. TLS client certificate chains to the installation Edge CA and matches trust realm.
2. certificate purpose/installation/node identity is valid.
3. exact certificate instance is not revoked and durable node is enabled.
4. hash matches a verified local blob.
5. compute the current **effective hash sharing policy** from every live confidentiality-relevant reference; do not OR permissions together;
6. if effective policy is `installation_peerable`, serve to an otherwise valid same-realm node;
7. if effective policy is `target_granted`, require a non-expired authority-signed grant whose hash/size/reference/audience match the authenticated caller and whose grant generation is not below the current security policy;
8. if effective policy is `origin_only` or `never_on_player`, refuse peer serving.

Hash alone is not an authorization identifier. A formerly installation-peerable plaintext hash also cannot become retroactively confidential after other nodes already received it; sensitive transitions require a new protected byte variant/hash.

For outbound peer fetch, availability reply contains authenticated node identity plus bounded endpoint. The requester validates peer HTTPS certificate node ID against the advertisement.

V1 endpoint targets allow only:

- fixed configured peer-CDN port/bounded server allowlist;
- validated private/link-local address on the advertising peer's Edge interface;
- no loopback, public address, arbitrary hostname/URL, Unix target, redirect, or inherited proxy.

For peer-CDN requests, redirects and ambient proxy configuration are disabled.

A valid peer certificate never grants database/renderer access or blanket CAS read permission.

### 14.5 Fetch algorithm

For an object with expected hash and size, first acquire a per-hash single-flight transfer lease. Concurrent consumers wait for/share the same transfer result rather than writing the same partial file.

```text
1. Check local CAS and verify metadata/integrity policy.
2. Acquire/join the per-hash transfer lease.
3. Query Zenoh for peers that currently claim the hash.
4. Rank candidate peers.
5. Attempt best peer with Range resume support.
6. On retryable failure, try next peer.
7. If no peer works, fetch from Tilecast Server origin.
8. Verify exact byte count and SHA-256.
9. fsync temporary file.
10. atomically rename into CAS.
11. fsync the destination directory so the rename itself is durable across power loss.
12. record metadata transaction.
13. publish best-effort cache-add event.
14. release the transfer lease and wake all waiters.
```

On a resumed request, require a valid `206 Partial Content` response whose `Content-Range` starts at the exact local partial length and whose total size matches the expected size. If the source returns `200`, restart from byte zero. Never append a response whose range does not match the local partial state.

The receiver **always verifies the final bytes**. mTLS authenticates the peer; it does not make the peer's disk infallible.

CAS startup/recovery must reconcile the two possible crash windows around file promotion and SQLite metadata: a verified CAS file with no metadata row may be re-indexed after validating its hash/path, while a metadata row whose file is missing is removed/marked absent and becomes eligible for refetch. Neither state is treated as a complete object until the filesystem and metadata agree.

### 14.6 Ranking peers and abuse limits

Maintain a bounded rolling score using:

- recent RTT;
- recent effective throughput;
- consecutive failures;
- preferred interface/subnet;
- reported transfer load;
- object-availability freshness.

Also enforce per-peer fairness. A single authenticated node cannot consume all serving capacity.

Bound at least:

- concurrent TLS handshakes per peer/IP;
- concurrent blob transfers per node;
- requests per time window;
- outstanding object-availability queries/replies;
- response bytes/time;
- idle/read/write timeouts.

Global limits remain in place as a second boundary.

Do not build a distributed optimizer in v1. A simple weighted score plus cooldown/fair-share scheduling is sufficient.

### 14.7 No striped multi-peer downloads in v1

Do not split one object into chunks fetched concurrently from multiple peers yet.

Reasons:

- most schools will have 1 Gb/s LANs and small fleets;
- a single peer can usually saturate the destination link;
- multi-source range assembly complicates partial verification and failure recovery;
- the main win is avoiding origin traffic, not maximizing BitTorrent-style swarm throughput.

The protocol should not make future chunking impossible, but it is not a release requirement.

### 14.8 Partial downloads and source switching

A partial record stores:

```text
hash
expected_size
bytes_present
updated_at
```

The object hash is the immutable identity and the canonical ETag is `"sha256:<hash>"` on origin and peers.

A transfer can resume from another authenticated peer/origin only when:

- local partial length is within expected size;
- the new source accepts the canonical validator;
- response is `206`;
- `Content-Range` starts exactly at local partial length;
- total size matches expected size.

If the source returns `200`, restart from zero. A mismatched `206` is rejected, never appended.

Final size + SHA-256 verification remains mandatory before promotion.

### 14.9 Corruption response

On SHA-256 or size mismatch:

- delete/quarantine the bad partial;
- increment a source integrity-failure counter;
- temporarily suppress that peer for this object;
- report a bounded integrity-failure activity event;
- try another peer/origin;
- never activate or serve the failed bytes.

Repeated integrity failures from one authenticated peer should generate a server-derived incident, but a single disk fault should not automatically revoke the node certificate.

### 14.10 Cache pinning and eviction

Pins are independent ownership records, not one mutable reason field.

Objects may be pinned at the same time by:

- active presentation;
- prepared/pending presentation;
- draining presentation during a transition or crossfade;
- next known scheduled presentation inside the configured prefetch horizon;
- active takeover;
- in-progress update deployment;
- current renderer/Edge release;
- previous renderer/Edge release required for rollback.

Eviction is permitted only when no pin rows remain.

Presentation media permissions and CAS pins use the same presentation generation model:

```text
prepared -> active -> draining -> retired
```

When a new presentation activates, the previous generation remains readable and pinned until the renderer acknowledges the transition boundary or a bounded drain timeout expires. This prevents a crossfade or final decoder read from losing access because the new presentation became active.

Unpinned objects use LRU-style eviction constrained by:

- configured maximum cache bytes;
- configured reserved-free-space floor;
- object class priority;
- recent use.

Eviction never deletes a partial file owned by a live transfer lease and never deletes current/previous software releases.

### 14.11 Cache scrub

Add a low-priority scrubber:

- verify a bounded random sample of CAS files periodically;
- always verify an object before first use after an unclean shutdown if metadata indicates uncertainty;
- avoid continuously hashing the entire disk on low-end boxes.

Any detected corruption removes the object and makes it eligible for refetch.

### 14.12 Cache advertisements

Do **not** begin with a Bloom-filter inventory protocol.

For a small school fleet, Zenoh queryables are simpler and exact:

```text
query:  objects/has/<sha256>
reply:  signed node-id + certificate fingerprint + size + endpoint + current load
```

The availability reply is covered by the node-authenticated application envelope when transport identity is not directly exposed by Zenoh. The requester verifies that the HTTPS certificate later presented at the advertised endpoint matches the signed node ID/certificate instance before accepting bytes.

Nodes may also publish best-effort add/evict events to warm local peer indexes. A Bloom filter can be introduced later only if measurements show query fan-out is material at larger fleet sizes.

---

## 15. Signed state distribution and stream topology

Peer relay never creates authority. It only relays exact server-signed state and immutable bytes.

V1 fixes the stream topology **before** protocol schemas are frozen.

### 15.1 V1 streams

Use three logical stream classes:

```text
security/<installation-id>
policy/<installation-id>
screen/<screen-id>
```

**Security stream**

Carries or checkpoints:

- certificate-instance revocation;
- durable-node disablement;
- authority/keyring transitions;
- security-policy state that must not be delayed by another screen.

**Policy stream**

Carries installation-level/shared state such as:

- Context definitions/rules;
- installation Edge policy;
- shared renderer/runtime policy that is not screen-specific.

**Screen stream**

Carries one screen's:

- presentation/current manifest state;
- configuration;
- takeover/current override;
- other screen-scoped state.

The server may keep a global internal audit/outbox order, but players do not consume every other screen's full payload to prove their own stream complete.

Each externally consumed stream has its own cursor/digest chain, retention floor and snapshot checkpoint.

### 15.2 Stream history coordinates

Security and ordinary streams deliberately use different history coordinates.

**Security stream**

```text
installationId
trustRealmId
securityLineageId
streamId = security/<installation-id>
sequence = securityGeneration
authorityEpoch
```

The security stream has **no `stateIncarnationId`**.

**Policy/screen streams**

```text
installationId
trustRealmId
stateIncarnationId
securityLineageId
securityGenerationAtIssue
streamId
sequence
authorityEpoch
```

`securityGenerationAtIssue` identifies the accepted authority/keyring state under which the ordinary document was signed.

A peer cannot change trust realm or ordinary state incarnation. Ordinary incarnation transition comes only through the authenticated recovery re-anchor.

### 15.3 Materialized Edge projection and atomic mutation sets

Do not build a recovery snapshot directly from mutable authoritative tables while async Edge compilation is pending.

Maintain a materialized Edge projection that advances only when the exact Edge representation is durable.

Conceptual server model:

```text
edge_change_outbox
  id
  stream_id
  history_kind            # security_lineage | state_incarnation
  history_id              # securityLineageId or stateIncarnationId
  change_set_id
  mutation_index
  type
  subject_kind
  subject_id
  subject_revision
  tombstone
  object_hash
  payload
  object_ready_at
  projected_at
  attempt_count
  last_error
  next_attempt_at
  superseded_at

edge_stream_state
  stream_id
  history_kind
  history_id
  last_sequence
  head_digest
  PRIMARY KEY (stream_id, history_kind, history_id)

edge_stream_changes
  stream_id
  history_kind
  history_id
  sequence
  previous_sequence
  previous_digest
  stream_digest
  change_set_id
  signed_envelope
  created_at
  PRIMARY KEY (stream_id, history_kind, history_id, sequence)

edge_projection_state
  stream_id
  history_kind
  history_id
  subject_kind
  subject_id
  subject_revision
  state_digest
  tombstone
  object_hash
  projected_payload
  PRIMARY KEY (stream_id, history_kind, history_id, subject_kind, subject_id)
```

For the security stream, `last_sequence == securityGeneration`.

#### Same-stream atomicity

One authoritative DB transaction may change several Edge-visible subjects.

Capture those mutations with one `changeSetId`. The projector does not publish a partial change set.

Once every required object for the change set is durable, one signed stream record contains a deterministic ordered `mutations[]` array and updates every affected projection row plus the stream head in one transaction.

A node applies that record atomically to its local projection.

#### Cross-stream causality

V1 does not pretend two independent streams can be atomically visible at every partitioned node.

When screen state depends on policy state, the screen mutation includes an explicit dependency coordinate such as:

```text
requires:
  policyStreamSequence
  policyStreamDigest
  requiredResourceRevision(s)
```

The node does not activate the dependent screen state until those dependencies are satisfied.

If a product invariant truly requires atomic visibility, place the coupled subjects in one stream/change set instead of relying on cross-stream timing.

#### Compilation/retry

The authoritative transaction captures exact source revisions and pins them.

Object compilation builds those captured revisions. Failed obsolete work may be superseded by a newer change set; current-state-blocking failures raise an incident.

Source pins are released only after projection or explicit safe supersession.

### 15.4 Exact stream digest/signature construction

For each record define `core` as the complete logical record excluding `streamDigest` and `signature`.

Security core includes:

```text
schema
installationId
trustRealmId
securityLineageId
authorityEpoch
streamId
sequence/securityGeneration
previousSequence
previousDigest
mutations
issuedAt
expiresAt
```

Policy/screen core additionally includes:

```text
stateIncarnationId
securityGenerationAtIssue
```

Protocol:

1. validate against the closed schema; reject duplicate keys/malformed UTF-8;
2. `coreBytes = JCS(core)`;
3. decode previous digest, or use 32 zero bytes for genesis;
4. compute:

```text
streamDigest =
  SHA-256(
    "TilecastEdge/stream-digest/v1\0" ||
    previousDigestBytes ||
    coreBytes
  )
```

5. create `signedRecord = core + {streamDigest}`;
6. `recordBytes = JCS(signedRecord)`;
7. sign:

```text
Ed25519(
  authorityKey,
  "TilecastEdge/stream-record/v1\0" || recordBytes
)
```

8. attach Base64url-no-padding signature.

The first record uses null previous sequence/digest; later records must match exactly.

### 15.5 Normative digest constructions

Every digest used for equivocation/recovery has one canonical construction.

#### Subject state digest

```text
stateDigest =
  SHA-256(
    "TilecastEdge/state/v1\0" ||
    JCS(canonicalSubjectState)
  )
```

`canonicalSubjectState` excludes signatures, transport metadata and transient timestamps not part of semantic state.

#### Projection digest

Build a list of projection entries:

```text
{subjectKind, subjectId, revision, stateDigest, tombstone, objectHash/null}
```

Sort lexicographically by `(subjectKind, subjectId)`.

```text
projectionDigest =
  SHA-256(
    "TilecastEdge/projection/v1\0" ||
    JCS(sortedEntries)
  )
```

#### Security-state digest

```text
securityStateDigest =
  SHA-256(
    "TilecastEdge/security-state-digest/v1\0" ||
    JCS(canonicalSecuritySnapshotWithoutDigestOrSignature)
  )
```

#### Authority-keyring digest

Canonicalize key/transition entries sorted by authority epoch:

```text
authorityKeyringDigest =
  SHA-256(
    "TilecastEdge/authority-keyring/v1\0" ||
    JCS(sortedKeyring)
  )
```

#### Payload digest

Where a signed record references a detached canonical payload:

```text
payloadDigest =
  SHA-256(
    "TilecastEdge/payload/v1\0" ||
    canonicalPayloadBytes
  )
```

Cross-language golden fixtures cover every construction.

### 15.6 Cryptographic domain separation

Normative domains include:

```text
TilecastEdge/stream-record/v1
TilecastEdge/current-state/v1
TilecastEdge/snapshot/v1
TilecastEdge/security-state/v1
TilecastEdge/authority-transition/v1
TilecastEdge/recovery-reanchor/v1
TilecastEdge/node-message/v1
TilecastEdge/context-observation/v1
TilecastEdge/object-grant/v1
```

The online Edge authority does **not** sign software release sets. Release sets use the separate offline release-signing domain/key defined in §30.

Each online signing operation is:

```text
domain || 0x00 || canonical message bytes
```

A signature valid in one domain fails in every other domain.

### 15.7 Authority-key acceptance

Authority transitions are security-stream records.

If transition generation G activates authority epoch N+1 at G+1:

- security record G is signed by the old active key and contains the transition;
- security G+1 and later are signed by N+1;
- old key remains usable only for historical verification below its retirement boundary.

After a node has accepted the retirement boundary, a retired key cannot authorize:

- new stream extensions at/above that boundary;
- current-state documents;
- snapshots;
- object grants;
- recovery re-anchors.

If a node is too far behind and would need to cross a retired-key boundary from untrusted peer history, it obtains a current active-authority snapshot/checkpoint from the server instead of accepting an unanchored historical-key extension.

### 15.8 Resource freshness and equivocation

For policy/screen subjects, revisions compare only inside one `stateIncarnationId`.

For one `(stateIncarnationId, subjectKind, subjectId)`:

- higher revision supersedes lower;
- lower revision at later stream sequence is stale no-op;
- deletion is a newer tombstone;
- same revision + same `stateDigest` is idempotent;
- same revision + different `stateDigest` is equivocation/fork.

Security freshness uses `securityLineageId + securityGeneration`, not ordinary revision/incarnation.

### 15.9 Current-state documents are aggregate stream checkpoints

`/streams/<stream-id>/current` is an aggregate checkpoint for one stream, not an ambiguous singular subject document.

Ordinary policy/screen current-state core contains:

```text
trustRealmId
stateIncarnationId
securityLineageId
securityGenerationAtIssue
streamId
baseSequence
baseDigest
projectionDigest
authorityEpoch
generatedAt
inlineProjection or snapshotObject
```

Security current-state core contains:

```text
trustRealmId
securityLineageId
securityGeneration
securityHeadDigest
securityStateDigest
activeAuthorityEpoch
generatedAt
canonicalSecuritySnapshot
signature
```

and has no ordinary state incarnation.

Current-state signatures use `TilecastEdge/current-state/v1` except the canonical security snapshot, which also satisfies the dedicated `TilecastEdge/security-state/v1` fixture contract.

A newly enrolled node or node that lost anti-rollback state obtains its first current security/screen checkpoints directly from the authenticated server.

Objects referenced by current projections remain retained through the applicable stream/snapshot recovery window.

### 15.10 Snapshot checkpoints

Policy/screen snapshots are per stream/history:

```text
trustRealmId
stateIncarnationId
securityLineageId
securityGenerationAtIssue
streamId
baseSequence
baseDigest
projectionDigest
authorityEpoch
generatedAt
object {sha256,sizeBytes}
signature
```

The object serializes `edge_projection_state` at exactly that checkpoint.

Security recovery uses the full security snapshot from §12.4/`security-state-v1`; it does not acquire an ordinary state incarnation merely to fit the snapshot schema.

Snapshot signature uses `TilecastEdge/snapshot/v1`.

### 15.11 Node trusted checkpoint

The node stores two independent anti-rollback components.

**Security trust:**

```text
installationId
trustRealmId
securityLineageId
securityGeneration
securityHeadDigest
securityStateDigest
authorityKeyringDigest
activeAuthorityEpoch
```

**Ordinary stream trust:**

```text
stateIncarnationId
per-stream {streamId, sequence, digest, projectionDigest}
```

Persist by atomic replacement + file fsync + parent-directory fsync.

When accepting newer security state, the security checkpoint may advance without changing ordinary incarnation.

When accepting a new ordinary incarnation, ordinary stream watermarks reset only through direct recovery re-anchor while the security checkpoint stays at least as new.

Checkpoint-before-dependent-SQLite ordering remains mandatory; a checkpoint ahead of SQLite causes local reconstruction, never trust rollback.

### 15.12 Expiry and unknown protocol behavior

`expiresAt` is valid only for explicitly ephemeral effects.

Durable configuration, tombstones, security state, authority transitions and recovery re-anchor have no expiry.

Unknown behavior:

- unknown top-level schema: do not apply;
- closed-schema unknown field: reject;
- unknown policy/screen record type: stop that stream and request compatible current state/snapshot;
- unknown security type/version: stop peer security participation and mesh-sensitive behavior; require server/upgrade resolution;
- never advance a security generation through semantics the node cannot understand.

Server/player protocol capability negotiation prevents publishing required semantics to software that declares it cannot understand them.

### 15.13 Peer/server hints

### 15.13 Peer/server hints

WebSocket/Zenoh hints are bounded wakeups only.

Examples:

```text
edge.stream.available
edge.security.changed
edge.snapshot.available
```

A peer hint never advances:

- trust realm;
- state incarnation;
- security lineage/generation;
- stream sequence/digest;
- resource revision.

Only verified signed state/direct authenticated server recovery does.

### 15.14 What is not an ordinary stream record

State-incarnation recovery transition/re-anchor is **not** a peer-actionable ordinary stream event.

Do not include a recovery-incarnation transition as an ordinary peer-actionable relayable stream record.

Commands and update authorization also remain direct server-authorized state, not peer-created authority.

### 15.15 Secrets stay direct

Peer relay must not carry:

- device bearer credentials;
- node private keys;
- Presentation Network passwords/PSKs;
- integration secrets;
- dashboard/session secrets;
- Edge CA/authority private keys.

The server remains the direct authority for secrets, recovery transitions and command/update authorization.

## 16. Immutable Edge Objects

A signed change can avoid a server round trip only if the referenced state can also be obtained locally.

Introduce immutable **Edge Objects**.

### 16.1 Object properties

An Edge Object is:

- immutable;
- content-addressed by SHA-256;
- bounded in size;
- typed;
- generated only by the server or trusted release pipeline;
- marked whether it is peerable;
- optionally server-signed internally in addition to being referenced by a signed change.

Examples:

```text
presentation_bundle
player_config_public
context_definition_bundle
edge_state_snapshot
release_manifest
```

### 16.2 Presentation bundle

The main object is a `presentation_bundle` containing the fully projected playback data that would otherwise require manifest reconciliation:

```text
schema/version
screen target + revision
presentation fallback
relevant schedules
takeover/presentation override metadata
published layout revisions
widgets/apps prepared for this screen
prepared data-source datasets
media object references (hash, size, MIME, delivery policy)
server clock sample / validity metadata
renderer requirement set
```

The bundle contains references to media objects, not embedded 500 MB videos.

### 16.3 Screen targeting

A presentation bundle may be screen-specific. Peers are allowed to cache/relay it, but only the target screen may **apply** it.

The target screen ID is covered by the server signature/change envelope.

This avoids inventing an encryption layer for ordinary signage content while still preventing one screen from treating another screen's assignment as its own.

### 16.4 Server object endpoint

Add authenticated player endpoint:

```http
GET /api/v1/player/edge/objects/<sha256>
```

The server checks that:

- the caller is an enrolled active player in this installation;
- the object is peerable to players;
- the hash exists;
- any object-specific authorization constraints are met.

It returns immutable Range-capable bytes. This endpoint becomes the origin fallback behind the peer CDN.

### 16.5 Object storage

Use the server's existing generated storage abstraction rather than creating arbitrary paths. Edge-object metadata lives in PostgreSQL; bytes live in the configured server storage root under generated/hash-based keys.

Media variants that already have trusted SHA-256 do not need to be duplicated into new files merely to participate in Edge. The Edge origin endpoint can map an eligible media hash to its existing storage object.

---

## 17. Soft coordinator roles

Some work is cheaper when one node does it first. This does **not** require leader consensus.

Define soft, optimization-only roles such as:

- `change-fetcher`
- `content-seeder`
- `release-seeder`
- `context-refresh-helper` for a source explicitly eligible for local refresh

### 17.1 Election

Use deterministic rendezvous hashing across the current live eligible node set:

```text
score = H(installation-id || role || node-id)
selected = highest score
```

Recompute when liveliness changes, with a small hold-down/jitter window to avoid churn.

### 17.2 Safety rule

Every soft coordinator operation must be:

- idempotent; or
- content-addressed; or
- server-signed before it becomes authoritative.

Network partitions may produce two coordinators. That is acceptable. Duplicate prefetching wastes bandwidth but cannot create two truths.

If deleting the coordinator makes the system incorrect rather than merely less efficient, that task does not belong in the soft coordinator model.

### 17.3 Seeder behavior

A content seeder may proactively fetch peerable objects referenced by newly observed signed changes when:

- disk budget permits;
- the object is likely relevant to multiple active nodes;
- current transfer load is below a limit.

This improves the chance that disconnected/slower peers can satisfy the update locally.

---

## 18. Context Engine

The Context Engine is the shared, local model of “what is happening right now” that presentations can consume without every widget independently polling external systems.

### 18.1 Design goals

Context must be:

- typed;
- scoped;
- attributable to a source;
- freshness-aware;
- deterministic under conflicting sources;
- locally available while offline;
- safe to use in user-authored conditions;
- relayable when appropriate;
- incapable of becoming arbitrary code execution.

### 18.2 Context record and deterministic value encoding

A candidate is conceptually:

```json
{
  "key": "school.phase",
  "type": "string",
  "value": "lunch",
  "scope": {"kind": "organization", "id": "..."},
  "sourceId": "bell-schedule",
  "sourceEpoch": "...",
  "sourceRevision": "418",
  "definitionRevision": "12",
  "priority": 50,
  "observedAt": "2026-09-22T20:10:00Z",
  "expiresAt": "2026-09-22T20:55:00Z",
  "freshness": "live"
}
```

Supported v1 value types remain deliberately small:

```text
boolean
signed integer
finite number
string
timestamp
duration
string enum
bounded list of scalar values
bounded object with declared schema
```

Signed/wire rules:

- integers outside the agreed JSON-safe range use canonical decimal strings;
- floating values must be finite; reject NaN and ±Infinity;
- normalize/reject ambiguous negative zero according to the E0 numeric fixture contract;
- timestamps are canonical UTC RFC 3339 with the agreed fractional-second precision;
- durations use one documented canonical representation;
- lists/objects have schema-defined size/depth limits.

Do not accept arbitrary unbounded JSON.

### 18.3 Scope/source precedence

Scopes:

```text
organization
location
display_group
screen
```

More-specific applicable scope wins:

1. screen;
2. display group;
3. location;
4. organization.

For each `(sourceId, sourceEpoch)`, first choose that source's newest valid candidate by its own source sequence/revision.

Then compare candidates from different sources using configured authority order:

1. higher configured source priority;
2. explicit configured stable source order where needed;
3. stable source ID tie-break.

Do **not** compare source-local revision numbers across different sources. Revision 418 from source A is not inherently newer/better than revision 2 from source B.

Do not resolve conflicts by whichever machine's wall-clock timestamp looks newest.

### 18.4 Freshness

Every source declares a freshness policy.

A context value can be:

```text
live
stale
expired
unavailable
```

A source becoming stale does not silently turn its last value into a new live observation.

Rules may explicitly opt into stale last-known-good values if the use case permits it. Example:

```text
Weather condition: last known good for 60 minutes
Emergency state: no stale reuse
Bell schedule: locally derivable from cached schedule indefinitely until its revision end date
```

### 18.5 Context sources

Initial server-owned sources:

- manual operator context;
- calendar/bell schedule;
- scheduled organization event state;
- weather-derived context;
- active takeover/emergency state;
- existing prepared Data Source fields promoted into context through an explicit mapping;
- school/day metadata.

Initial Edge-local sources:

- ambient light;
- noise level aggregate;
- motion/presence sensor if configured;
- typed button/HID state/events;
- host/display power state;
- selected system-health measurements where useful to presentation logic.

Do not automatically expose every telemetry metric to presentation authors.

### 18.6 Source authority

Server-owned sources are represented by server-signed context definitions/changes.

Edge-local sensor observations are signed/authenticated as originating from that node, but they are not server-authoritative facts. A context definition determines which nodes/scopes may contribute to a key.

Example: only the Cafeteria Left node may be configured as a contributor to `cafeteria.noise`.

A peer cannot publish `building.emergency = false` merely because it possesses a valid Edge certificate.

### 18.7 Storage

`context_candidates` keeps only the current/recent candidate necessary to recompute effective values, not an unbounded time series.

`context_effective` persists the last effective value, source, revision and freshness metadata so playback can restart offline.

Long-term historical analytics, if ever needed, belong in server Activity/metrics—not in an ever-growing local SQLite table.

### 18.8 Mesh propagation

Locally authored observations use a domain-separated signed envelope with at least:

```text
trustRealmId
nodeId
certificateFingerprint
sourceId
sourceEpoch
sourceSequence
definitionRevision
key
scope
typed value
observedAt
expiresAt
schema
signature
```

Sign with `TilecastEdge/context-observation/v1`.

`sourceEpoch` is a random 128-bit source-incarnation identifier. `sourceSequence` increases monotonically within `(nodeId, sourceId, sourceEpoch)`.

A new authenticated source epoch supersedes the previous incarnation for that source. Sequence numbers from different epochs are never compared.

The signed `definitionRevision` binds the observation to the permission/schema/freshness policy under which it was authored. If the definition changes, old candidates are revalidated/retired; they are not silently reinterpreted under a different permission/schema.

Replay watermarks for an old epoch may be deleted only after every packet from that epoch can no longer pass the receiver's freshness/certificate acceptance policy.

Each source definition provides maximum TTL. Receiver trusted time clamps sender `expiresAt`; sender timestamps cannot extend freshness beyond policy.

The observation verifies certificate instance, trust realm, installation/node state, current security generation, source permission, definition revision, scope, value encoding/schema, epoch and replay sequence.

Server-only keys remain impossible for an Edge-local source to claim.

## 19. Context rules with CEL

Use Common Expression Language instead of inventing a Tilecast expression parser.

CEL is designed for embedded, safe, non-Turing-complete expressions and for compile/check-once, evaluate-many workloads. That maps directly to content visibility/selection rules.

### 19.1 Rule example

```cel
context.school.phase == "lunch" &&
context.events.football_game == true &&
context.weather.condition != "severe"
```

### 19.2 Authoring model

Most users should never need to type CEL.

Studio provides a shadcn Base UI + Rhea condition builder that follows the canonical Studio plan:

```text
Show when

[ School phase ] [ is ] [ Lunch ]
           AND
[ Football game today ] [ is ] [ Yes ]
```

The builder stores canonical CEL.

An **Advanced expression** mode may expose the CEL source for administrators/editors who need it.

### 19.3 Validation and resource limits

The server is the publication gate.

At save/publish:

1. enforce a maximum expression byte length;
2. parse with `cel-go`;
3. enforce maximum AST nodes/depth and bounded literal/list/object sizes;
4. type-check against Tilecast's declared Context schema;
5. reject unknown keys/functions/type mismatches;
6. reject constructs outside the documented Tilecast CEL subset;
7. compile/evaluate known test vectors under an explicit work/cost limit;
8. store source plus normalized rule metadata and compiler/subset version.

The Edge evaluator enforces equivalent complexity/work limits at runtime. A malicious or accidentally expensive rule must not consume unbounded CPU during every presentation tick.

Prefer a deliberately small subset. If comprehensions/macros cannot be costed consistently across Go/Rust evaluators, reject them in v1.

Numeric/timestamp/duration edge cases are part of the cross-language fixture suite, including overflow, invalid duration/timestamp and non-finite number rejection.

### 19.4 Rust evaluator

Use a maintained Rust CEL implementation only behind a Tilecast compatibility layer.

The Edge runtime supports a documented subset such as:

- boolean operators;
- equality/comparison;
- scalar arithmetic where types allow it;
- list membership;
- safe string predicates;
- timestamp/duration comparisons;
- no host I/O;
- no custom function that can mutate state.

### 19.5 Differential conformance suite

This is a release blocker.

Create `packages/edge-protocol/fixtures/cel/` with hundreds of expressions and typed contexts. CI evaluates every vector through:

- Go `cel-go` server evaluator;
- Rust Edge evaluator.

Results/errors must agree.

If the Rust implementation cannot faithfully support a construct, the server must reject that construct for Edge rules. Never publish a rule that evaluates one way on the server and another way on a player.

### 19.6 What rules may do

V1 rules produce declarative results only, for example:

- visible/not visible;
- eligible/not eligible;
- choose a named content variant;
- set bounded style/content values already allowed by a widget schema.

A rule cannot:

- execute a command;
- launch a process;
- fetch an arbitrary URL;
- modify NetworkManager;
- write a file;
- directly power off a display.

If context-driven hardware automation is added later, it must map to a closed typed action registry with explicit policy and audit.

---

## 20. Clock Authority

Tilecast already has server-corrected time and monotonic synchronized-playback logic. Edge should make the source and quality of time explicit rather than replacing that proven behavior.

### 20.1 Separate wall time from progression

Two clocks have different jobs:

- **Wall-clock authority** chooses when a schedule/availability rule begins.
- **Monotonic time** advances an already-running presentation.

A wall-clock correction during playback must not rewind or fast-forward an active playlist cycle. The existing preload synchronization logic already follows this pattern; migrate it into `tilecastd`.

### 20.2 Authority order

The Clock Authority has a **security minimum** that ships before the first mTLS mesh, plus richer providers added later.

Security minimum, required by E5:

- persisted trusted-time lower bound;
- uncertainty bound;
- server-offset samples with bounded RTT;
- host synchronized/unsynchronized state;
- certificate-validity decision API;
- `time_untrusted` state.

Provider preference after E10 may use:

1. valid synchronized PTP source, if explicitly available;
2. synchronized host NTP/chrony/systemd-timesyncd state;
3. Tilecast Server measured offset;
4. local system wall clock with degraded quality.

Selection considers uncertainty and freshness rather than only a fixed priority. A provider that claims a higher class but has stale/bad uncertainty does not override a healthier lower class.

The mTLS implementation may use trusted time only if the pinned rustls/Zenoh path actually accepts a custom verifier/time provider. Otherwise Edge requires trustworthy host wall time before enabling mesh transport. This is an E5 implementation gate, not deferred Clock UI work.

### 20.3 Server offset

Preserve the existing Tilecast strategy as universal fallback. Server responses/socket pings can continue to estimate an offset using bounded RTT measurements. Persist enough state to restore a reasonable corrected clock on offline boot until a better sample becomes available.

### 20.4 PTP v1 scope

Do not have Tilecast configure itself as a time server/grandmaster.

Initial PTP integration is:

- detect `ptp4l`/PHC capabilities;
- inspect configured synchronization state;
- report whether the host is synchronized;
- consume the synchronized host clock as higher-quality authority;
- display quality in Studio.

If Tilecast later offers managed PTP configuration, it must be explicit opt-in and use **client-only** semantics (`ptp4l -s` / `clientOnly 1`). `phc2sys` remains the standard tool for synchronizing the system clock to the PHC. Tilecast should supervise/integrate with these tools, not reimplement IEEE 1588.

### 20.5 Clock changes

Detect:

- wall-clock step;
- timezone change;
- authority source change;
- PTP loss;
- suspend/resume;
- monotonic discontinuity where applicable.

Reevaluate schedules/context boundaries after a clock change, while preserving monotonic progression for already-active synchronized items until the next defined re-anchor boundary.

---

## 21. Capability model

Capabilities are versioned contracts. Do not reduce the current Tilecast capability model to an unversioned string set.

### 21.1 Capability state

```text
available
unavailable
blocked
degraded
unknown
```

A capability report includes bounded reason/diagnostic metadata.

### 21.2 WPE renderer profile

Every signed Edge release carries one trusted static WPE renderer capability manifest. Runtime probes refine availability but do not invent protocol support.

Example:

```json
{
  "renderer": "wpe",
  "release": "1.4.0",
  "ipcProtocol": {"min": 1, "max": 2},
  "presentationSchemas": [1],
  "nativeCapabilities": {
    "content.image": 1,
    "content.video.h264": 2,
    "content.metric": 1,
    "layout": 2
  },
  "webRuntimeVersion": 2,
  "limits": {
    "webBundleBytes": "20971520",
    "maxVideoWidth": 3840,
    "maxVideoHeight": 2160
  }
}
```

There is no Electron Edge renderer profile and no runtime renderer selector. A prepared presentation is compatible only when the installed WPE profile plus current host/runtime capabilities satisfy its complete requirement contract.

This preserves the current versioned capability model while making the supported Linux renderer unambiguous.

### 21.3 Hardware/platform capabilities

Separate renderer protocol support from host capabilities:

- display backend/connector/mode;
- codec/decode path availability;
- CEC/DDC;
- PipeWire input/output;
- Presentation Network;
- sensors;
- time providers;
- WPE runtime/ABI;
- Wayland/DRM session mode.

### 21.4 Presentation requirements

A prepared presentation carries versioned requirements rather than a string set:

```json
{
  "presentationSchema": 1,
  "nativeCapabilities": {
    "content.image": 1,
    "content.video.h264": 2,
    "layout": 2
  },
  "webRuntimeMinVersion": 2
}
```

Compatibility requires the installed WPE renderer profile plus current host/runtime capabilities to satisfy the full requirement set.

### 21.5 Reporting

The node reports the installed WPE profile revision, active WPE runtime details and host capabilities. A renderer process may report runtime evidence after launch. That evidence validates/refines the signed installed profile; it is not the bootstrap source for compatibility decisions.

## 22. Avahi and LAN service discovery

Keep mDNS as convenience/bootstrap, but use the host-native Avahi daemon instead of embedding another JavaScript Bonjour stack.

Avahi's own documentation recommends its D-Bus API for non-C applications and discourages running multiple mDNS stacks on a normal host.

### 22.1 Services

Keep existing:

```text
_tilecast._tcp.local
```

for Tilecast Server discovery.

Add:

```text
_tilecast-edge._tcp.local
```

for operator/bootstrap visibility of Edge peer endpoints.

### 22.2 Edge TXT fields

Avoid advertising permanent installation/node UUIDs before authentication.

Safe v1 examples:

```text
protocol=1
port=7448
discovery-id=<random boot/session opaque id>
```

`discovery-id` is regenerated on boot/session restart and is useful only for deduplication/bootstrap diagnostics.

Learn durable installation/node identity after mTLS/logical-node authentication.

Do not include:

- installation UUID;
- durable node UUID;
- screen credentials;
- certificates/private material;
- pairing secrets;
- Wi-Fi details;
- raw hardware inventory;
- content names.

### 22.3 D-Bus implementation

Use `zbus` in Rust to call Avahi's D-Bus API. Handle avahi-daemon restart and service-name collision. mDNS failure changes discovery capability state; Zenoh static seeds/manual server URL still work.

---

## 23. NetworkManager and Presentation Network

The current Presentation Network architecture is one of the stronger security boundaries in the Linux player and should be preserved.

### 23.1 Keep these invariants

- Ethernet/default route continues to carry Tilecast traffic.
- Presentation Wi-Fi never becomes the default route.
- Presentation Wi-Fi DNS never replaces normal DNS.
- Tilecast never bridges/routes the two networks.
- helper owns only profiles named `tilecast-presentation-<uuid>`.
- helper has no generic NetworkManager property API.
- secrets pass over a Unix socket, not argv/logs.
- missing NetworkManager is a capability limitation, not a player failure.
- installer does not silently install/enable NetworkManager on a host using another network stack.

### 23.2 Migration

Move the **unprivileged client** currently in Electron into the Edge platform layer first. Keep the deployed Python root helper protocol compatible.

Later, if there is a clear maintenance benefit, replace the helper implementation with a root-owned Rust helper using NetworkManager D-Bus directly. That is a separate migration and must preserve the same five-operation/Tilecast-profile-only contract.

### 23.3 Mesh exclusion

When a Presentation Network activates or an interface becomes newly forbidden, `tilecastd` must:

1. withdraw Edge Avahi publication from that interface;
2. stop/rebind Zenoh and peer-blob listeners so they do not accept new traffic there;
3. close existing Zenoh/peer-HTTPS sessions whose local path uses the newly forbidden interface;
4. remove stale advertised endpoints;
5. re-run permitted-interface discovery before reconnecting.

No existing or new peer traffic should expose Tilecast Edge to AirPlay sender VLANs.

---

## 24. CEC and DDC/CI

Move current display-control ownership from the Electron host into `tilecastd`.

### 24.1 Providers

Initial provider behavior stays intentionally boring:

- HDMI-CEC through `cec-ctl`;
- DDC/CI through `ddcutil`;
- fixed typed commands;
- direct argv invocation, never shell;
- five-second-ish bounded timeout;
- bounded output capture;
- capability probing separate from command result;
- command-send success separate from confirmed physical state.

### 24.2 Permissions

Use udev/group access to `/dev/cec*` and required I²C devices rather than root proxying if possible.

Studio capability details should distinguish:

```text
DDC hardware detected, working
DDC hardware detected, permission denied
DDC utility missing
No compatible monitor detected
```

### 24.3 Future direct libraries

Direct libCEC/DDC library integrations may replace subprocess tools only if they materially improve reliability. They are not necessary to ship Edge and should not block the daemon split.

---

## 25. PipeWire audio subsystem

PipeWire's node/port/link graph is a good model for turning Linux audio into a first-class Tilecast capability.

### 25.1 Provider responsibilities

The Edge PipeWire provider may expose typed concepts:

```text
audio outputs
microphone/input sources
current default output
Tilecast-selected output
route health
capture availability
```

Later bounded operations:

```text
set presentation output
set announcement output
apply ducking policy
start/stop local level meter
```

### 25.2 Stable identity

Do not save a transient PipeWire numeric object ID as durable configuration. Build a stable device selector from appropriate properties such as ALSA path/device serial/node name and report when the selected device is missing.

### 25.3 Audio routing

A future effective audio policy may look like:

```text
normal presentation  -> TV HDMI
announcement         -> TV HDMI + USB PA interface
emergency            -> configured emergency outputs
```

The policy remains typed and server-controlled. No arbitrary graph patch language is sent from Studio.

### 25.4 Ducking

If implemented, ducking is a bounded local policy:

```text
normal media target gain: 1.0
announcement active:       0.15
fade down/up:              bounded configured durations
```

Audio control must return to prior state when an announcement ends or the controlling process crashes.

### 25.5 Noise Meter migration

Move Noise Meter capture from browser `getUserMedia` to a PipeWire capture stream when available.

Privacy invariant:

```text
microphone samples
      ↓
local level calculation
      ↓
derived bounded level/history bucket
      ↓
raw samples discarded
```

No PCM buffer, recording or speech content is serialized to the server or mesh.

If PipeWire capture is not available, retain an explicitly reported unsupported/degraded state. Do not keep the legacy browser microphone path as an Edge fallback.

---

## 26. udev and typed hardware sensors

Use udev to discover hardware and monitor hotplug. The presence of a device should update capabilities without rebooting the player.

### 26.1 Provider registry

Each hardware adapter has:

```text
provider ID
match rules
capabilities exposed
permissions required
configuration schema
measurement/event schema
privacy classification
```

No adapter may expose arbitrary device-file reads through Studio.

### 26.2 Initial adapters

Good first candidates:

- Linux IIO ambient-light sensor;
- `hwmon` temperature/thermal measurements;
- evdev/HID button devices with explicit allowlisting;
- limited USB HID controls;
- microphone presence through PipeWire rather than raw ALSA device files.

GPIO and serial can follow once specific supported hardware/provider contracts exist. Do not add a generic “serial script” feature.

### 26.3 Input events

Physical buttons should produce typed events such as:

```json
{
  "inputId": "cafeteria-button-1",
  "event": "pressed",
  "observedAt": "..."
}
```

An administrator explicitly maps the hardware instance to a Tilecast input identity. Unrecognized keyboards/HID devices are not automatically made interactive signage controls.

### 26.4 Ambient brightness

An ambient-light provider may feed Context Engine, an explicit display-brightness policy, or both. Automatic DDC brightness must use bounded ranges, smoothing/hysteresis and an operator-defined min/max to avoid oscillating or making the display unreadable.

---

## 27. systemd integration

systemd becomes the Linux process supervisor rather than the last rung inside Electron.

### 27.1 systemd service and socket ownership

The daemon service uses the stable launcher from §7:

```ini
[Service]
Type=notify
User=tilecast-edge
Group=tilecast-edge
ExecStart=/opt/tilecast-edge/launcher/tilecast-edge-launcher
Restart=always
RestartSec=2
WatchdogSec=30s
StateDirectory=tilecast-edge
StateDirectoryMode=0700
UMask=0077
```

Do **not** set `RuntimeDirectory=tilecast-edge` on the service while independent socket units own sockets below the same tree. The service must not remove the parent directory when it stops.

Use `tmpfiles.d` or equivalent package-managed creation for:

```text
/run/tilecast-edge/              root:root              0755
/run/tilecast-edge/renderer/     root:tilecast-renderer 0750
/run/tilecast-edge/admin/        root:tilecast-admin    0750
/run/tilecast-edge/health/       tilecast-edge:tilecast-edge 0700
```

Socket units listen on:

```text
/run/tilecast-edge/renderer/control.sock
/run/tilecast-edge/renderer/media.sock
/run/tilecast-edge/admin/admin.sock
```

with intent:

```ini
# renderer control/media
SocketUser=tilecast-edge
SocketGroup=tilecast-renderer
SocketMode=0660

# admin
SocketUser=tilecast-edge
SocketGroup=tilecast-admin
SocketMode=0660
```

The parent/subdirectory traversal permissions are part of the integration test. A socket with mode 0660 is useless if its client group cannot traverse an ancestor directory.

The socket units own/listen on their sockets and pass descriptors to `tilecastd`; the daemon never unlinks/rebinds them. Stopping/restarting `tilecast-edge.service` therefore cannot accidentally delete the socket namespace owned by socket units.

The stable launcher:

1. resolves `/opt/tilecast-edge/current-set`;
2. validates that the selected set manifest/component paths remain inside the immutable release roots;
3. verifies required component presence/permissions;
4. execs the selected set's `tilecastd`.

Add service hardening after testing required hardware access:

```text
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict or full with explicit writable paths
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
LockPersonality=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes except where PipeWire setup explicitly needs otherwise
```

Do not copy helper settings blindly when they would block qualified DRM/I²C/udev access. Maintain a tested capability matrix.

### 27.2 Readiness

### 27.2 Readiness

`tilecastd` sends:

```text
READY=1
STATUS=Paired · mesh healthy · renderer ready
```

Readiness means the daemon's persistent state is open and the local IPC/control plane is usable. It does not require the Tilecast Server to be reachable.

### 27.3 Watchdog

When systemd provides `WATCHDOG_USEC`, send `WATCHDOG=1` at approximately half that interval, matching systemd's recommendation.

Only the main daemon health loop sends watchdog notifications. A stuck renderer must not falsely stop `tilecastd`'s watchdog if the daemon is healthy enough to recover it.

### 27.4 Renderer service

The WPE renderer is the only Linux Edge display engine.

Supported host modes:

1. **Wayland mode** — development and qualified installations where Tilecast deliberately owns/integrates with a compositor/session.
2. **Direct DRM/KMS mode** — preferred dedicated-signage path; WPEPlatform owns the display directly with no desktop compositor.
3. **Headless mode** — CI/integration testing only.

Every renderer launch receives a new random renderer generation. The daemon also records the launched PID/start identity or pidfd and rejects stale renderer processes that attempt to reconnect after restart.

Prefer daemon-created connected Unix socket/socketpair descriptors inherited only by the child renderer process where practical. Do not rely on a bearer-like renderer token stored in an environment/file as the primary boundary.

Renderer lifecycle is bound to the daemon. A `tilecastd` restart stops/recreates WPE and creates a new renderer generation. The renderer unit may use `PartOf=tilecast-edge.service`/equivalent dependency semantics once validated with the selected launch model.

`tilecastd` passes only renderer/media communication handles, presentation bootstrap data and required display/media-device access. The renderer never receives server bearer credentials or node private keys.

There is no Electron runtime fallback. Repeated WPE failure escalates through renderer recovery and then safe mode; software rollback is a release/installer action, not renderer selection.

### 27.5 Safe mode

Preserve the current recovery concept but redefine the layers:

```text
renderer retry
current item retry/skip
re-activate prepared presentation
WPE view reload/recreate
WPE renderer process restart
Edge process restart only for Edge faults
safe mode
```

Safe mode keeps:

- server connection;
- peer mesh;
- CAS validation;
- pairing/recovery;
- typed commands;
- Studio health;
- local diagnostics.

Safe mode never launches Electron.

## 28. Renderer architecture: WPE WebKit only

WPE is the Linux renderer for Tilecast Edge.

`tilecastd` owns the player; `tilecast-renderer-wpe` renders the prepared presentation. Electron is not an Edge component, compatibility renderer, or runtime fallback.

### 28.1 Target WPE baseline

Target a tested, security-patched **stable WPE WebKit 2.54.x** build and the stable WPEPlatform API. Upgrade the qualified series deliberately rather than assuming every numerically newer build is compatible.

Do not build new Tilecast code around legacy `libwpe`, WPEBackend-fdo, or Cog.

WPEPlatform provides:

```text
WPE_PLATFORM=headless
WPE_PLATFORM=wayland
WPE_PLATFORM=drm
```

Use headless for CI, Wayland for development/qualified compositor deployments and DRM/KMS for dedicated production signage.

### 28.2 First-party launcher

Build `apps/edge/renderer-wpe` as a deliberately small C11/GLib program using `wpe-webkit-2.0` and `wpe-platform-2.0`.

Responsibilities:

- connect to Edge renderer IPC and negotiate the protocol;
- create the WPEPlatform display/view;
- load trusted Tilecast renderer assets;
- install the strict native-to-JS bridge;
- configure trusted local URI handlers and the `tcmedia` GStreamer source;
- enforce website navigation/permission/data policies;
- report meaningful progress/errors;
- support bounded preview capture;
- exit on unrecoverable engine failure so `tilecastd`/systemd can recreate it.

It must not contain playlist selection, schedule policy, context merge logic, content downloading, credentials or update authority.

### 28.3 Trusted renderer runtime

Port/extract the dependency-free DOM/render-tree behavior from the legacy Electron renderer into the trusted WPE runtime.

The runtime contains image/video presentation, transitions, native widget render-tree interpretation, layout rendering, QR/SVG/chart primitives, browser-local visual ticking, meaningful-progress instrumentation and safe fallback surfaces.

It contains no server networking, credential storage, filesystem policy or player scheduling.

`apps/player-linux` may remain temporarily as a behavioral reference and fixture source. It is not built into Edge releases and does not implement Edge IPC.

### 28.4 Trusted runtime/media origins

Keep trusted Tilecast code and remote website content in distinct security worlds.

The trusted runtime uses a dedicated local scheme registered with the applicable WebKit security-manager API as local/secure where supported. It serves only embedded/versioned renderer files with strict MIME + CSP.

Tilecast media uses `tcmedia://cap/<opaque-capability>` through the daemon-backed source from §9.5.

A remote website knowing a CAS hash is insufficient to read media because:

- hashes are not media capabilities;
- opaque capabilities are random and generation-bound;
- the daemon validates renderer/presentation capability state on every media read;
- untrusted website views never receive capability values.

Qualification must still prove remote pages cannot use browser APIs to discover or exfiltrate those capabilities.

Where practical, remote website zones use separate WebViews/processes/data managers that are created without the trusted runtime user-content manager/native bridge. They do not inherit privileged local-scheme handlers unnecessarily.

Uploaded/media bytes receive strict non-executable MIME treatment and never become trusted runtime HTML/JS.

### 28.5 Native/JS bridge

Expose only named, typed operations such as `ready`, `progress`, `itemError`, `websiteState`, and `previewReady`.

Never expose a generic native invocation function.

The bridge is installed only in the trusted Tilecast runtime's isolated content world/user-content manager and only for the expected top-level trusted frame.

Remote website WebViews/zones are created without that bridge registration. A remote iframe/site must not gain bridge access merely because it is visually embedded in a trusted layout.

E0/WPE integration tests exercise the exact pinned WebKit API behavior for:

- isolated content world;
- top-frame versus child-frame delivery;
- navigation away from trusted runtime;
- new-window/pop-up attempts;
- process crash/recreation.

If the pinned WPE API cannot robustly frame/world-isolate the bridge, remote website content must run in a separate WebView/process boundary with no bridge-enabled user-content manager.

### 28.6 Website playback

Remote website content is hostile browser content even when intentionally configured.

V1 remote-site policy applies to every network-capable browser path, including:

- document/subresource HTTP(S);
- redirects and fresh DNS resolutions;
- WebSockets;
- EventSource/streaming fetch;
- dedicated/shared workers;
- service-worker fetch/cache;
- image/media/font/script loads.

Destination policy is enforced after DNS resolution and again at connection/re-resolution boundaries.

Denied by default:

```text
IPv4 0.0.0.0/8
IPv4 loopback 127.0.0.0/8
IPv4 link-local 169.254.0.0/16
RFC1918 private ranges
CGNAT 100.64.0.0/10
IPv4 multicast/reserved/non-global ranges as policy defines

IPv6 ::/128
IPv6 ::1/128
IPv6 link-local fe80::/10
IPv6 unique-local fc00::/7
IPv6 multicast ff00::/8
IPv4-mapped forms of denied IPv4 addresses
other non-global/special ranges in the pinned policy table
```

Explicit operator-approved intranet origins/CIDRs may be allowed for a signage use case, but are part of the presentation requirement/policy and still use DNS-rebinding-safe checks.

Browser proxy mode is explicit; ambient environment/system proxy inheritance is not accepted accidentally.

V1 disables unless explicitly required by a future typed feature:

- WebRTC/media capture/data channels;
- microphone/camera/geolocation/notifications;
- file chooser/uploads from local filesystem;
- downloads;
- external-protocol launches;
- remote inspector/developer extras in production.

Persistent website cookie/IndexedDB/Cache Storage/service-worker storage is bounded per site and globally and participates in renderer-data cleanup quotas.

If WebKit APIs cannot enforce egress consistently across all browser channels, run website traffic behind an OS/network namespace/firewall boundary. Until one of those enforcement paths passes adversarial tests, website capability is unsupported rather than falling back to Electron.

### 28.7 Presentation compatibility

### 28.7 Presentation compatibility

Every prepared presentation carries the versioned requirement contract from §21.

`tilecastd` compares it against the signed WPE renderer profile, pinned WPE runtime/ABI, current host/media probes and selected display backend.

If the complete set is not satisfied, Tilecast reports a precise `presentation_incompatible` reason and preserves the last valid presentation/safe surface. It never silently omits unsupported content and never launches a second renderer engine.

### 28.8 Display backend policy

Renderer kind is fixed to WPE. The configurable choice is only the WPEPlatform backend:

```text
displayBackend = auto | drm | wayland
```

`auto` prefers qualified DRM/KMS on dedicated signage hosts and otherwise uses a deliberately configured Wayland session. Headless is test-only.

### 28.9 DRM/KMS production mode

DRM/KMS is the preferred dedicated-signage path because WPEPlatform can render directly without a desktop compositor.

Before making DRM default on a hardware class, validate connector/mode selection, hotplug, VT/session ownership, device ACLs, old Intel/Mesa behavior, H.264 hardware decode, renderer crash/restart display reclaim, CEC/DDC coexistence, active-hours/display sleep and preview behavior.

There is no Electron fallback if WPE is unhealthy. Recovery remains within WPE/Edge or enters safe mode.

### 28.10 Wayland mode

Wayland exists for development and installations where a compositor/session is intentionally part of the supported host profile.

Tilecast must own or deliberately integrate with that compositor/session. Do not depend on ambient `WAYLAND_DISPLAY`, `DISPLAY` or `XDG_RUNTIME_DIR` values inherited from an installer shell.

Wayland is not an Electron compatibility environment.

### 28.11 Headless CI

Every renderer PR runs a real WPE headless integration suite covering status/setup, daemon restart/reconnect, renderer crash/recovery, images, CAS-backed H.264 video, widget/render trees, layouts, transitions, synchronized projection, website policy fixtures, malformed/stale IPC and preview capture where supported.

The qualification requires real daemon-accepted meaningful-progress evidence, not only DOM assertions.

### 28.12 Legacy behavior corpus

Use the current Electron player only as a temporary source of behavioral expectations and fixtures while porting.

Capture deterministic semantic renderer events, item timing, layout/DOM assertions, error behavior and meaningful-progress behavior. WPE is compared against those expectations. Production builds do not contain Electron and field nodes do not run A/B renderer selection.

### 28.13 Meaningful progress remains authoritative

Changing browser engines must not weaken Tilecast's existing health model.

`renderer.ready` is not playback progress. Progress remains content-aware: video position advances; images render and duration boundaries continue; websites reach first meaningful render; layout zones render/rotate as expected; item transitions occur; indefinite content uses bounded health confirmation only when no better signal exists.

### 28.14 WPE process model

Keep WebKit's multi-process model and enable its Linux subprocess sandbox before any web process is created.

The launcher owns WPEPlatform display/view lifetime, WebKit context/data-manager policy, sandbox enablement, trusted URI handlers/`tcmedia` integration, navigation/permission decisions, native bridge, renderer IPC and instance generation.

A WebProcess/GPUProcess/network-process crash is renderer health input. `tilecastd` retains authority and recreates WPE according to the recovery state machine.

---

## 29. WPE renderer state machine

```text
NoRenderer
   ↓
CheckPresentationCompatibility
   ├─ compatible ─────► StartingWPE
   │                       │
   │                     Ready
   │                       │
   │                   unhealthy
   │                       ▼
   │                  RecoveringWPE
   │                       │
   │               repeated failure
   │                       ▼
   │                    SafeMode
   │
   └─ incompatible ───► PresentationIncompatible
```

A renderer recovery/incompatibility event is persisted and reported to Activity with bounded reason codes.

No state launches Electron.

## 30. Edge software updates

Tilecast Edge introduces another critical process, so its update path must be at least as safe as the current Linux AppImage updater.

### 30.1 Keep release authorization on the server

Peer availability does not authorize installation.

The existing update domain/deployment model remains responsible for:

- selected release/channel;
- target screens;
- canary cohort;
- maintenance window;
- pause/cancel/retry;
- target settlement.

A peer may provide the bytes, but only an authorized deployment permits installation.

### 30.2 Signed release sets and compatibility metadata

Software releases use the existing **offline/CI release-signing authority**, not the online Edge state authority.

Normative release-set signing domain:

```text
TilecastRelease/release-set/v1
```

`release-set-v1.schema.json` is verified against the configured offline release public key.

A deployment selects one signed release-set manifest containing:

```text
releaseSetId
tilecast-edge version/hash
renderer-wpe version/hash
private WPE runtime version/hash/ABI
required privileged-helper protocol
ipcMinProtocol/ipcMaxProtocol
stateSchemaMinReadable/stateSchemaMaxReadable/stateSchemaWritten
rollbackReadWriteCompatibleSetIds
hostMode constraints
minimum security-patched WPE build
```

Artifacts are independently hash/size verified, but activation/rollback changes the set as one unit.

Compatibility metadata is evidence only when CI/tests prove it.

At minimum CI runs:

1. candidate opens/migrates an N database;
2. previous supported N binary opens the migrated DB;
3. N performs representative **writes** against that migrated schema;
4. candidate N+1 reopens/validates those N-written rows;
5. daemon/renderer IPC overlap fixture;
6. renderer/private-WPE ABI smoke;
7. privileged helper protocol compatibility.

Automatic rollback remains armed only while the schema is backward **read/write** compatible with the rollback set.

Use expand/contract migrations:

- expand in a backward-compatible release;
- keep old columns/tables/semantics while rollback is possible;
- confirm/settle the new release;
- remove/contract old schema only in a later release after that rollback dependency is gone.

Do not perform an irreversible schema contraction and still promise automatic binary rollback.

### 30.3 Peer prefetch

### 30.3 Peer prefetch

When a signed release is available:

- signed release-set metadata may be `installation_peerable` when it contains no target-sensitive data;
- target-specific release artifacts use `target_granted` object authorization tied to the server deployment target;
- the soft release seeder may download authorized bytes once from origin;
- other targeted nodes fetch through the peer CDN only with the appropriate object grant;
- nodes may prefetch before their maintenance window;
- install does not begin until their persistent deployment state says it is authorized.

### 30.4 Release-set directory model

Prefer immutable component/release-set directories:

```text
/opt/tilecast-edge/releases/<component>/<version>/
/opt/tilecast-edge/sets/<release-set-id>/manifest.json
/opt/tilecast-edge/current-set -> sets/<id>/
/opt/tilecast-edge/previous-set -> sets/<id>/
```

The set manifest points only at verified immutable component directories.

Neither runtime user has arbitrary write access to `/opt/tilecast-edge`.

### 30.5 Privileged promotion/watchdog

A stable root-owned updater/watchdog supports only fixed typed operations such as:

```text
install_verified_artifact
install_verified_release_set
activate_release_set
request_confirmation
rollback_pending_release_set
```

It has its own conservative package/protocol version. Release metadata declares the minimum helper/watchdog protocol required; an app release cannot assume it may replace the privileged supervisor atomically with itself.

Staging verification is FD/inode-pinned with no-follow semantics and fixed install destinations.

### 30.6 Exclusive migration and activation

Before offline state-schema work:

1. stop current `tilecastd` and renderer;
2. acquire exclusive DB ownership/lock;
3. verify candidate release set and rollback set;
4. prove the migration is in the backward-read/write-compatible phase;
5. run the expand migration;
6. install/verify the complete release set;
7. write root-owned pending/previous/current-set metadata;
8. atomically switch `current-set`;
9. fsync parent directory;
10. start candidate daemon/renderer.

If a migration is truly online, it must be explicitly expand-only and understood by the running old binary.

Contract/irreversible cleanup is deferred until a later release after the automatic rollback window no longer depends on the older binary.

### 30.7 External confirmation and rollback

The candidate can **request** confirmation; it cannot unilaterally disarm rollback protection.

Root-owned pending metadata includes:

```text
pendingSetId
previousSetId
activationAttempt
maxUnconfirmedBootAttempts
confirmed=false
helperProtocol
```

On each boot/activation attempt, the stable watchdog increments/persists `activationAttempt` and arms a monotonic per-attempt deadline.

Power-cycling cannot reset the process forever: exceeding the bounded unconfirmed-attempt count rolls back immediately.

The stable watchdog confirms only after independently checking:

- candidate has remained alive for the minimum monotonic interval;
- daemon reports no fatal/safe/update error;
- state DB compatibility/health is valid;
- renderer-management path works;
- a built-in offline renderer smoke fixture succeeds.

The smoke fixture does not require assigned school content or active hours. It exercises trusted runtime creation plus a tiny local image and, when that renderer advertises video, a tiny decoder/video probe.

Alive-but-unhealthy candidate, crash loop, failed smoke, incompatible state or missed deadline rolls back the **entire release set**.

Rollback metadata lives outside candidate release directories and candidate SQLite schema.

### 30.8 WPE runtime dependency and packaging

Target the stable WPE WebKit **2.54.x** series initially, with an exact tested minimum patched build recorded in each release set. Do not treat arbitrary `>=2.54` development/future series as automatically qualified.

For general-purpose installations support either:

1. distribution/repository packages matching Tilecast's tested stable baseline; or
2. Tilecast-owned immutable private WPE runtime bundle in the signed release set.

Do not overwrite distro libraries or mix an older runtime with a launcher built for a different WPEPlatform ABI.

Mesa/GStreamer may remain distribution-owned initially, but report/test their supported ranges.

Track WPE/WebKit security advisories and raise the minimum accepted patched build through normal signed release-set rollout when a relevant security fix ships. Development snapshots are never production-qualified merely because their numeric version is newer.

As of this RFC date, Ubuntu's public package index does not provide the required WPE 2.54 package for Ubuntu 26.04, so Ubuntu support cannot rely on stock WPE alone.

A future Tilecast appliance image may make OS/runtime updates image-atomic.

---

## 31. Optional future Tilecast appliance image

This is not required to ship the Edge daemon, but the architecture intentionally supports it.

A controlled image can eventually contain:

```text
Linux
systemd
NetworkManager
Avahi
PipeWire/WirePlumber
linuxptp
Mesa/GStreamer
WPE WebKit
Tilecast Edge
```

That would let a user flash a device, boot, receive a pairing code and never configure a desktop environment.

For an appliance, evaluate A/B image systems such as RAUC or OSTree-based deployments. Do not create a home-grown full OS updater inside `tilecastd`.

The app-level Edge update mechanism above remains useful on ordinary Linux machines even if an appliance image later moves OS-managed installations to image-level updates.

---

## 32. Server package design

Add a focused server domain:

```text
apps/server/internal/edge/
```

Suggested files:

```text
authority.go          # online Edge signing-key transitions
certificates.go       # node issuance/generation/revocation
security.go           # security lineage/snapshot/credential overlay
recovery.go           # ERB + restore/re-anchor integration
streams.go            # signed stream append/read/prune/project
objects.go            # immutable object refs/sharing/grants
snapshots.go          # materialized projection/current-state snapshots
migration.go          # legacy->Edge migration session/fence
context.go            # definitions/rules/server values
status.go             # current node projection
settings.go           # installation Edge policy
```

HTTP handlers remain thin in `internal/httpapi`.

### 32.1 Database migrations

Add migrations, not edits to shipped migrations.

#### `edge_recovery_state`

```text
installation_id PK
trust_realm_id
active_state_incarnation_id
security_lineage_id
security_generation
security_head_digest
security_state_digest
authority_keyring_digest
active_authority_epoch
recovery_state
updated_at
```

The database row is not the external rollback witness. ERB/current security snapshot provides that role during managed restore.

#### `edge_security_node_state`

```text
player_installation_id PK
highest_issued_certificate_generation
minimum_accepted_certificate_generation
disabled_at
updated_at
```

#### `edge_security_credential_state`

```text
screen_id PK
authorization_generation
allowed_credential_ids UUID[]
updated_at
```

For an Edge-migrated screen, device authentication checks this overlay in addition to the existing `device_credentials` row.

#### `edge_node_certificates`

```text
id PK
player_installation_id
screen_id
trust_realm_id
certificate_generation
serial_number UNIQUE
public_key_fingerprint
certificate_pem
issued_at
not_before
not_after
revoked_at
revocation_reason
created_at
UNIQUE (player_installation_id, certificate_generation)
```

#### `edge_migration_sessions`

```text
id PK
screen_id
state_incarnation_id
legacy_credential_id
candidate_credential_id
legacy_version
candidate_release_set_id
state                  # staged/confirmed/aborted/expired
expires_at
created_at
confirmed_at
```

The staged migration state is the temporary server fence from §41. It is not a permanent player-owner lease system.

#### `edge_node_status`

```text
screen_id PK
trust_realm_id
security_lineage_id
security_generation
state_incarnation_id
edge_version
release_set_id
renderer_kind
renderer_version
renderer_profile_revision
mesh_state
peer_count
mesh_endpoints
cache_used_bytes
cache_limit_bytes
clock_source
clock_offset_ms
clock_uncertainty_ms
capability_revision
stream_cursors JSONB
last_edge_contact_at
last_mesh_change_at
last_error_code
updated_at
```

#### Signed streams/projection

Use §15's `history_kind/history_id/change_set_id` schema for:

- `edge_change_outbox`;
- `edge_stream_state`;
- `edge_stream_changes`;
- `edge_projection_state`.

The security stream history ID is `securityLineageId`; policy/screen history IDs are `stateIncarnationId`.

#### Object authorization

Server object metadata includes:

```text
edge_objects
edge_object_references
edge_object_grant_policy
```

Reference rows carry confidentiality class. Effective hash policy is computed conservatively across live references. Grant-policy rows carry bounded generation/lifetime state; signed grants themselves need not be stored forever.

#### Context/settings

Keep typed/bounded:

```text
edge_context_sources
edge_context_rules
edge_settings
```

### 32.2 Current status vs history

Keep current fleet state in projections. Store only meaningful incidents/transitions in Activity/audit. Do not turn node heartbeats/peer chatter into an unbounded history table.

## 33. Server API

## 33. Server API

Preserve the existing separation between dashboard APIs and player-authenticated APIs.

### 33.1 Player/Edge endpoints

Ordinary bearer-authenticated endpoints retain current Tilecast player semantics.

Edge trust-establishing endpoints from §10.1 require the secure HTTPS bootstrap channel.

Illustrative endpoints:

```text
GET  /api/v1/player/edge/migration/preflight
POST /api/v1/player/edge/migration/stage
POST /api/v1/player/edge/migration/confirm
POST /api/v1/player/edge/migration/abort

POST /api/v1/player/edge/enroll
POST /api/v1/player/edge/renew
GET  /api/v1/player/edge/security

GET  /api/v1/player/edge/streams/<stream-id>/changes
GET  /api/v1/player/edge/streams/<stream-id>/current
GET  /api/v1/player/edge/streams/<stream-id>/snapshot
GET  /api/v1/player/edge/objects/<sha256>

POST /api/v1/player/edge/status
POST /api/v1/player/edge/context/observations
POST /api/v1/player/edge/recovery/reanchor
```

Migration-stage/confirm/abort follow §41's credential/fence state machine.

The recovery re-anchor is available only in explicit recovery state over the secure bootstrap channel. It changes ordinary state incarnation but does not reset the security lineage.

Peer relay never calls trust-reset/re-anchor/migration credential endpoints.

### 33.2 Dashboard APIs

### 33.2 Dashboard APIs

Suggested administrative routes:

```text
GET   /api/v1/edge/overview
GET   /api/v1/edge/nodes
GET   /api/v1/edge/nodes/<screen-id>
POST  /api/v1/edge/nodes/<screen-id>/self-test
GET   /api/v1/edge/content
GET   /api/v1/edge/context
POST  /api/v1/edge/context/sources
PATCH /api/v1/edge/context/sources/<id>
POST  /api/v1/edge/context/rules
PATCH /api/v1/edge/context/rules/<id>
GET   /api/v1/edge/settings
PATCH /api/v1/edge/settings
```

Use existing role/screen-scope rules. Viewing operational status may be available to Viewer/Editor according to existing screen visibility; changing Edge/security/hardware policy should remain Owner/Administrator unless a specific capability is deliberately delegated.

### 33.3 Node status cadence

Do not create a second high-frequency heartbeat competing with the existing player status path.

Either:

- extend the existing heartbeat with a bounded `edge` object; or
- send a low-frequency `/player/edge/status` document that updates only Edge-specific current state.

Prefer whichever keeps current `lastContactAt` semantics unambiguous. An Edge optional-field decode error must not make an otherwise valid player's lifecycle contact disappear, matching the current heartbeat's defensive handling.

---

## 34. Edge status contract

Status is bounded current operational state.

Conceptual payload:

```json
{
  "trust": {
    "stateIncarnationId": "...",
    "trustRealmId": "...",
    "securityLineageId": "...",
    "securityGeneration": "28"
  },
  "edgeVersion": "1.4.0",
  "releaseSetId": "...",
  "mesh": {
    "state": "connected",
    "peerCount": 6,
    "lastPeerChangeAt": "...",
    "advertisedEndpoints": [
      {
        "transport": "tls/tcp",
        "address": "192.168.10.24",
        "port": 7447,
        "interface": "enp2s0"
      }
    ]
  },
  "streams": [
    {
      "streamId": "security/...",
      "lastAppliedSequence": "140",
      "lastAppliedDigest": "...",
      "highestVerifiedSequence": "140",
      "snapshotBaseSequence": "120"
    },
    {
      "streamId": "screen/...",
      "lastAppliedSequence": "81234",
      "lastAppliedDigest": "...",
      "highestVerifiedSequence": "81234",
      "snapshotBaseSequence": "80000"
    }
  ],
  "cache": {
    "usedBytes": "13812412342",
    "limitBytes": "17179869184"
  },
  "clock": {
    "source": "ptp",
    "state": "synchronized",
    "offsetMs": 0.42,
    "uncertaintyMs": 0.91
  },
  "renderer": {
    "kind": "wpe",
    "version": "1.0.0",
    "profileRevision": "3",
    "instance": "c4c7...",
    "state": "healthy",
    "recoveryReason": null
  },
  "capabilityRevision": "42"
}
```

Potentially 64-bit counters are decimal strings.

Do not send retry-sensitive naked byte deltas here. Use sequenced/idempotent telemetry or cumulative counters + boot epoch.

Validate endpoint count/private-address/interface/port before using status as seed hints.

## 35. Backward compatibility

The server must coexist during rollout with:

- existing Android players;
- existing Electron Linux players that have not yet been migrated;
- new Edge/WPE Linux players.

Electron compatibility ends at the host migration boundary. An Edge node never runs Electron as a renderer.

### 35.1 Server behavior

All new Edge fields/endpoints remain capability-gated.

A legacy Electron player continues receiving the existing manifest/config/socket protocol until that host is migrated. An Edge/WPE player advertises its Edge protocol/capability marker and uses the new Edge contracts.

The server does not require an all-at-once fleet cutover.

### 35.2 Legacy Linux host migration compatibility

The migration installer stops/disables the legacy service before Edge starts owner-sensitive work, imports state read-only, verifies server installation identity before using the imported bearer credential, enrolls the node directly from `tilecastd`, preserves legacy state/artifacts until post-install health succeeds and supports an explicit package-level rollback during the migration window.

Rollback is a controlled installer/release action, never an automatic renderer fallback.

### 35.3 Mixed display groups

Display-group synchronization must remain correct across legacy, Android and Edge/WPE members while migration is incomplete.

Edge consumes the same server-defined playback anchor and uses its improved Clock Authority locally. The group must not depend on every member being Edge-enabled.

### 35.4 Android future participation

Do not require Zenoh in Android v1. Later Android participation may use direct server state, server-assisted peer CDN discovery, or a compatible Zenoh implementation if operational/size constraints justify it.

## 36. Tilecast Studio: Rhea Edge surfaces

The canonical Studio design source is `docs/studio-rhea-redesign-plan.md`.

That redesign is being implemented separately from Tilecast Edge. Treat it as an upstream UI dependency, not work for the Edge implementation to duplicate. Runtime/server/Edge work may proceed independently, but broad Studio UI work should integrate only after the Rhea shell/components it needs have landed or are otherwise available on the integration branch.

**Spectrum 2 is abandoned for Tilecast Studio.** Do not add Spectrum packages, Spectrum components, Spectrum-specific composition, or a second Edge-specific component language.

### 36.1 Design-system rule

Edge UI uses the current Studio stack:

- shadcn/ui with the Base UI implementation;
- Rhea preset/theme selected by the canonical Studio plan;
- Geist/Lucide and existing project token choices from that plan;
- `dashboard-01` shell and the established inset/icon-collapsible Sidebar;
- feature-specific TanStack Data Tables where the plan calls for them;
- existing route/breadcrumb/command/activity patterns.

Use generated shadcn primitives. Do not recreate shadcn components in custom CSS.

### 36.2 Information architecture

The current Studio plan says the global sidebar contains only major product workspaces:

```text
Overview
Screens
Content
Presentations
Schedules
Plugins
Activity
Approvals (when available)
Settings
```

Edge is operational infrastructure, not a new permanent global product silo.

Place Edge surfaces as follows:

- **Overview**: fleet Edge health summary/attention when useful.
- **Screens → Fleet**: Edge-aware columns/filters.
- **Screen detail → Device/System**: authoritative node detail for one screen.
- **Activity**: Edge incidents/transitions.
- **Settings**: installation-wide Edge/network/cache/update policy.
- **Diagnostics route reachable from screen/detail or command palette**: deeper node/cache/mesh inspection for operators.

If later evidence shows a dedicated fleet-wide Edge workspace is necessary, add it by updating the canonical Rhea IA document first. This RFC does not independently create `Operations → Edge`.

### 36.3 Overview integration

Use compact existing Rhea overview composition for:

- Edge-enabled screens;
- nodes needing attention;
- peer/origin delivery health;
- renderer recovery/safe-mode count;
- certificate/update incidents.

Do not turn the entire Overview page into Edge infrastructure metrics.

### 36.4 Screens fleet integration

Use the feature-specific Screens Data Table.

Useful optional columns/filters:

```text
Edge state
renderer
peer count
cache
clock quality
Edge version
certificate/update attention
```

Status must use text/icon/accessibility semantics, not color alone.

### 36.5 Screen detail

Add Edge information to the existing screen-detail information architecture rather than duplicating a second full-screen node page.

Sections may include:

**Overview**

- Edge/renderer status;
- active state incarnation and per-stream lag/fork state;
- last server/peer contact;
- renderer recovery/safe-mode reason.

**Capabilities**

- WPE renderer capability profile;
- host capabilities;
- unsupported/blocked/degraded reasons.

**Network**

- mesh state;
- validated advertised endpoints;
- peer list/quality;
- Presentation Network status kept clearly separate.

**Content**

- active/prepared/draining presentation generations;
- cache use/pins;
- peer/origin delivery observations.

**Audio & Inputs**

- PipeWire/sensor capability state.

**System**

- Edge/renderer/runtime versions;
- certificate expiry/serial fingerprint summary;
- update/rollback state;
- clock source/uncertainty.

Do not show private keys, bearer credentials, Wi-Fi PSKs or integration secrets.

### 36.6 Settings

Place bounded installation-wide Edge configuration inside the canonical Settings navigation.

Examples:

- enable/disable mesh;
- enable/disable peer delivery;
- cache size/reserve;
- approved interfaces;
- manual static seeds;
- WPE display backend policy (`auto`, `drm`, `wayland`);
- sensor contribution policy;
- diagnostics verbosity.

Destructive actions use the canonical Alert Dialog pattern. Long-running mutations show Spinner/Progress according to the Rhea interaction plan.

### 36.7 Activity and incidents

Use existing Activity semantics/categories.

Useful events include certificate renewal/revocation, feed fork/re-anchor, loss of all peers, repeated integrity failure, WPE renderer recovery/safe mode, update rollback and time-untrusted transitions.

Do not record packet noise.

### 36.8 Empty/degraded states

Use the canonical shadcn Empty/Alert/Badge/Item patterns.

Examples:

- no Edge nodes;
- multicast unavailable but seed path healthy;
- peer delivery disabled;
- node certificate expiring;
- time untrusted;
- WPE unavailable, unsupported on this host, or blocked by a missing runtime/backend capability.

The UI describes backend-provided state. It does not infer distributed-system correctness in React.

## 37. Local administration: `tilecastctl`

Create a small CLI that talks only to the local Edge Unix socket.

Useful commands:

```text
tilecastctl status
tilecastctl peers
tilecastctl capabilities
tilecastctl cache status
tilecastctl cache verify <hash>
tilecastctl context get
tilecastctl clock
tilecastctl renderer status
tilecastctl self-test
tilecastctl diagnostics
```

No command executes arbitrary shell.

### 37.1 Output

Default human-readable output; `--json` emits a documented bounded JSON structure useful for support scripts.

### 37.2 Privilege

Read-only status commands may be allowed to members of the `tilecast-admin` group through `admin.sock`. Mutating/recovery commands require local privilege policy and still map to a fixed daemon operation.

The CLI never reads the device credential or node private key directly.

---

## 38. Observability

### 38.1 Logs

`tilecastd` writes structured logs to stderr/journald.

Fields:

```text
component
event
screen_id (when safe)
node_id suffix/full internal UUID
object hash suffix if needed
peer node ID
reason_code
duration_ms
bytes
```

Never log:

- player bearer credential;
- node private key;
- PSK;
- full Presentation Network provisioning response;
- dashboard session;
- arbitrary website URL/query string when current Tilecast policy excludes it;
- raw microphone data.

### 38.2 Metrics

Useful gauges/counters:

```text
mesh_peer_count
mesh_session_reconnects
peer_bytes_sent
peer_bytes_received
origin_bytes_received
peer_transfer_failures
peer_integrity_failures
peer_rate_limit_rejections
cache_bytes
cache_pinned_bytes
cache_evictions
stream_sequence_lag
feed_fork_incidents
context_live_values
context_stale_values
clock_offset_ms
clock_uncertainty_ms
renderer_restarts
renderer_safe_mode_entries
edge_uptime_seconds
```

Reuse Tilecast's existing sequenced/idempotent telemetry architecture for rollups and accumulated counters. Do not send retry-sensitive naked deltas in the Edge heartbeat/status route.

High-rate samples stay local/coalesced. The server's Prometheus-compatible fleet health exposes server-side aggregate metrics.

### 38.3 Activity

Activity records meaningful state transitions, not packet noise.

Good events:

```text
Edge joined fabric
Edge lost all peers for N minutes
WPE renderer entered recovery/safe mode
WPE renderer recovered
PTP authority lost/restored
Certificate renewal failed/recovered
Object hash failed verification
Update rolled back
Context source became stale/recovered
```

Bad events:

```text
received Zenoh packet
served each 64 KiB chunk
sensor sample every 100ms
cache lookup hit
```

### 38.4 Self-test

`tilecastctl self-test` and Studio's typed command should test independently:

```text
SQLite writable/checkpoint
CAS write/hash/read/delete
server identity/auth if reachable
Edge certificate validity
Zenoh session
peer query
peer HTTPS self-listener
clock provider
renderer IPC
renderer test presentation
CEC/DDC probe
NetworkManager helper status
Avahi status
PipeWire status
udev monitor
free-space reserve
systemd watchdog environment
```

Report `pass`, `warning`, `fail`, `not_applicable` per test. A missing optional PTP clock is not a failed self-test.

---

## 39. Security invariants

These are release-blocking invariants.

1. A LAN peer can never make another player accept unsigned authoritative state.
2. Every applied server Edge change verifies the Edge authority signature and installation ID.
3. Every peer connection uses mTLS after discovery; Zenoh's protocol whitelist prevents opportunistic plaintext sessions, and Tilecast cryptographically binds the resulting session to the claimed logical node identity.
4. The existing Tilecast device bearer credential is never sent to another peer.
5. Node private keys never leave their node.
6. Release-signing private keys remain outside Tilecast Server.
7. Edge dynamic authority/CA keys are separate from release-signing keys.
8. Every received content object is verified by size and SHA-256 before promotion/use.
9. Peer CDN has no arbitrary path or upload endpoint.
10. Renderer cannot call central player APIs with the device credential.
11. Remote website content never receives the native Tilecast bridge.
12. No Edge API accepts an arbitrary executable, shell fragment or filesystem path.
13. Privileged helpers validate every request independently and operate only in fixed namespaces.
14. Presentation Network remains non-default and isolated from Edge mesh traffic.
15. Raw microphone data remains local.
16. Context rules cannot perform I/O or mutations.
17. Sensor providers are typed and explicitly enabled; no generic device-file bridge.
18. An optional capability failure cannot brick normal playback.
19. Revoked certificate instances and disabled durable nodes are distinct; certificate replacement does not accidentally disable the renewed/rebound node.
20. Renderer/admin IPC authority is derived from separate sockets, filesystem permissions, `SO_PEERCRED`, daemon-recorded renderer process identity and protocol role; a renderer cannot self-declare an admin role.
21. WPE media access uses opaque daemon-issued capabilities bound to the launched renderer and prepared/active/draining presentation generation; the renderer never receives the CAS root and browser content never receives raw CAS authority.
22. A CA-valid peer cannot impersonate another node's logical identity/keyspace, and outbound peer trust is installation-CA-only.
23. Per-stream sequence/digest proves completeness inside one state incarnation; it never overrides a newer same-incarnation resource revision.
24. Snapshot recovery uses the materialized Edge projection at an exact signed stream checkpoint.
25. Trust realm/state incarnation can change only through the documented direct recovery path; the independent security lineage/generation cannot silently decrease and does not reset for ordinary restore.
26. Blob hash identity is not read authorization; target-granted content requires a valid server-signed grant.
27. Locally authored Context observations are signed, definition-bound, source-scoped, epoch-scoped and replay-protected.
28. Unknown security semantics fail closed/degrade mesh rather than silently advancing.
29. A malformed optional Edge heartbeat field cannot suppress ordinary player contact/status processing.

---

## 40. Data retention and privacy

### 40.1 Local

Retain:

- active/previous configuration;
- current, prepared and draining presentation bundles/generations;
- CAS objects according to policy;
- bounded per-stream signed history/checkpoints required for offline continuity;
- current context and explicit last-known-good candidates;
- command idempotency records for the required replay window;
- current update/renderer recovery state.

Do not retain indefinitely:

- high-rate sensor samples;
- raw audio;
- every peer presence change;
- every transfer chunk;
- full long-term telemetry.

### 40.2 Server

Current Edge status is a projection. History is only meaningful Activity/incidents and existing proof-of-play/audit data.

The server may retain Edge change envelopes for the bounded replay window, then rely on signed snapshots for very stale nodes.

### 40.3 Context privacy classification

Every context source has a classification:

```text
public_signage
operational
sensitive_not_allowed_on_player
```

Only `public_signage` and explicitly approved `operational` values may be projected to players/mesh. This prevents a future connected source from accidentally pushing sensitive records into every television's local database.

---

## 41. Migration strategy: one-time Electron → Edge/WPE cutover

The fleet does not require a flag-day server upgrade, but each Linux host performs one explicit runtime cutover. There is no long-lived Electron renderer inside Edge.

Stopping/disabling the legacy service is necessary but **not sufficient**: the preserved legacy state still contains a valid server bearer credential. Migration therefore has a bounded server-side migration fence and two-phase credential replacement.

### 41.1 Preflight before authority transfer

Before changing credentials:

1. install the candidate Edge/WPE release set without enabling it as the production owner;
2. run local WPE hardware/backend/media/browser self-tests;
3. inspect the legacy cached active manifest offline where possible;
4. stop the legacy Electron service before the candidate sends authenticated player traffic;
5. import the legacy state read-only;
6. verify the configured server installation identity before sending the imported bearer;
7. fetch a bounded server migration-preflight contract containing the current, prepared/pending, takeover, and configured near-horizon presentation requirements for this screen;
8. compare every required presentation against the exact installed WPE profile + host probes.

The near-horizon is bounded by the same scheduling/prefetch policy used for content preparation, with an explicit upper duration/entry count.

If any required presentation is incompatible, abort before credential replacement and restart the unchanged legacy service.

This catches real websites/layouts/plugins/codecs assigned to the screen. A generic WPE smoke fixture alone is not a migration gate.

### 41.2 Migration session and credential fence

After compatibility preflight passes, the server creates a short-lived migration session:

```text
migrationId
screenId
legacyCredentialId
candidateCredentialId
state = staged | confirmed | aborted | expired
expiresAt
legacyVersion
candidateReleaseSetId
```

The candidate credential is newly generated and returned once. The client fsyncs it into Edge protected identity storage before continuing.

While the migration session is `staged`:

- owner-sensitive player commands/update execution/status mutation are accepted only from the candidate credential;
- the legacy credential remains valid only for the bounded rollback/abort and minimum recovery/read paths defined by the migration protocol;
- normal legacy owner-sensitive work is fenced server-side;
- the old Electron process remains stopped locally.

This is a migration-specific fence, not a permanent dual-runtime owner-generation protocol.

If the candidate disappears and the migration expires before confirmation, the server revokes the candidate credential, removes the migration fence, and restores the legacy credential's normal authority so the installer/operator can restart the legacy player.

### 41.3 Actual WPE health before confirmation

With the candidate credential staged:

1. start `tilecastd` + WPE;
2. reconcile the current screen state from the server;
3. prepare and render the actual current presentation;
4. require meaningful playback/progress evidence, not only `renderer.ready`;
5. verify command/status/server reconnect behavior required for the migration gate;
6. keep the test running for a bounded settlement window.

Edge node mTLS enrollment may be deferred until migration confirmation so an aborted candidate does not create a long-lived mesh identity. If early enrollment is required for a test, its certificate is migration-scoped and revoked automatically on abort/expiry.

### 41.4 Confirmation is credential revocation

Migration confirmation is one atomic server transaction:

1. verify the migration session is still staged/unexpired;
2. verify the candidate credential authenticated the confirmation;
3. promote the candidate credential to the normal device credential;
4. revoke the legacy credential and every other superseded legacy credential for that screen;
5. mark the migration confirmed;
6. record the bounded migration audit marker.

A lost confirmation response is safe: the candidate already stores the new credential and can retry/authenticate with it; the old legacy copy is revoked.

After confirmation, manually starting the preserved Electron AppImage cannot authenticate with its old bearer.

Only after confirmation does `tilecastd` perform normal Edge node certificate enrollment and mesh participation.

### 41.5 Abort and rollback window

Before confirmation:

- stop Edge/WPE;
- call the migration abort path when server reachable;
- revoke the candidate credential/unfence the legacy credential;
- restart the unchanged legacy service/state;
- retain Edge diagnostics for investigation.

After confirmation, the ordinary legacy directory is stale and its bearer is revoked. Do **not** call this an offline Electron rollback path.

Post-confirmation recovery uses:

- Edge release-set rollback within the Edge architecture; or
- an explicit server-assisted legacy re-pair/recovery procedure that issues a new credential and re-synchronizes state before an intentionally supported emergency legacy package is started.

The supported automatic/installer migration rollback window therefore ends at credential confirmation.

### 41.6 Cache migration

Do not redownload current media unnecessarily.

During preflight/import:

- correlate recognized legacy entries with trusted manifest metadata;
- verify size + SHA-256;
- copy/promote verified files into CAS;
- do not modify/delete the legacy cache before confirmation.

After confirmation, legacy cache cleanup is a later maintenance step.

### 41.7 Commands, updates and restore safety

Removing long-lived dual runtime ownership does not weaken restore/replay safety.

Disruptive server work remains bound to the state-incarnation/authorization in which it was created. After rollback-style server recovery creates a new incarnation, restored old commands/update targets do not auto-execute until explicitly reconciled/reauthorized.

Migration sessions are also incarnation-bound. A server restore invalidates any staged migration unless the current security/recovery state explicitly reconstructs it.

Local command-idempotency records remain at least as long as the server may redeliver the command.

### 41.8 Installer/service mutual exclusion

The installer still makes accidental local dual execution difficult:

- legacy service stops before authenticated candidate work;
- Edge and legacy units use explicit `Conflicts=`/equivalent package policy where practical;
- installer uses a root-owned migration lock so two cutover attempts cannot run concurrently;
- Edge refuses migration confirmation while the legacy service/process is active;
- legacy restart before confirmation requires explicit abort/expiry;
- install/systemd tests cover crashes at each transition.

These controls supplement the server credential fence; they are not a substitute for it.

## 42. Implementation roadmap

## 42. Implementation roadmap

This roadmap is intentionally granular. Prefer a sequence of reviewable PRs over one enormous Edge branch.

The milestone numbers below are Edge milestones and do not replace Tilecast's existing historical product milestone numbering.

---

### E0 — Canonical RFC and protocol scaffolding

**Goal:** freeze trust/recovery/stream/wire semantics before runtime implementation.

### E0.1 Canonical documents

- this RFC;
- `docs/studio-rhea-redesign-plan.md`;
- architecture/terminology links.

### E0.2 Protocol package

Create `packages/edge-protocol/` with closed schemas/fixtures for:

```text
ipc-v1.schema.json
renderer-profile-v1.schema.json
presentation-requirements-v1.schema.json
node-message-v1.schema.json
context-observation-v1.schema.json
stream-record-v1.schema.json
current-state-v1.schema.json
snapshot-v1.schema.json
security-state-v1.schema.json
recovery-reanchor-v1.schema.json
authority-transition-v1.schema.json
object-grant-v1.schema.json
release-set-v1.schema.json
presentation-bundle-v1.schema.json
x509-profile/
cel/
```

The stream topology is already fixed by §15:

```text
security/<installation>
policy/<installation>
screen/<screen-id>
```

Do not freeze stream-record schemas while leaving stream partitioning/skipping as an E7 implementation choice.

Fixtures define:

- exact cryptographic domain prefixes;
- exact stream-digest preimage and genesis behavior;
- JCS canonicalization/signature exclusion;
- Base64url/no-padding digest/signature encoding;
- decimal-string large counters;
- duplicate-key/malformed-UTF-8 rejection;
- closed/unknown-field behavior;
- trust realm + state incarnation + security lineage coordinates;
- same-revision/different-state-digest fork behavior;
- subject tombstones;
- unknown schema/message safe degradation;
- per-renderer versioned capabilities;
- IPC min/max negotiation;
- renderer instance/process binding;
- exact CA/leaf X.509 profiles and CSR proof-of-possession;
- Context scalar/time/duration encoding and CEL cost limits.

### E0.3 Recovery/backup/migration model

State-machine fixtures cover:

- encrypted ERB creation/restore;
- restore with matching/newer ERB;
- restore without ERB → trust reset/re-enrollment;
- cross-installation restore trust quarantine;
- new state-incarnation prepare/activate crash points;
- security lineage rollback refusal;
- destructive local DB/checkpoint recovery;
- legacy/Edge service mutual exclusion, migration-session fencing, two-phase credential replacement and importer crash-point recovery;
- old pending command/update non-replay after restore;
- update release-set/schema rollback.

### E0 exit criteria

- Go/Rust/TypeScript/C fixtures agree where applicable;
- domain-crossing signature reuse fails;
- stream digest construction has one unambiguous preimage;
- signed counters above 2^53 round-trip exactly;
- same stream coordinate/different digest is a fork;
- same subject revision/different state digest is a fork;
- resource revisions are compared only inside one state incarnation;
- a peer cannot authorize trust-realm or state-incarnation change;
- unknown security semantics fail closed/degrade mesh safely;
- X.509/CSR negative fixtures fail;
- no implementation PR must invent stream/recovery semantics.

### E1 — Rust workspace and daemon skeleton

**Goal:** a packaged, supervised, unprivileged daemon skeleton before server/legacy-state ownership is enabled.

### E1.1 Workspace

Add `apps/edge/Cargo.toml` and crates.

Core dependencies should be narrowly chosen and locked with `Cargo.lock`. Candidate families researched for this design include:

- `tokio` for async runtime;
- `zenoh` for fabric (not necessarily enabled until E5);
- `rusqlite` with bundled SQLite;
- `serde`/`serde_json`;
- `rustls` ecosystem for TLS;
- `axum` or similarly small HTTP server for peer blobs;
- `zbus` for D-Bus;
- `udev` for device monitoring;
- PipeWire Rust bindings when E9 begins;
- `tracing`/structured JSON output;
- an sd-notify crate or minimal native notify implementation.

Dependency versions belong in Cargo files, not this architecture contract; pin a tested lockfile and use dependency automation/security review.

### E1.2 State DB

Implement:

- schema migration mechanism;
- WAL/foreign keys/busy timeout;
- crash-safe schema upgrade;
- state DB integrity/open failure behavior;
- filesystem creation via systemd-managed directories.

### E1.3 systemd service

Ship installer assets for:

```text
tilecast-edge.service
```

Daemon skeleton only; it does not yet use the legacy bearer credential or perform owner-sensitive server work.

Implement:

- `Type=notify` readiness;
- watchdog;
- clean SIGTERM shutdown;
- bounded shutdown timeout;
- structured journald logs;
- `tilecastctl status`.

### E1.4 CI

Add a workflow that runs:

```text
cargo fmt --check
cargo clippy --all-targets --all-features -D warnings
cargo test --workspace
cargo build --release --workspace
```

### E1 exit criteria

- daemon survives 1,000 restart cycles without corrupting DB;
- systemd watchdog kills a deliberately wedged daemon and it restarts;
- no root runtime requirement;
- idle RSS target established and documented;
- `tilecastctl status` works through AF_UNIX.

---

### E2 — Local IPC and first WPE vertical slice

**Goal:** establish the final daemon/WPE boundary immediately rather than building an Electron compatibility adapter.

### E2.1 IPC implementation

Implement bounded framing, min/max negotiation, renderer-instance generation, `SO_PEERCRED` + daemon-recorded process identity, backpressure, reconnect/resubscribe semantics and malformed/stale-client rejection.

### E2.2 Minimal WPEPlatform launcher

Build the real C/GLib WPEPlatform launcher now and prove headless startup, status/setup rendering, renderer readiness, daemon restart/reconnect, renderer crash/recreation and meaningful evidence accepted by the daemon.

### E2.3 Daemon-backed media capability qualification

Implement `tcmedia://cap/<opaque-capability>` plus the custom GStreamer URI source required for WPE video.

The source uses an inherited/connected daemon media channel; it never receives the CAS root.

Tests prove:

- raw SHA-256 knowledge is insufficient to read media;
- stale renderer/presentation capabilities fail;
- seek/range works through the daemon channel;
- image/H.264/widget/layout playback and meaningful progress work under real WPE WebKit;
- arbitrary remote website content cannot turn a guessed hash into a media read.

### E2 exit criteria

### E2 exit criteria

- WPE is the only Edge renderer in code/docs;
- no Electron Edge IPC/client is created;
- headless recovery/media scenarios pass;
- malformed/stale renderer traffic is rejected;
- renderer crash does not take down daemon/server/Edge state;
- production core dumps are bounded/disabled by service policy.

---

### E3 — Edge identity, central server client and fenced legacy cutover

**Goal:** make `tilecastd` the complete Linux owner only after the exact host/content set proves WPE-ready and the legacy bearer is revoked safely.

### E3.1 Port server client logic

Port installation identity verification, URL policy, pairing, REST, WebSocket, liveness/backoff and current server protocol semantics.

### E3.2 Preflight/import

Implement §41 local WPE qualification, bounded current/prepared/takeover/near-horizon compatibility check, and read-only importer.

No credential rotation occurs if required content is incompatible.

### E3.3 Migration session + credential replacement

Implement the staged candidate credential and server-side migration fence.

Crash tests cover:

- candidate credential returned before local fsync;
- local fsync before server confirmation;
- candidate crash/expiry;
- abort response loss;
- confirmation commit before response loss;
- manually started stale Electron during staged migration;
- manually started Electron after confirmation.

### E3.4 Actual current-presentation gate

Before confirmation, WPE renders the actual current presentation and reports meaningful progress for the settlement window.

### E3.5 Edge node enrollment

After credential confirmation, generate the node key/CSR and enroll the Edge identity using the new normal device credential.

### E3.6 Durable commands

Every command has an explicit execution class. Retention is tied to server redelivery/state-incarnation semantics.

### E3 exit criteria

- incompatible active/pending/near-horizon content leaves Electron untouched;
- there is never an unbounded period with two fully authoritative credentials;
- staged migration fences legacy owner-sensitive actions;
- candidate disappearance expires safely back to legacy authority;
- confirmation revokes the preserved legacy bearer;
- stale Electron cannot authenticate after confirmation;
- confirmation-response loss is recoverable;
- disruptive commands do not double-initiate;
- offline cached startup works in WPE;
- post-confirmation recovery uses Edge rollback or explicit server-assisted legacy recovery, not stale local Electron state.

### E4 — CAS migration and origin downloader

### E4 — CAS migration and origin downloader

**Goal:** replace legacy cache ownership with the final content-addressed store before adding peers.

### E4.1 CAS

Implement:

- SHA path validation;
- partial files;
- range resume;
- size/hash verification;
- fsync and atomic promotion;
- pinning leases;
- LRU metadata;
- reserved free-space enforcement;
- bounded concurrency;
- scrubber.

### E4.2 Legacy cache importer

Migrate existing verified assets without a forced redownload.

### E4.3 Manifest integration

Presentation preparation references CAS object handles, never arbitrary file paths.

### E4 exit criteria

- all active content survives migration offline;
- corrupt same-size file is detected;
- power-cut simulation at each promotion stage never exposes partial bytes as complete;
- disk-full preserves previous active presentation;
- cache eviction cannot remove active/pending pinned content.

---

### E5 — Edge certificate authority, security clock and Zenoh mesh

**Goal:** establish authenticated peer sessions without relying on LAN trust, public WebPKI, unsafe clocks or client-selected identity.

### E5.1 Server trust/recovery authority

Implement:

- Edge trust realm;
- exact Edge CA + authority-key profiles;
- encrypted Edge Recovery Bundle;
- security lineage/checkpoint;
- authority transition chain;
- state-incarnation prepare/activate recovery metadata;
- backup/restore and cross-installation trust-reset integration.

The server must be unable to reopen mesh/certificate issuance with security history older than its recovered externally trusted checkpoint.

### E5.2 Node enrollment

Implement:

- local Ed25519 generation;
- CSR proof-of-possession;
- server-derived certificate identity fields;
- enrollment/renewal rate limits;
- bounded overlapping active certs;
- versioned atomic identity generations;
- renewal/rebinding;
- lifecycle integration with screen/device repair/replacement;
- trust-realm reset/re-enrollment path.

### E5.3 Security clock minimum

Before opening mesh links implement:

- persisted trusted-time lower bound;
- uncertainty;
- bounded server-offset measurements;
- host time-sync state;
- certificate-validity decision;
- `time_untrusted`.

E10 later adds richer provider selection/PTP. It is not the first implementation of certificate-time policy.

### E5.4 Zenoh

- peer mode;
- TLS-only transport;
- installation/trust-realm CA-only verifier;
- mTLS credentials;
- TLS resumption disabled for v1;
- 0-RTT/early application data disabled;
- logical-node binding;
- identity-safe liveliness;
- fixed security/policy/screen namespace;
- Presentation Network interface withdrawal closes existing forbidden-interface sessions;
- coarse/static ACL defense-in-depth only where supported.

### E5.5 Admin visibility

Expose bounded mesh/security/time state.

### E5 exit criteria

- unauthorized, wrong-installation and public-WebPKI-only peers fail;
- wrong EKU/purpose/node certificate fails;
- one node cannot claim another node's keyspace or liveliness;
- certificate-instance revocation does not disable a replacement certificate for the same node;
- disabled node rejects all certificate instances;
- active revoked sessions stop accepting data;
- bad/uncertain host time follows the tested security-clock policy;
- Presentation Network does not attract mesh traffic;
- trust realm/state incarnation cannot change through peer gossip;
- TLS resumption/0-RTT behavior matches the v1 disabled policy;
- Presentation Network activation closes already-established sessions on newly forbidden interfaces.

### E6 — Peer CDN

**Goal:** fetch verified immutable bytes from peers without turning peer advertisements into arbitrary network access or allowing one node to monopolize the service.

### E6.1 Peer HTTPS server

- installation mTLS;
- fixed/bounded listener port;
- single Range;
- canonical `ETag: "sha256:<hash>"`;
- per-peer fairness/rate limits.

### E6.2 Object query

Authenticated availability replies include node ID/certificate instance, hash/size, validated interface endpoint and bounded load.

### E6.3 Source selector

- per-hash single-flight;
- local → ranked peers → origin;
- exact Range/`Content-Range` validation;
- same canonical ETag across origin/peer;
- endpoint allowlist/private-interface validation;
- redirects/proxy inheritance disabled.

### E6.4 CAS ownership

Use blob/reference/pin tables. Pins support independent owners and `prepared → active → draining → retired` generations.

### E6.5 Metrics

Use sequenced/idempotent telemetry, not retry-sensitive heartbeat deltas.

### E6 exit criteria

- cross-source resume works only with valid canonical range response;
- concurrent same-hash consumers share one transfer;
- wrong advertised node certificate fails;
- peer cannot make another node connect to arbitrary host/port;
- one peer cannot occupy all transfer/handshake/query capacity;
- malicious/corrupt bytes never enter CAS;
- releasing one pin owner cannot evict an object still pinned elsewhere;
- disabling peer CDN immediately returns to origin.

### E7 — Signed streams, materialized Edge projection and immutable objects

**Goal:** implement the fixed security/policy/per-screen stream model with recoverable snapshots and fork detection.

### E7.1 Outbox/object compilation

Domain transactions capture exact subject revision/tombstone and pin any immutable source publication.

Object compiler builds the exact captured revision. Failed rows have bounded retry/error/supersession state rather than permanent silent pins.

### E7.2 Stream projector

For each fixed `streamId`:

- update stream chain and materialized projection in one transaction;
- use exact §15 digest/signature/domain algorithm;
- store same-subject `stateDigest`;
- reject equivocation/fork.

### E7.3 Current state/security

Implement independently retrievable signed current-state documents.

Security stream includes `securityLineageId + securityGeneration` and may advance without waiting for policy/screen stream gaps.

### E7.4 Snapshots

Generate per-stream snapshots from `edge_projection_state`, not arbitrary authoritative tables.

This guarantees the snapshot contains only mutations whose Edge object/stream representation is complete.

### E7.5 Recovery

Fixture:

```text
nodes trust realm R, incarnation A
screen stream at seq 1000
server restores DB from older state
matching/newer ERB proves security lineage S/generation G
server prepares incarnation B + all initial projections/checkpoints
server durably marks B active
direct server re-anchor moves node A -> B
resource revisions restart inside B
peer alone cannot move A -> B
```

Also test restore without usable ERB: Edge enters security-recovery-required/trust-reset path rather than publishing older revocations.

### E7 exit criteria

- domain-separated signatures cannot be replayed across document kinds;
- exact stream digest fixtures agree cross-language;
- gaps/forks are detected per stream;
- same revision/different state digest is a fork;
- stale subject is a no-op;
- tombstone converges removal;
- security advances independently of screen/policy gaps;
- snapshot never contains an unprojected async mutation;
- current-state bootstrap after local trust loss requires direct server;
- obsolete failed object compile can be superseded without leaking a permanent pin;
- security, policy and one screen stream remain bounded in fleet-scale benchmark.

### E8 — Context Engine and CEL

**Goal:** shared typed context works online/offline and across peers.

### E8.1 Server schema/API

Implement context source definitions, values and rules.

### E8.2 Local store/merge

Implement scope/priority/revision/freshness with golden fixtures.

Local observations use `sourceEpoch` + decimal-string `sourceSequence`.

Tests prove:

- new source epoch supersedes old incarnation;
- sequences are not compared across epochs;
- old replay state is retained until the old observation acceptance window is impossible;
- sender-provided expiry cannot exceed source maximum TTL;
- stale/compromised source cannot extend freshness with a future timestamp.

### E8.3 CEL

- server `cel-go` validation;
- Rust evaluator compatibility wrapper;
- fixture/differential suite;
- rule cache compiled once and reevaluated on dependent context changes/time boundaries.

### E8.4 Presentation integration

Add context rule references to immutable published presentation revisions/bundles.

Do not let editing a rule retroactively mutate an already-approved publication unless the product explicitly defines it as a live organization policy.

### E8.5 Sources

Ship at least:

- manual server value;
- bell/time-based derived source;
- calendar/event source adapter;
- existing weather prepared-value mapping;
- local test/sensor source.

### E8 exit criteria

- same CEL fixtures pass Go and Rust;
- stale/expired value behavior survives server outage;
- conflicting source precedence is deterministic across nodes;
- peer cannot spoof a server-only context key;
- context update does not require a full manifest download when published presentation already contains its rule.

---

### E9 — Linux-native platform providers

**Goal:** move host integration behind Edge capability providers.

Break this milestone into separate PRs; providers are independent.

### E9.1 Avahi

- server browsing/publishing via D-Bus;
- `_tilecast-edge._tcp` service;
- graceful no-Avahi path.

### E9.2 Presentation Network client migration

- current helper protocol from Edge;
- port the current legacy Presentation Network client behavior into the Edge provider;
- exact existing security semantics.

### E9.3 Display Control

- CEC/DDC probe/actions;
- permission-state diagnostics;
- existing schedules/commands call Edge provider.

### E9.4 udev/capability registry

- hotplug monitor;
- adapter framework;
- ambient light + hwmon + explicitly mapped evdev/HID first.

### E9.5 PipeWire

- enumerate stable outputs/inputs;
- local Noise Meter path;
- no raw sample egress;
- session unavailable state.

### E9 exit criteria

Every provider can be absent/broken independently while ordinary playback continues. Capability state explains the limitation accurately.

---

### E10 — Full Clock Authority and PTP reporting

**Goal:** extend the E5 security clock into the complete playback/schedule clock-quality model.

### E10.1 Provider selection

Add full wall-clock provider scoring/uncertainty on top of the E5 trusted-time floor.

### E10.2 Host sync inspection

Integrate chrony/systemd-timesyncd or equivalent state.

### E10.3 PTP

Detect/report optional PTP source without taking over network configuration in v1.

### E10.4 Playback/schedule integration

Preserve server-corrected schedule semantics and monotonic active playback.

### E10.5 UI/API

Expose source, quality, offset, uncertainty and transitions through the Rhea screen/system surfaces.

### E10 exit criteria

- E5 certificate-time safety remains unchanged;
- PTP loss falls back to a healthy next provider;
- wall-clock jumps reevaluate schedules without rewinding active playback;
- mixed legacy/Edge synchronized playback preserves existing server anchors.

### E11 — Edge-managed updates and peer release seeding

**Goal:** install signed releases with protocol/ABI/schema compatibility and a rollback mechanism that works even when the candidate daemon stays alive but unhealthy.

### E11.1 Release workflows

Publish signed Edge, renderer and private-WPE-runtime artifacts with compatibility metadata.

### E11.2 Server update domain

Reuse canary/maintenance/pause/cancel/retry/settlement semantics.

### E11.3 Peer delivery

Peer CDN can provide bytes only; deployment authorization remains server-owned.

### E11.4 Atomic install/rollback

Implement:

- no-follow FD-pinned staging verification;
- immutable release dirs;
- parent-directory fsync after symlink promotion;
- root-owned rollback metadata;
- external confirmation deadline;
- state-schema backward-readable gate;
- daemon/renderer IPC compatibility gate;
- renderer/private-WPE-runtime ABI gate.

### E11 exit criteria

- candidate crash rolls back;
- candidate `READY=1` but never healthy rolls back after external deadline;
- previous binary can open resulting state before rollback is permitted;
- incompatible schema/IPC/WPE ABI release is rejected before activation;
- rollback mechanism does not depend on candidate release or candidate DB schema;
- update settlement still works for deliberate sleep/no-content state.

### E12 — WPE website/security parity

**Goal:** finish the hardest WebKit content surface without weakening Tilecast's trust boundary.

Prove navigation policy, post-DNS destination policy, permissions, data isolation/quotas, clearing/reload/timeout, subprocess crash recovery, remote-origin denial for Tilecast trusted schemes/native bridge, layout website zones and YouTube behavior.

### E12 exit criteria

Every supported website/YouTube requirement has an exact WPE capability/version contract. Unsupported requirements report incompatibility; there is no alternate renderer.

---

### E13 — WPE Wayland qualification

**Goal:** support a deliberate compositor/session deployment for development and installations that cannot use direct DRM/KMS.

Validate managed session startup, display access, renderer restart, preview and media acceleration. Do not depend on an ambient desktop login.

### E13 exit criteria

- 24-hour soak;
- restart reliably reclaims the view;
- required display/media/session handles are bounded;
- no Electron package/runtime is required.

---

### E14 — WPE DRM/KMS production path

**Goal:** qualify compositorless WPE as the preferred dedicated-signage mode.

Hardware matrix includes old Intel/Ivy Bridge, modern Intel, representative AMD/Mesa and one ARM target when packages exist.

Verify direct WPE DRM boot, connector/modes/hotplug, display sleep/active hours, CEC/DDC coexistence, preview, crash/restart reclaim, H.264 VA-API/GStreamer on the reference hardware and low-end memory/CPU stability.

### E14 exit criteria

- 72-hour DRM soak;
- no progressive memory growth outside bounds;
- repeated crash/restart reclaims display;
- decode performance meets target;
- no compositor or Electron dependency on dedicated hosts.

### E15 — Rhea Edge administration integration

This work follows the separately implemented `docs/studio-rhea-redesign-plan.md`; it does not create a second Studio shell or global Edge silo.

The Studio redesign agent/workstream owns the product-wide shell, generated shadcn Base UI/Rhea component layer, navigation composition and broad page migration. E15 owns only the Edge-specific data and workflows that plug into those established surfaces. If the Rhea implementation is still in flight, keep Edge UI work limited to backend/API/types/tests or an isolated integration branch rather than recreating temporary UI that will immediately be replaced.

### E15.1 API/types

Add Edge fields/routes to existing screen, settings, overview and activity surfaces.

### E15.2 Screens/detail integration

Add optional fleet columns/filters and Device/System sections for Edge status.

### E15.3 Settings/activity

Add bounded Edge policy under Settings and Edge incident categories under Activity.

### E15.4 Accessibility

Use canonical shadcn/Rhea semantics: text/icon status, keyboard access, no hover-only actions, no color-only state, reduced motion.

### E15 exit criteria

- no Spectrum dependency, import, component or composition is reintroduced;
- Edge UI is built on the landed/integration-ready Rhea implementation rather than the pre-redesign shell;
- no second sidebar/shell is created;
- canonical generated shadcn Base UI + Rhea components/interaction rules are used;
- Playwright/accessibility tests cover core operational flows;
- UI shows backend-provided real metrics/state only.

### E16 — Partition resilience and coordinator roles

**Goal:** prove Edge remains useful when infrastructure fails.

Implement/enable soft roles only after basic mesh/CDN/signed-stream behavior is stable.

Scenarios:

- server unreachable, LAN healthy;
- WAN unreachable, self-hosted server still healthy;
- multicast unavailable;
- one half of LAN partitioned;
- partition heals;
- seed/coordinator node dies;
- multiple soft coordinators appear during partition.

### E16 exit criteria

- playback never requires elected coordinator;
- peers continue serving cached content;
- Context Engine continues with documented cached/local sources;
- duplicate soft coordinators cause no authority conflict;
- sequence reconciliation after heal converges deterministically.

---

### E17 — WPE production rollout

**Goal:** roll out the only Edge Linux renderer across the supported hardware matrix.

Collect normalized playback-time/fleet metrics for WPE sessions, restarts, incidents, memory, decode and website failures.

### E17 exit criteria

- no material measured reliability regression;
- presentation incompatibilities are explicit and understood;
- Wayland/DRM host constraints are explicit;
- release rollback path is tested;
- all supported current Linux content requirements are implemented in WPE or deliberately dropped.

### E18 — Legacy Electron source cleanup

Electron is already absent from Edge runtime releases. This milestone removes temporary repository/reference baggage once the WPE port and legacy migration path are stable.

Removal work:

- delete superseded Electron runtime/network/rendering source;
- remove Chromium/Electron packaging/release workflows;
- keep only fixtures needed to preserve historical behavior;
- keep the state importer as long as supported upgrades can originate from the last Electron release.

This is source/package cleanup, not a renderer cutover.

### E19 — Optional Tilecast appliance image

After Edge/WPE are stable, produce a separately scoped appliance project.

Goals:

- x86_64 first;
- ARM image when hardware target is clear;
- WPE/Mesa/GStreamer versions controlled by image;
- systemd services preconfigured;
- no desktop environment;
- first boot shows Tilecast pairing;
- A/B/atomic OS updater using a standard embedded Linux mechanism;
- serial/recovery path documented.

Do not block Edge-on-Ubuntu/Debian adoption on this milestone.

---

## 43. Recommended PR sequence

The milestones above are architectural gates. This section translates them into review-sized pull requests. Exact numbering will change as implementation reveals dependencies, but the order should remain close to this.

### Foundation PRs

### PR 1 — `docs(edge): add canonical Tilecast Edge architecture`

- this document;
- architecture boundary update;
- terminology (`Tilecast Edge`, `tilecastd`, Edge node, fabric, peerable object).

No behavior change.

### PR 2 — `feat(edge-protocol): add v1 schemas and golden fixtures`

- IPC min/max protocol envelopes;
- renderer profiles and presentation requirements;
- canonical stream/current-state/security/snapshot/recovery-reanchor/object-grant envelopes;
- X.509 profile fixtures;
- presentation-bundle skeleton;
- CEL fixture harness skeleton;
- malformed JSON/duplicate-key/encoding fixtures.

Go + TypeScript fixture validators first; Rust joins in PR 3.

### PR 3 — `build(edge): add Rust workspace and CI`

- Cargo workspace;
- formatting/lint/test workflow;
- license metadata;
- release profile;
- dependency-policy documentation.

### PR 4 — `feat(edge): add SQLite state store and migrations`

- WAL;
- schema migrator;
- power-cut/reopen tests;
- temporary integration harness.

### PR 5 — `feat(edge): add systemd service, watchdog and tilecastctl`

- shadow daemon;
- sd-notify;
- local status;
- installation docs;
- hardened unit initial pass.

### WPE foundation and migration PRs

### PR 6 — `feat(renderer-wpe): add WPEPlatform launcher and renderer IPC`

Real C/GLib WPEPlatform launcher, headless status surface, daemon restart/reconnect, renderer crash recovery and renderer process binding.

### PR 7 — `feat(renderer-wpe): add daemon-backed tcmedia capability source`

Opaque generation-bound media capabilities, inherited/connected daemon media channel, no renderer CAS-root access, seek/range behavior and H.264 progress evidence. Remote website fixtures must not read media by knowing a CAS hash.

### PR 8 — `test(renderer-wpe): add headless recovery and mixed-content harness`

Status, daemon restart, renderer crash, and mixed image/video/widget/layout scenarios run on real WPE.

### PR 9 — `feat(edge-server): port server identity and URL policy`

### PR 10 — `feat(edge-server): implement pairing/enrollment and REST/WebSocket client`

### PR 11 — `feat(edge-migration): add WPE preflight, importer and migration credential fence`

### PR 12 — `feat(edge-migration): confirm credential cutover then enroll Edge node`

### PR 13 — `feat(edge-state): add command execution classes and durable idempotency`

### PR 14 — `feat(edge-state): port config and manifest reconciliation`

### PR 15 — `test(edge-migration): add crash-point and explicit rollback coverage`

### PR 16 — `build(player-linux): stop shipping Electron in new Edge releases`

Keep legacy source/fixtures only while needed for migration/reference.

### CAS PRs

### PR 17 — `feat(edge-cas): add verified blobs, references and multi-owner pins`

### PR 18 — `feat(edge-cas): add resumable origin downloads and pinning`

### PR 19 — `feat(edge-cas): migrate legacy Linux media cache`

### PR 20 — `feat(edge-cas): add eviction, reserve and scrubber`

After PR 20, the disk model should already be final enough for CDN work.

### Identity/mesh PRs

### PR 21 — `feat(server-edge): add trust realm, Edge CA/authority keys and encrypted recovery bundle`

Security review required. Integrate backup/restore and trust-reset behavior before issuing production Edge certificates.

### PR 22 — `feat(server-edge): add PoP node certificate enrollment/renewal`

### PR 23 — `feat(edge-identity): enroll and rotate node certificate`

- exact X.509 profile/golden fixtures;
- versioned atomic identity generations;
- certificate-instance serial/fingerprint revocation;
- durable node disablement kept separate from certificate replacement;
- minimum trusted-time/certificate-validity module needed before mesh.

### PR 24 — `feat(edge-mesh): add mTLS Zenoh peer session`

No app data beyond identity-safe presence. Installation-CA-only outbound trust, security-clock policy and authenticated node binding are mandatory before merge.

### PR 25 — `feat(edge-mesh): add liveliness and node summaries`

### PR 26 — `feat(edge-mesh): add seed fallback and interface/session withdrawal policy`

### PR 27 — `feat(server-edge): add revocation propagation`

### CDN PRs

### PR 28 — `feat(edge-cdn): serve peerable CAS objects over mTLS`

### PR 29 — `feat(edge-cdn): add Zenoh object availability query`

### PR 30 — `feat(edge-cdn): add peer-first source selector`

### PR 31 — `feat(edge-cdn): add transfer scoring, metrics and integrity incident inputs`

### Signed stream/projection PRs

### PR 32 — `feat(server-edge): add fixed signed Edge streams and projection`

- security/policy/per-screen stream tables;
- captured subject revisions/tombstones;
- object-ready/source-retention gating;
- materialized Edge projection;
- exact previous/stream digest chain;
- domain-separated signing;
- same-revision state digest;
- decimal-string signed counters;
- independently versioned security state.

### PR 33 — `feat(server-edge): compile immutable presentation bundles`

Compile the exact outbox-captured immutable revision before its feed row can be signed.

### PR 34 — `feat(edge-sync): apply signed streams/current-state and peer relay`

Track per-stream continuity separately from per-resource revision watermarks and trust coordinates.

### PR 35 — `feat(edge-sync): add gap/fork recovery, projection snapshots and re-anchor`

Add per-stream projection snapshots, trust/security checkpoints, destructive-local-state bootstrap rules and direct server state-incarnation re-anchor.

### PR 36 — `perf(edge-sync): add soft content/change seeder role`

This is optimization; do not merge before feed correctness is proven without it.

### Context PRs

### PR 37 — `feat(server-edge): add typed Context sources and values`

### PR 38 — `feat(edge-context): add local context merge/freshness engine`

### PR 39 — `feat(server-edge): validate context rules with CEL`

### PR 40 — `feat(edge-context): add Rust CEL subset and differential suite`

### PR 41 — `feat(player): evaluate context presentation conditions offline`

### PR 42 — `feat(edge-context): add manual, bell and local sensor fixture sources`

### Platform PRs

### PR 43 — `feat(edge-platform): replace JS Bonjour with Avahi D-Bus`

### PR 44 — `refactor(edge-platform): own Presentation Network helper client`

### PR 45 — `refactor(edge-platform): own Linux CEC/DDC display control`

### PR 46 — `feat(edge-platform): add capability registry and udev hotplug`

### PR 47 — `feat(edge-platform): add ambient-light/hwmon providers`

### PR 48 — `feat(edge-audio): add PipeWire inventory provider`

### PR 49 — `feat(edge-audio): move Noise Meter to local PipeWire capture`

### PR 50 — `feat(edge-clock): complete Clock Authority provider selection`

Build on the minimum trusted-time/certificate policy already required by PR 23/24.

### PR 51 — `feat(edge-clock): add PTP detection/reporting`

### Updates PRs

### PR 52 — `build(edge): publish signed Edge release artifacts`

### PR 53 — `feat(server-updates): support Edge component deployments`

### PR 54 — `feat(edge-update): fetch releases through CAS/peer CDN`

### PR 55 — `feat(edge-update): add atomic release-set activation and stable rollback watchdog`

### Advanced WPE qualification PRs

### PR 56 — `feat(renderer-wpe): harden trusted runtime/native bridge`

### PR 57 — `feat(renderer-wpe): complete image/video/widget/layout parity`

### PR 58 — `feat(renderer-wpe): add Wayland qualified host mode`

### PR 59 — `feat(renderer-wpe): harden website networking/permissions/storage`

### PR 60 — `feat(renderer-wpe): add website layout and YouTube parity`

### PR 61 — `feat(renderer-wpe): qualify DRM/KMS on reference hardware`

### PR 62 — `perf(renderer-wpe): add Ivy Bridge H.264/resource soak gates`

### PR 63 — `test(renderer-wpe): add trusted-scheme/CAS escape adversarial suite`

### PR 64 — `build(renderer-wpe): finalize signed WPE runtime/ABI packaging`

### Rhea Studio integration PRs

These are an integration workstream, not a second Studio redesign. A separate agent/workstream is implementing `docs/studio-rhea-redesign-plan.md`. Start the Edge Studio PRs only after the Rhea shell/components they depend on have landed or are available on the shared integration branch, then rebase/adapt Edge work to that implementation. Do not build Edge screens against the pre-Rhea shell as temporary production UI.

### PR 65 — `feat(studio-edge): add Edge data to Overview/Screens clients`

### PR 66 — `feat(studio-edge): add Rhea Screens Edge columns and filters`

### PR 67 — `feat(studio-edge): add screen Device/System Edge detail`

### PR 68 — `feat(studio-edge): add content-delivery diagnostics surface`

### PR 69 — `feat(studio-edge): add Context value/rule UI`

### PR 70 — `feat(studio-edge): add Edge settings`

### PR 71 — `feat(activity): integrate Edge events/incidents`

No PR in this group reintroduces Spectrum, installs Spectrum dependencies, recreates the global Studio shell, or forks a second Edge-specific sidebar/component system.

### Final rollout PRs

### PR 72 — `test(edge): add network-partition/failure-injection suite`

### PR 73 — `perf(edge): add benchmark and low-end resource gates`

### PR 74 — `feat(renderer-wpe): make qualified DRM/KMS the dedicated-host default`

### PR 75+ — parity gaps and field fixes

### Final cleanup PR — `refactor(player-linux): remove legacy Electron source/package workflow`

This removes reference/legacy packaging only. Electron is already absent from Edge runtime releases.

---

## 44. Test architecture

Testing a distributed player on only unit tests will produce a system that looks correct until the first real network outage. Edge needs deterministic multi-process tests from the beginning.

### 44.1 Rust unit tests

Every crate should have pure tests for policy logic:

```text
CAS path validation
cache pin/eviction
peer score/cooldown
sequence gap tracking
context precedence/freshness
CEL adapter
clock authority selection
capability transitions
presentation compatibility
update state machine
certificate renewal schedule
```

Use property tests/fuzzing for parsers and path/range validation where appropriate.

### 44.2 Go server tests

For every Edge API/protocol change:

- unit tests for signing/canonicalization;
- PostgreSQL integration test for transaction boundaries;
- auth/role tests;
- retention/snapshot tests;
- pairing/revocation interaction;
- update deployment interaction.

Run with the repo's existing shared Postgres advisory-lock test approach.

### 44.3 Protocol golden tests

The same fixtures are consumed by Go, Rust, TypeScript and C where applicable.

Golden suites cover:

- every signing-domain prefix;
- stream digest preimage/genesis construction;
- signature-domain separation;
- JCS canonical bytes;
- large counters encoded as decimal strings;
- duplicate JSON keys/malformed UTF-8/closed-schema behavior;
- exact Base64url/no-padding digest/signature encoding;
- CA/leaf X.509 DER profile and CSR proof-of-possession;
- trust realm/state incarnation/security lineage coordinates;
- fixed security/policy/screen stream IDs;
- same-coordinate/different-digest fork;
- same-subject-revision/different-state-digest fork;
- subject tombstones;
- current-state/snapshot/security/recovery documents;
- unknown schema/message safe-degradation rules;
- object grants;
- IPC min/max and renderer process binding;
- renderer capability/profile versioning;
- Context scalar/timestamp/duration/numeric edge cases;
- Context epoch/definition-revision/TTL/replay rules;
- CEL resource-cost fixtures.

### 44.4 Multi-node integration harness

Build a test harness that launches:

```text
1 fixture Tilecast Server + PostgreSQL
3 tilecastd processes
3 independent state/CAS dirs
local Edge CA/certs issued by fixture server
optional fixture renderer stubs
```

It should be easy to express:

```text
node A server access = yes
node B server access = no
node C server access = no
A↔B = healthy
B↔C = healthy
latency = 20ms
packet loss = 5%
```

Use Linux network namespaces/veth and `tc netem` in a privileged CI/nightly environment for true network tests. Provide a lighter loopback fault-injection transport for ordinary PR CI.

### 44.5 Failure injection

Kill/restart at durability, restore, migration and update boundaries:

- after domain transaction, before object compile;
- after object fsync, before object-ready mark;
- after one mutation in a same-stream change set is ready but another is not;
- after stream-state lock, before atomic change-set/projection commit;
- after stream/projection commit, before outbox cleanup;
- after trusted-checkpoint fsync, before dependent SQLite activation;
- after recovery root prepared, before active pointer;
- after recovery root active, before one screen's lazy new-incarnation snapshot exists;
- during ERB/security-snapshot creation/rotation;
- during restore after DB/file staging but before Edge recovery-pointer activation;
- after CAS file fsync, before rename/directory fsync;
- after migration candidate credential is created, before node fsync;
- after candidate credential fsync, before WPE actual-content health;
- after migration confirmation commit, before response delivery;
- staged migration expiry while candidate is offline;
- after command intent persistence, before disruptive initiation;
- after release-set pending metadata, before pointer switch;
- after pointer switch, before directory fsync;
- after backward-compatible expand migration, before candidate start;
- candidate READY but smoke/health never passes;
- repeated power cycles before update confirmation;
- during certificate/identity generation replacement;
- during SQLite WAL checkpoint.

Recovery scenarios:

- DB restore older than fleet state + matching/newer ERB/full security snapshot;
- DB restore older than fleet state + missing/stale ERB;
- old DB resurrects a credential/certificate that external security snapshot rejects;
- newer security stream continues while ordinary screen incarnation is still old;
- cross-installation restore with mismatched old trust realm;
- local SQLite loss with trusted checkpoint intact;
- local SQLite + trusted checkpoint loss;
- restored pending reboot/shutdown/update;
- failed async object compilation then newer superseding revision;
- same-stream multi-subject transaction never exposes partial projection;
- screen-by-screen lazy recovery after large-fleet restore.

An arbitrary whole-disk rollback with no external monotonic witness is a documented limitation, not a test expected to self-detect. The corresponding test presents a newer external ERB/witness and proves the stale disk state is then rejected.

Every crash point has one documented restart/convergence result.

### 44.6 WPE renderer tests

Headless/WPE tests cover:

- launcher/runtime startup;
- subprocess sandbox before web process;
- inherited/PID-bound renderer IPC;
- daemon restart kills/recreates renderer;
- trusted runtime local-scheme/CSP/MIME policy;
- opaque `tcmedia` capability reads through daemon channel;
- raw digest/unknown capability denial;
- stale presentation/renderer capability denial;
- remote-origin denial for trusted scheme/native bridge;
- iframe/content-world bridge isolation;
- HTTP(S)/WebSocket/worker/service-worker private-network denial;
- IPv4/IPv6/CGNAT/link-local/loopback/mapped-address cases;
- DNS rebinding/re-resolution;
- explicit proxy behavior;
- WebRTC/media-stream/data-channel disabled;
- remote inspector/developer extras disabled in production;
- file download/chooser/external-protocol denial;
- website storage quota/cleanup;
- navigation/permissions/process recovery.

Large media tests cover Range seek, pause/resume, loop, transition drain and cancellation through the daemon media channel.

Wayland/DRM jobs retain their hardware/recovery qualification.

### 44.7 Security tests

Required adversarial cases include:

- wrong installation/trust-realm certificate;
- wrong CA/leaf constraints/KU/EKU/purpose/OID;
- invalid CSR proof-of-possession;
- Edge enrollment/re-anchor attempted over plain private HTTP;
- expired/revoked certificate;
- certificate generation below current per-node minimum;
- stale restored server attempts to mint an already-obsolete certificate generation;
- disabled node using any certificate;
- old authority key attempts fresh current-state/snapshot/grant signing after retirement;
- TLS resumed-session/early-data bypass attempt;
- one node claims another namespace/liveliness;
- Presentation Network becomes forbidden while session exists;
- peer endpoint/redirect/proxy/SSRF cases;
- signed document reused under wrong domain;
- malformed stream/digest canonicalization;
- same stream coordinate + different digest;
- same subject revision + different state digest;
- partial same-stream change-set application attempt;
- peer attempts trust-realm/state-incarnation transition;
- security update accepted while ordinary node remains on previous state incarnation;
- restored DB tries lower security generation;
- restored DB resurrects revoked device credential but ERB security snapshot rejects it;
- missing ERB tries to reopen existing trust realm;
- local DB loss receives old peer state as first anchor;
- retired authority history tries to extend above cutover boundary;
- unknown security schema;
- target grant expired/too old generation/wrong audience;
- one hash has permissive + confidential references;
- plaintext previously peerable object is not falsely claimed retroactively confidential;
- remote page knows CAS hash but lacks opaque media capability;
- Context numeric/CEL/replay/definition-revision attacks;
- malformed/mismatched Range;
- malformed ERB/mismatched installation/trust realm;
- wrong IPC role/UID/process identity.

### 44.8 Compatibility tests

### 44.8 Compatibility tests

Matrix:

```text
Server new + legacy Electron player
Server new + Android player
Server new + Edge/WPE renderer on Wayland host
Server new + Edge/WPE renderer on DRM dedicated host
Legacy Electron host -> one-time Edge/WPE migration
Mixed Display Group with supported combinations
Upgrade release set N -> N+1 -> rollback N
Upgrade renderer/WPE runtime as one release set
Server restore with matching ERB
Server restore without ERB -> trust reset workflow
```

Compatibility tests include:

- server/player protocol min/max;
- fixed stream schema version negotiation;
- state-schema readable and writable rollback ranges;
- actual N-1 binary open + representative write against the N+1 expanded schema;
- N+1 reopens/validates the rows written by N during rollback;
- daemon/renderer IPC overlap;
- renderer/private-WPE ABI;
- privileged updater/watchdog protocol;
- legacy-import/state-incarnation behavior across rollback/recovery.

A server upgrade must not strand older players; when older Edge software cannot understand new **security** semantics it must degrade mesh safely rather than silently skipping them.

## 45. Failure-mode contract

| Failure | Correct behavior |
| --- | --- |
| Tilecast Server unreachable | Continue trusted cached schedules, eligible mesh/CDN and local Context. |
| All peers disappear | Continue standalone; origin when reachable. |
| Multicast blocked | Validated seeds/manual config or standalone. |
| Zenoh unavailable | Playback/server path continues; mesh degraded. |
| Peer advertises unsafe endpoint | Reject without connecting. |
| Peer sends corrupt bytes | Hash reject, penalize, refetch. |
| Target grant invalid/expired/stale | Refuse peer bytes even if hash exists. |
| Same hash has confidential + permissive live refs | Effective hash policy is the stricter policy; do not OR-open it. |
| Renderer/remote page knows CAS hash | Hash grants no media read; daemon requires current opaque presentation capability. |
| Disk full | Preserve every live pin owner; stop new preparation. |
| SQLite corrupt, trusted checkpoint intact | Rebuild local state without rolling trust backward. |
| SQLite + trusted checkpoint lost | Direct secure server bootstrap/recovery required. |
| Node cert expires | Server playback may continue; mesh disabled until safe renewal. |
| Certificate generation below security minimum | Reject even if CA signature is valid. |
| Trust realm mismatch | Refuse peer/state; no auto-trust. |
| Security generation arrives while screen uses old ordinary incarnation | Accept security update when trust realm/lineage are valid; ordinary incarnation is independent. |
| Policy/screen stream gap | Recover that stream; independent streams continue. |
| Same stream coordinate, different digest | Fork incident; direct server reconciliation. |
| Same resource revision, different state digest | Equivocation incident. |
| Multi-subject same-stream change set partially ready | Publish/apply none until complete. |
| DB restored behind fleet + current ERB | Overlay full security state, create fresh ordinary incarnation, re-anchor screens lazily. |
| DB resurrects revoked player bearer | Security credential overlay rejects it; repair/re-pair if current secret row is absent. |
| DB restored without current security proof | `edge_security_recovery_required`; no lower security publication. |
| Complete VM/disk rollback with no external witness | Cannot be auto-detected; require administrator/external witness before claiming rollback-safe Edge recovery. |
| Cross-installation restore + old local trust | Quarantine; matching ERB or trust reset. |
| Retired authority signs fresh state | Reject above retirement boundary. |
| Unknown security schema/type | Disable mesh/security-sensitive participation; require upgrade/server. |
| Presentation Network becomes forbidden | Withdraw advertisement/listeners and close existing sessions on interface. |
| Renderer crashes | Recreate bound WPE renderer. |
| WPE repeatedly crashes | Bounded WPE recovery then safe mode; no Electron runtime fallback. |
| Migration preflight finds incompatible assigned content | Abort before credential cutover; restart unchanged Electron. |
| Staged migration candidate dies/expires | Revoke candidate credential, unfence legacy credential. |
| Migration confirmation response lost | Candidate credential already durable/active; retry succeeds, old legacy bearer remains revoked. |
| Old Electron starts after confirmation | Its preserved credential is rejected. |
| Candidate Edge release crashes | Stable watchdog rolls back complete Edge release set. |
| Previous Edge release cannot write candidate-expanded schema | Do not arm/perform automatic binary rollback. |
| Privileged helper too old | Deployment incompatible; no activation. |
| Restored old disruptive command/update pending | Do not execute until explicitly reauthorized in current ordinary incarnation. |
| LAN partition | Continue trusted local state and reconcile after heal without peer authority. |

## 46. Performance and resource targets

## 46. Performance and resource targets

These are engineering acceptance targets, not marketing promises. Benchmark on the existing low-end reference class (~2012 Ivy Bridge/Intel HD 4000/4 GiB) and adjust only with recorded data.

### 46.1 Idle Edge daemon

Initial target:

```text
RSS:                 < 100 MiB steady-state preferred
CPU when idle:       < 1% average on reference dual-core
wakeups:             bounded; no sub-second polling loops without reason
open FDs:            bounded and stable in soak
SQLite writes:       batched; no heartbeat-frequency fsync storm
```

If Zenoh/TLS/runtime pushes RSS higher, record a measured budget before release rather than hiding it.

### 46.2 Mesh propagation

Healthy same-LAN target:

```text
peer presence change visible:           < 2 s typical
signed change hint propagation:         < 250 ms median
change reconciliation start:            < 1 s typical
```

Correctness must not rely on meeting these timings.

### 46.3 Peer CDN

On 1 Gb/s Ethernet with disk capable of keeping up:

- one peer transfer should achieve a substantial fraction of line rate without saturating both CPU cores;
- serving content must not make active video drop frames;
- hash verification may be streaming/incremental but final whole-object digest remains required;
- default concurrent transfers must be conservative on 4 GiB hardware.

Measure before setting a hard throughput SLO.

### 46.4 Publish-to-ready comparison

Measure:

- legacy server push/reconcile path;
- Edge signed state path;
- object preparation time;
- peer/origin fetch;
- activation readiness.

Also run a fleet-scaling benchmark for installation-wide and screen-targeted mutations. Report total signed feed bytes, payload bytes each node consumes, server CPU/storage and convergence time as fleet size grows.

The v1 feed/scoping strategy must not exhibit unbounded practical O(N²) payload fan-out for ordinary organization-wide changes.

### 46.5 WPE

Targets on reference hardware:

- 1080p H.264 hardware decode when Mesa/GStreamer stack supports it;
- no long-term renderer RSS leak across 72-hour soak;
- idle static content should not burn a CPU core;
- renderer restart to restored presentation target < 5 seconds after process availability on local cached content, measured rather than assumed.

---

## 47. Rollout strategy

### 47.1 Feature gates

Server Edge settings start disabled for existing installations until at least daemon ownership migration is production-ready.

Useful rollout flags:

```text
edge.enabled
edge.mesh.enabled
edge.peer_delivery.enabled
edge.change_feed.enabled
edge.context.enabled
```

Do not leave permanent boolean-flag soup. Remove transitional flags once a milestone becomes the stable behavior.

### 47.2 Canary screens

Use the existing deployment/canary philosophy.

Recommended school rollout:

1. one non-critical screen;
2. two screens on same LAN to validate mesh/CDN;
3. one screen from each hardware generation;
4. a small display group;
5. remaining Linux screens.

WPE is part of every Edge canary from the first migrated host; it is not a later optional renderer rollout.

### 47.3 Metrics before expansion

Check:

- playback incidents;
- renderer restart rate;
- Edge process restarts;
- cache integrity failures;
- peer/origin transfer results;
- memory/disk growth;
- command duplicates (must remain zero);
- clock drift/authority transitions;
- certificate renewal.

### 47.4 Emergency disable

An administrator must be able to disable:

```text
peer delivery
mesh discovery/connectivity
sensor contributions
```

without unpairing the screen or deleting cached content.

During the explicitly supported migration window, a failed Edge installation may use the documented package-level rollback to the legacy Linux player. This is never an automatic runtime fallback.

---

## 48. Code-review rules for Edge

1. No new root privilege without written threat-boundary review.
2. No interpolated shell execution.
3. No arbitrary path/network target from server/peer input.
4. Bound every network/body/frame/per-peer resource.
5. Peer relay never creates trust-realm/state-incarnation authority.
6. Every signed protocol has an explicit domain prefix.
7. Stream digest/signature preimages are normative fixtures.
8. Security lineage/generation never decreases through ordinary restore.
9. Resource revisions compare only inside one state incarnation.
10. Same revision + different state digest is a fork.
11. Durable deletion uses tombstones.
12. Unknown security semantics fail closed/degrade mesh.
13. Content is trusted only after size/hash verification.
14. Hash identity is not authorization; target-granted bytes require signed grant.
15. CAS pins have independent owners.
16. Commands use explicit execution semantics, not generic exactly-once claims.
17. Legacy cutover uses a bounded server migration fence and confirmation-time credential revocation; local service state alone is not authentication fencing.
18. Restore cannot auto-execute old-incarnation disruptive work.
19. Updates activate/rollback complete release sets.
20. Automatic rollback requires actual previous-reader schema compatibility.
21. Candidate cannot unilaterally disarm stable rollback watchdog.
22. Renderer IPC binds to actual launched process plus presentation generation.
23. Optional provider failure cannot brick playback.
24. High-rate data is coalesced.
25. No secret in logs/tests/screenshots.
26. Edge protocol changes require cross-language fixtures.
27. WPE keeps subprocess sandbox, local-scheme isolation, strict remote-site network policy and storage quotas.
28. No Edge runtime path may launch or depend on Electron; WPE failure uses WPE recovery/safe mode or explicit package rollback during migration.
29. Context source-local revisions are not compared across different sources.
30. Context observations bind definition revision and bounded deterministic scalar encoding.
31. CEL source/AST/evaluation cost is bounded.
32. Rhea Studio remains canonical UI plan.
33. Do not claim physical display state from command-send alone.
34. Do not infer health only from process/socket liveness where playback evidence exists.
35. Retry-sensitive telemetry is sequenced/cumulative, not naked heartbeat delta.

## 49. Final technical decision table

| Area | Decision | Do not do |
| --- | --- | --- |
| Edge daemon | Rust `tilecastd` | Grow Electron main process |
| Renderer host | stable tested WPE 2.54.x WPEPlatform C/GLib | Unqualified arbitrary newer WPE/Cog architecture |
| Legacy Linux transition | one-time read-only Electron-state import, then WPE-only Edge | dual-active/renderer fallback architecture |
| Display modes | WPE headless test, Wayland qualified, DRM/KMS dedicated | desktop/Electron dependency on dedicated hosts |
| Local persistence | SQLite WAL + CAS + durable trusted checkpoint | Reconstruct anti-rollback trust from peers |
| Trust recovery | encrypted ERB or explicit trust-realm reset/re-enrollment | Put raw CA keys in ordinary unencrypted backup |
| Ordinary restore | fresh opaque state incarnation after rollback restore | Numerically decrement/reuse recovery epoch |
| Security recovery | independent security lineage/generation | Let DB restore resurrect revocations |
| Streams | fixed security, policy and per-screen streams | One global player payload feed/O(N²) fan-out |
| Stream integrity | sequence + previous/stream digest + domain-separated signature | Circular/self-hashed envelope |
| Resource freshness | revision + state digest inside one incarnation | Compare revisions across incarnations |
| Snapshots | materialized Edge projection at exact stream watermark | Snapshot arbitrary DB while async compilation pending |
| Host runtime ownership | WPE preflight + migration session/fence + two-phase credential replacement + local mutual exclusion | Trust stop/disable alone or preserve a still-valid Electron bearer |
| Commands/updates | authorization bound to incarnation | Re-execute restored pending disruptive work |
| CAS auth | blob identity + reference sharing class/object grant | Hash means every node may read |
| Mesh security | trust-realm mTLS, CA-only outbound trust, no v1 resumption/0-RTT | LAN/public-WebPKI trust |
| Updates | signed atomic release sets + stable external watchdog | Independently flip incompatible components |
| WPE website security | sandbox + local trusted schemes + egress/proxy/storage policy | Only URL/CORS checks |
| Context precedence | source-local newest, then configured source priority/order | Compare revision counters from different sources |
| Context safety | definition-bound signed observations + deterministic scalar formats + CEL cost bounds | Arbitrary JSON/unbounded expressions |
| Studio UI | canonical shadcn Base UI + Rhea | Spectrum/second shell |

## 50. Decisions deliberately deferred

These items have an architectural slot but should not be guessed before evidence exists.

### 50.1 Multi-source chunk swarming

Only add if a single-source peer transfer is measurably insufficient for real deployments.

### 50.2 QUIC Zenoh/data plane

Benchmark after TCP/TLS is stable. Metadata does not justify complexity by default.

### 50.3 Generic PipeWire session bridge

Build only if supported real installations cannot provide PipeWire to the fixed Tilecast account cleanly.

### 50.4 Direct CEC/DDC libraries

Current fixed CLI invocation is safe and adequate. Replace only for measured reliability/performance reasons.

### 50.5 Managed PTP

V1 detects/consumes existing synchronization. Any Tilecast-managed `ptp4l/phc2sys` configuration is an explicit later feature with client-only safety.

### 50.6 Android mesh participation

Linux Edge v1 must not wait for Android Zenoh/CDN support.

### 50.7 Full Tilecast OS

Edge/WPE must first prove the runtime. Appliance-image work is a separate product/deployment milestone.

### 50.8 Legacy migration-support removal date

Electron is already excluded from Edge runtime architecture.

The deferred decision is only when Tilecast may stop supporting **upgrades from** the final legacy Electron release and therefore remove the legacy state importer/reference fixtures. Make that decision from fleet/version telemetry and documented support policy.

## 51. Definition of Done for Tilecast Edge v1

### Trust/recovery

- trust realm is recoverable through encrypted ERB or explicitly reset with re-enrollment;
- ordinary rollback restore creates a fresh opaque state incarnation;
- security lineage/generation cannot silently move backward;
- new incarnation is fully prepared/durable before publication;
- local trust loss cannot use peer state as first anchor;
- cross-installation restore cannot mix mismatched trust material.

### Fabric/protocol

- fixed security/policy/per-screen streams are implemented;
- exact digest/signature/domain fixtures agree cross-language;
- stream and resource equivocation are detected;
- unknown security semantics degrade safely;
- mTLS uses exact CA/leaf profile, no v1 TLS resumption/0-RTT;
- Presentation Network withdrawal closes existing forbidden-interface sessions.

### Content

- blob/reference/multi-owner-pin model;
- sharing classes and object grants enforce confidentiality;
- canonical ETag/resume and per-peer limits work;
- transition media remains pinned/readable through drain.

### State

- snapshots come from materialized Edge projection;
- source publication remains pinned until object projection completes/supersedes;
- security stream can advance independently;
- resource revisions reset namespace on trusted new incarnation;
- tombstones/removal converge.

### Migration/commands

- WPE hardware/content preflight completes before authority cutover;
- migration session temporarily fences legacy owner-sensitive work;
- candidate credential is fsync'd before confirmation;
- confirmation atomically revokes the preserved legacy bearer;
- stale Electron cannot authenticate after confirmation;
- pre-confirmation abort/expiry safely restores legacy authority;
- post-confirmation recovery uses Edge rollback or explicit server-assisted legacy recovery;
- old-incarnation pending disruptive commands/updates do not auto-execute.

### Context

- source-local revision ordering is correct;
- observations bind definition revision;
- receiver TTL/replay guarantees survive reset;
- numeric/time formats are deterministic;
- CEL differential and cost-limit suite passes.

### Renderer/WPE

- WPE is the only Edge Linux renderer;
- renderer process identity is bound to the daemon-launched instance/process;
- daemon restart recreates renderer;
- WebKit subprocess sandbox is enabled;
- `tcmedia` uses opaque renderer/presentation capabilities backed by daemon media IPC and the renderer has no CAS-root access;
- H.264 passes seek/progress/restart through that capability channel;
- raw hash knowledge does not authorize renderer/remote-page media reads;
- trusted bridge is isolated to the intended content world/top frame;
- remote website HTTP/WebSocket/worker/service-worker egress policy covers IPv4/IPv6 special/private ranges and DNS rebinding;
- WebRTC/remote inspector/download/external-launch defaults are explicitly disabled;
- proxy and persistent-storage policy is enforced before website capability is declared;
- Wayland and DRM/KMS host modes are explicitly qualified;
- stable patched WPE baseline/security updates are tracked.

### Updates

- daemon/renderers/private runtime activate as one signed compatible release set;
- old daemon cannot race offline migration;
- stable watchdog, persisted unconfirmed attempts and offline smoke fixture gate confirmation;
- real previous-release read/write compatibility is tested while automatic rollback is armed;
- privileged updater/watchdog protocol compatibility is enforced.

### Studio/reliability

- Rhea surfaces show backend-provided bounded real state;
- backup/restore UI explains ERB/trust-reset consequences;
- restore/local-loss/partition/fork/failure-injection suites pass;
- fleet benchmark demonstrates bounded per-screen stream fan-out;
- low-end resource targets are measured.

## 52. Repository-specific implementation notes

These notes prevent common “greenfield” mistakes when applying this plan to the current Tilecast codebase.

### 52.1 Reuse server manifest logic

Do not build a separate Edge presentation compiler that gradually diverges from `internal/playlists`, scheduling, sources, plugins, layouts, takeovers and presentation overrides.

The Edge presentation-bundle builder must sit on top of/shared with the same domain logic used by current manifest assembly.

### 52.2 Preserve current heartbeat asymmetry

Current player protocol intentionally drops malformed optional playback identifiers while still recording contact/lifecycle state. Edge optional metadata needs the same defensive property. A broken capability field must not strand an update deployment or make an active screen look offline.

### 52.3 Preserve existing activity semantics

`docs/activity.md`, `docs/activity-event-contract.md`, and `docs/reliability-and-power.md` contain load-bearing definitions. Edge should add measurements/events to those systems rather than redefining health around mesh/process status.

### 52.4 Preserve Presentation Network privilege boundary

The existing Python helper comments/tests are unusually explicit and should be treated as security requirements, not implementation trivia.

### 52.5 Keep publishing immutable

Current playlist/layout/campaign publication already uses immutable revision concepts. Edge Objects should strengthen that model rather than create mutable peer-visible drafts.

The outbox captures those immutable revision IDs in the same authoritative transaction. Background compilation/signing must use the captured revision, not re-read the latest mutable resource. Feed sequence remains transport/completeness order; revision IDs remain semantic freshness order.

### 52.6 Keep server deployment simple

Do not add Zenoh as a mandatory Docker service. The normal Tilecast Server remains the current Go binary + PostgreSQL deployment. Edge mesh lives on Linux player nodes.

### 52.7 Follow the canonical Rhea Studio plan without coupling UI to runtime correctness

Server/Edge protocols remain independently testable from Studio.

The canonical UI migration is `docs/studio-rhea-redesign-plan.md` (shadcn Base UI + Rhea), and that migration is being implemented independently from Edge. Edge does not own the product-wide redesign, does not revive Spectrum 2 and does not create an alternate shell.

Runtime/CDN/security work can expose temporary API/`tilecastctl` diagnostics until the Rhea implementation is ready. When Studio work begins, rebase onto/integrate with the actual Rhea implementation instead of carrying assumptions from the old Studio or creating a parallel UI layer.

## 53. Research notes and upstream references

This plan was built against the current Tilecast repository and current upstream documentation as of **September 22, 2026**. Prefer official/upstream documentation when implementation details change.

### Tilecast repository material reviewed

- `AGENTS.md`
- `README.md`
- `docs/architecture.md`
- `docs/player-protocol.md`
- `docs/player-updates.md`
- `docs/reliability-and-power.md`
- `docs/studio-rhea-redesign-plan.md`
- `docs/activity.md`
- `docs/display-control.md`
- `docs/presentation-networks.md`
- `apps/player-linux/README.md`
- `apps/player-linux/src/core/player.ts`
- `apps/player-linux/src/core/commands.ts`
- `apps/player-linux/src/core/storage.ts`
- `apps/player-linux/src/core/download.ts`
- `apps/player-linux/src/core/socket.ts`
- `apps/player-linux/src/core/clock.ts`
- `apps/player-linux/src/core/self-update.ts`
- `apps/player-linux/src/core/presentation-network.ts`
- `apps/player-linux/src/core/display-control.ts`
- `apps/player-linux/src/core/system-probe.ts`
- `apps/player-linux/src/core/supervisor.ts`
- `apps/player-linux/src/core/telemetry.ts`
- `apps/player-linux/src/main/index.ts`
- `apps/player-linux/src/main/hardware.ts`
- `apps/player-linux/src/main/display-control.ts`
- `apps/player-linux/src/main/presentation-network.ts`
- `apps/player-linux/src/renderer/renderer.ts`
- `apps/player-linux/src/preload.ts`
- `apps/server/internal/httpapi/install/tilecast-networkd`
- `apps/server/internal/httpapi/install/tilecast-networkd.service`
- `apps/server/internal/playlists/service.go`
- `apps/server/internal/playlists/types.go`
- `apps/server/internal/playlists/capabilities.go`
- `apps/server/internal/devices/types.go`
- `apps/server/internal/devices/credentials.go`
- `apps/server/internal/database/migrations/00007_emergencies_and_player_commands.sql`
- `.github/workflows/linux-player-release.yml`
- current dashboard screen/activity components and package metadata.

Repository: <https://github.com/gbyo/tilecast>

### Zenoh

Official deployment documentation:

<https://zenoh.io/docs/getting-started/deployment/>

Key implementation facts used here:

- peer mode supports direct peer-to-peer communication;
- peer mode uses multicast and gossip scouting;
- gossip can discover the network after connecting to an entry point when multicast is unavailable.

Official TLS/mTLS documentation:

<https://zenoh.io/docs/manual/tls/>

Important security detail used here: explicitly restricting `transport.link.protocols` to `tls` is necessary when using scouting if all connections must remain TLS.

Official ACL documentation:

<https://zenoh.io/docs/manual/access-control/>

Used for the default-deny/exact-key ACL direction and to avoid treating ACL as a replacement for application-level signed authority.

Current upstream limitations tracked during this RFC review:

- private root CA may be added to default WebPKI roots on the connector path: <https://github.com/eclipse-zenoh/zenoh/issues/2711>
- dynamic ACL key expressions bound to authenticated client identity are not currently available in the documented model: <https://github.com/eclipse-zenoh/zenoh/issues/2659>

These are implementation gates, not reasons to weaken Tilecast's trust model.

Zenoh project/docs:

<https://zenoh.io/>

### Signed JSON / JCS

RFC 8785 JSON Canonicalization Scheme:

<https://www.rfc-editor.org/rfc/rfc8785.html>

Signed Edge documents keep large counters/revisions as decimal strings so cross-language implementations do not depend on JavaScript number precision.

### systemd socket activation

systemd socket unit documentation:

<https://www.freedesktop.org/software/systemd/man/latest/systemd.socket.html>

Socket-activation FD passing/testing:

<https://www.freedesktop.org/software/systemd/man/latest/systemd-socket-activate.html>

Used for renderer/media/admin Unix socket ownership and inherited listening descriptors.

### WPE WebKit

WPE WebKit 2.54 highlights, released September 16, 2026:

<https://wpewebkit.org/blog/2026-09-16-wpewebkit-2.54.html>

2.54 release:

<https://wpewebkit.org/release/wpewebkit-2.54.0.html>

WPE FAQ / WPEPlatform launcher examples:

<https://wpewebkit.org/about/faq.html>

Architecture:

<https://wpewebkit.org/about/architecture.html>

Supported hardware notes:

<https://wpewebkit.org/about/supported-hardware.html>

Custom URI scheme/CORS integration guidance:

<https://wpewebkit.org/blog/06-integrating-wpe.html>

WebKit subprocess sandbox API:

<https://webkitgtk.org/reference/webkit2gtk/stable/method.WebContext.set_sandbox_enabled.html>

Custom URI response headers/status support:

<https://webkitgtk.org/reference/webkit2gtk/stable/class.URISchemeResponse.html>

Developer overview:

<https://wpewebkit.org/developers/>

Important decisions derived from current upstream:

- WPEPlatform is stable/default in 2.54;
- new code should target WPEPlatform rather than legacy libwpe;
- Wayland, DRM/KMS and headless are built in;
- Wayland runs as a client of a compositor;
- DRM/KMS can run without a compositor;
- WebKit subprocess sandboxing must be enabled before web processes are created;
- custom URI schemes remain subject to origin/CORS rules and require explicit embedder opt-in to cross-origin access;
- custom URI responses can provide response status/headers needed for bounded media-response behavior;
- new projects should prefer a small custom launcher rather than new Cog-based architecture;
- Tilecast Edge uses WPE as its only Linux renderer; Electron remains only a legacy migration/reference source;
- WPE custom URI scheme registration alone is not a GStreamer URI source, so Tilecast video uses a narrow custom `GstURIHandler` source for `tcmedia://cap/<opaque-capability>`;
- the GStreamer source reads through a daemon capability channel and never receives the CAS root;
- `WEBKIT_GST_ALLOWED_URI_PROTOCOLS` adds Tilecast's protocol to WebKit's media-protocol allowlist; it is not an origin, CAS, or presentation-authorization boundary.

### systemd

`sd_notify` watchdog documentation:

<https://www.freedesktop.org/software/systemd/man/latest/sd_notify.html>

Upstream source/manual mirror used during research:

<https://cgit.freedesktop.org/systemd/systemd/tree/man/sd_notify.xml>

The watchdog design follows systemd's recommendation to issue `WATCHDOG=1` periodically, typically around half the configured watchdog interval when `WATCHDOG_USEC` is supplied.

### PipeWire

Object/media graph design:

<https://docs.pipewire.org/page_objects_design.html>

Overview:

<https://docs.pipewire.org/page_overview.html>

Session manager responsibilities:

<https://docs.pipewire.org/page_session_manager.html>

The Edge audio design follows PipeWire's node/port/link model and treats session-manager policy as separate from the low-level graph.

### Avahi

Avahi API overview:

<https://avahi.org/doxygen/html/>

Relevant upstream recommendation: normal non-C applications should use avahi-daemon's D-Bus API instead of embedding a second complete mDNS stack.

### linuxptp

`ptp4l`:

<https://www.linuxptp.org/documentation/ptp4l/>

`phc2sys`:

<https://www.linuxptp.org/documentation/phc2sys/>

The plan specifically uses `clientOnly`/`-s` as the safety direction if managed PTP is ever introduced, and does not make Tilecast a grandmaster automatically.

### CEL

Official CEL overview:

<https://cel.dev/overview/cel-overview>

Project home:

<https://cel.dev/>

CEL's safe, non-Turing-complete, parse/check/evaluate model and compile-once/evaluate-many design are the reason it is preferred over a Tilecast-specific expression language.

### shadcn Base UI + Rhea Studio

Canonical repository design plan:

`docs/studio-rhea-redesign-plan.md`

Official shadcn references used by that plan:

- <https://ui.shadcn.com/>
- <https://ui.shadcn.com/blocks>
- <https://ui.shadcn.com/docs/components/base/sidebar>
- <https://ui.shadcn.com/docs/components/base/data-table>

This Edge RFC follows that document for shell, component, information-architecture and accessibility choices rather than duplicating the Studio design specification here. The Rhea redesign is a separate concurrent implementation workstream; this RFC deliberately treats it as the canonical upstream Studio dependency. Spectrum 2 is not part of the target Studio architecture.

### NetworkManager

NetworkManager project/developer documentation:

<https://networkmanager.dev/docs/api/latest/>

Tilecast v1 deliberately preserves the current narrow helper and may migrate the helper implementation to D-Bus later rather than giving the unprivileged Edge daemon broad NetworkManager authority.

---

## 54. Short implementation principle

When a design choice is unclear during implementation, use this hierarchy:

```text
1. Keep playback correct and available.
2. Keep Tilecast Server authoritative.
3. Verify before trusting LAN data.
4. Keep privileged surfaces tiny and typed.
5. Make renderer processes disposable.
6. Prefer local/offline operation once state is verified.
7. Optimize distribution only after correctness is independent of it.
8. Report capabilities/limitations truthfully instead of pretending support.
9. Reuse existing Tilecast domain semantics instead of inventing Edge-specific duplicates.
10. Make the Rhea Studio UI explain backend state; do not make React become the distributed-system authority.
```

That is the intended shape of **Tilecast Edge**: a secure, local-first distributed execution layer that makes a building full of displays feel like one coherent Tilecast installation without turning the product into a distributed database.

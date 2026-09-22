# Tilecast Edge

## Canonical Architecture and Implementation Plan

**Status:** Proposed implementation RFC
**Product:** Tilecast
**Subsystem:** Tilecast Edge (Fabric)
**Date:** 2026-09-22
**Repository baseline reviewed:** `gbyo/tilecast` at `main` (`191d03e558964d91fbd7523d0238de3405f1837d` during research)
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
                 ┌─────────────┴──────────────┐
                 │                            │
        tilecast-renderer-wpe        Electron compatibility
          WPE WebKit 2.54+               renderer
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
9. **WPE WebKit is the future Linux renderer.** Target WPEPlatform 2.54+, not legacy Cog/libwpe/WPEBackend-fdo. The first-party renderer is a small C/GLib host; the existing browser renderer assets are reused where possible.
10. **Electron is not removed in a flag day.** It becomes a compatibility renderer while `tilecastd` takes ownership of the machine. Edge chooses WPE only when the assigned presentation's requirements are supported by WPE.
11. **Tilecast Studio Edge UI follows the canonical shadcn Base UI + Rhea Studio plan.** Edge surfaces must reuse the current Studio shell, information architecture, interaction rules and generated shadcn components from `docs/studio-rhea-redesign-plan.md`. Do not revive the abandoned Spectrum implementation or add a second Edge-specific design system.
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
- Immediately removing the existing Electron Linux player.
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
| `main/hardware.ts` | Electron-specific tuning | Electron compatibility renderer only |
| `preload.ts` synchronization | timeline projection | `tilecastd` presentation engine |
| `renderer/renderer.ts` | browser presentation surface | shared web renderer runtime |
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
  player-linux/                 # Electron compatibility during migration

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

It runs as a fixed unprivileged account, `tilecast-edge`, under a **system** systemd service. It should not run as root and should not inherit a logged-in user's broad session privileges. Renderers run under a separate `tilecast-renderer` identity so a compromised renderer cannot authenticate to daemon administration IPC merely because it shares the daemon's UID.

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

Renderers are disposable and run under the dedicated unprivileged `tilecast-renderer` account, separate from `tilecast-edge`.

A renderer receives a complete, validated, prepared presentation contract and reports evidence about what actually happened on screen. Its access to `tilecastd` is granted by a renderer-only Unix socket whose ownership and peer-credential checks map that OS identity to the renderer role. The renderer does not self-assert an administrative role in JSON.

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

/run/tilecast-edge/
    renderer.sock
    media.sock
    admin.sock
    health/

/opt/tilecast-edge/
    releases/
    current -> releases/<version>/
    previous -> releases/<version>/
    rollback-state/
```

The active identity generation changes with one atomic pointer switch after the complete key/certificate/CA/keyring set is durable. Do not leave a single `node-key.pem` beside a separately replaced `node-cert.pem`.

`authority-keyring.json` contains the verified public authority transition chain and currently trusted authority epochs. `edge-ca-bundle.pem` may contain overlapping installation CA certificates only during an explicit CA rotation plan.

`trusted-checkpoint.json` is the minimal non-reconstructible anti-rollback state used after destructive SQLite recovery. It contains no private key and no server bearer secret.

Rollback metadata for a pending software release lives outside the candidate release directory and outside a candidate database schema so a failed daemon cannot make its own rollback metadata unreadable.

### 7.1 Filesystem rules

- state/identity directories are owner-only unless an explicit subdirectory has a narrower renderer group ACL;
- CAS paths derive only from validated lowercase SHA-256 hex;
- partial filenames derive from the hash plus a fixed suffix;
- secrets are not stored in the ordinary SQLite database unless an explicit encrypted-secret abstraction is introduced;
- the SQLite file must not be remotely downloadable;
- renderer-visible media is exposed through the constrained `media.sock` path rather than direct CAS access;
- atomic identity/current-release pointer changes are followed by parent-directory fsync on filesystems where that operation is supported.

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
server_changes
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

### 9.5 Renderer media socket

`media.sock` is a separate byte-serving Unix socket. It does not expose SQLite, identity files, arbitrary paths, or the whole CAS namespace.

Use a small fixed HTTP-like contract over AF_UNIX:

```http
HEAD /v1/media/sha256/<hash>
GET  /v1/media/sha256/<hash>
Range: bytes=<start>-<end>
X-Tilecast-Renderer-Instance: <generation>
X-Tilecast-Presentation-Generation: <generation>
```

Authorization rules:

1. the connecting UID is the configured renderer UID;
2. the renderer instance is the currently launched instance;
3. the presentation generation is currently `prepared`, `active`, or `draining`;
4. the requested hash belongs to that presentation generation's capability set;
5. the CAS object is already verified;
6. only HEAD/GET and one bounded byte range are accepted;
7. no directory listing or arbitrary path exists.

Presentation generations move through:

```text
prepared -> active -> draining -> retired
```

Activation does not immediately remove the previous generation. The previous generation remains readable until the renderer acknowledges the transition boundary or a bounded drain timeout expires.

The WPE custom `tilecast://media/<hash>` scheme and Electron compatibility adapter both proxy reads through `media.sock`. Neither renderer gets direct read access to `/var/lib/tilecast-edge`.

## 10. Trust model

Tilecast Edge has three distinct trust relationships. They must not be collapsed.

### 10.1 Tilecast Server ↔ player

This remains the existing device bearer credential contract.

The saved device credential is sent only after `/api/v1/system/identity` matches the configured installation ID. It is never sent to a peer.

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

Reuse the stable Linux `playerInstallationId` as the durable Edge node identifier. Do not create a second unrelated device identity unless a future multi-screen-per-host architecture requires it.

### 11.2 Enrollment

After ordinary Tilecast player enrollment succeeds:

1. `tilecastd` creates an Ed25519 node private key locally.
2. It creates a CSR/public-key enrollment request containing the stable player installation ID and current screen ID.
3. It calls an authenticated server Edge enrollment endpoint using the existing device bearer credential.
4. The server verifies the credential, screen association, installation ID and node state.
5. The server signs a node certificate from the installation Edge CA.
6. The response returns:
   - node certificate;
   - Edge CA certificate;
   - Edge authority public key/fingerprint;
   - mesh protocol version;
   - certificate expiry/renewal threshold.
7. The private key never leaves the node.

### 11.3 Certificate identity

The certificate profile is a protocol contract, not an implementation detail.

Use one checked-in X.509 profile with DER/golden fixtures shared by the server and Rust tests. The initial profile must define:

```text
version                 X.509 v3
subject key             Ed25519
signature               Ed25519
basicConstraints        CA=false, critical
keyUsage                digitalSignature, critical
extendedKeyUsage        clientAuth + serverAuth, critical
serial                  positive unique random 128-bit value
validity                server UTC with documented notBefore skew
SAN/custom OIDs         installation ID, durable node ID, screen binding, purpose
purpose                 tilecast-edge-node
```

Do not rely on common name text for authorization.

The player installation ID is the durable node identity; the screen ID is an authorization binding at certificate issue time. Each issued certificate also has a unique certificate serial number and public-key fingerprint.

If the same hardware is deliberately rebound or repaired to a different logical screen, the server revokes the old certificate instance and requires certificate reissuance before mesh participation resumes. The durable node ID does not become revoked merely because one certificate was replaced.

Peers validate the certificate instance, installation ID, durable node ID, current screen authorization binding, purpose, validity, key usage, EKU, and revocation state before accepting it.

Exact OID numbers and DER encodings are allocated in E0. The protocol fixtures include malformed, duplicate, missing, wrong-EKU, wrong-purpose, wrong-installation and wrong-node certificates.

### 11.4 Rotation

Recommended initial policy:

- validity: 180 days;
- renew when fewer than 30 days remain;
- retry with bounded exponential backoff;
- continue using the still-valid old certificate until replacement is durable;
- install replacement key/certificate material as one versioned identity generation, then atomically switch the active generation;
- retire/revoke the old certificate instance after the new generation is durable and usable;
- report renewal failure to the server before expiration becomes imminent.

A power loss must not leave a new private key paired with an old certificate or the reverse. Use versioned identity directories/files plus one atomic active-generation pointer, or an equivalent single-commit storage design.

### 11.5 Revocation

Use two distinct revocation scopes:

```text
revoked certificate instances   -> certificate serial number/fingerprint
disabled nodes                  -> durable playerInstallationId/nodeId
```

Certificate replacement, renewal and screen rebinding revoke only the superseded certificate instance. Device compromise, explicit decommissioning or revocation of the underlying player identity can disable the durable node and therefore reject every certificate for that node.

Use one monotonic server-side revocation generation included in signed Edge changes/snapshots. The signed revocation state contains both the revoked-certificate set and disabled-node set. Nodes reject a peer when either its exact certificate instance is revoked or its durable node ID is disabled.

Certificate expiry remains a second safety boundary.

Revocation applies to existing sessions and new handshakes. When a node learns a newer revocation generation, it must immediately reject application data from a matching certificate/node and close any matching live Zenoh/peer-HTTPS sessions. Transport teardown may race, so application-level certificate-serial/node checks remain mandatory until the connection is gone.

Tilecast application-level certificate checks must use the Clock Authority's bounded trusted-time view rather than blindly trusting a potentially stale RTC. Persist the newest trustworthy wall-clock lower bound learned from Tilecast Server/NTP/PTP and never allow validation time to move backward across restart.

The TLS library may still perform its own X.509 time check before Tilecast application code runs. E5 must prove one of two supported implementations: inject Tilecast's trusted time into the rustls/Zenoh verifier through a supported time-provider/verifier path, or require trustworthy host wall time before enabling the mesh transport. Do not claim that Clock Authority controls TLS validity unless that integration is wired and tested.

If Edge cannot bound current time well enough to decide certificate validity safely, peer mesh enters a visible `time_untrusted`/degraded state instead of disabling certificate expiry checks; ordinary server-backed/cached playback remains available.

Do not implement online OCSP as an Edge availability dependency.

---

## 12. Server-side Edge secrets

The self-hosted server should generate the installation Edge CA and Edge authority key during Edge initialization, store them under its persistent `/data` volume with strict permissions, and back them up with the installation.

Requirements:

- keys generated with cryptographically secure randomness;
- write to a temporary file, fsync, atomic rename;
- private files mode 0600;
- never returned through dashboard APIs;
- only public certificate/fingerprint returned to players;
- no key material in logs, audit metadata or database rows;
- support explicit authority rotation using overlapping trust epochs rather than silently replacing the key.

Authority signing-key rotation uses a permanent verifiable transition chain. Before epoch N+1 signs ordinary feed/snapshot state, epoch N signs an immutable transition object containing the new epoch number, new public key/fingerprint, activation time/sequence and overlap policy. Nodes that trust epoch N may trust N+1 only after verifying that transition. The server retains the transition chain for offline nodes and snapshot recovery; a node must never accept an unknown higher epoch only because the server/peer claims it is newer.

During the overlap window, the server may include both current and next authority metadata in signed snapshots so long-disconnected nodes can advance without an online trust reset. Edge CA rotation is a separate operation from authority-signing-key rotation and requires an explicit overlapping CA trust/re-enrollment plan before it is enabled.

A server loss that restores PostgreSQL but not the Edge authority/CA data must be treated as a visible recovery condition, not silently generate a new identity and strand every peer.

---

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

The installation ID is part of the keyspace **and** enforced cryptographically. The namespace alone is not a security boundary.

Suggested v1 key layout:

```text
tilecast/<installation>/nodes/<node-id>/liveliness
tilecast/<installation>/nodes/<node-id>/summary
tilecast/<installation>/nodes/<node-id>/capabilities
tilecast/<installation>/nodes/<node-id>/clock
tilecast/<installation>/nodes/<node-id>/cache/events

tilecast/<installation>/changes/latest
tilecast/<installation>/changes/query

tilecast/<installation>/objects/has/<sha256>

tilecast/<installation>/context/<scope>/<scope-id>/<key>

tilecast/<installation>/roles/<role>/candidate
```

Avoid overly broad wildcard subscriptions where fixed/narrow keys are possible. Zenoh's ACL documentation notes that exact key expressions are cheaper to match and topology can make ACL behavior subtle.

### 13.7 Liveliness

Liveliness is only a discovery hint. It is not proof of node identity or authorization.

A Tilecast node must not publish an identity-bearing key such as `nodes/<node-id>/liveliness` unless the implementation can cryptographically bind that key to the authenticated transport identity. Current Zenoh ACL key expressions are static, so the RFC must not assume that a certificate identity can be substituted into a dynamic key path.

Two acceptable v1 designs exist:

1. the pinned Zenoh build exposes the authenticated peer certificate/subject strongly enough that Tilecast can bind the transport to the certificate's durable node ID before accepting identity-bearing liveliness; or
2. Zenoh liveliness uses an opaque connection/session key, while the actual node-presence document is a separately signed application message containing node ID, certificate fingerprint, boot/session generation, capabilities and replay data.

A CA-valid node must not be able to declare another node's liveliness by choosing that node's key expression.

Liveliness loss is not authority loss. Playback, signed state, cache validity and command state do not depend on a liveliness token remaining present.

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

### 14.2 What is peerable

Peerable v1 classes:

- compatible media variants already eligible for the authenticated player;
- immutable published Edge presentation objects;
- renderer/runtime static bundles if they become hash-addressed;
- signed player/Edge release artifacts during an authorized deployment/prefetch window;
- public fonts/assets referenced by a presentation.

Never peer-share:

- the device bearer credential;
- Edge private keys;
- Presentation Network PSK/enterprise passwords or CA provisioning response;
- dashboard sessions;
- website cookie/storage partitions;
- private form attachments that are not already player-manifest eligible;
- screenshots/live-preview frames;
- raw microphone/audio samples;
- arbitrary logs;
- unapproved content;
- secrets from Data Source configuration;
- server private signing/CA keys.

### 14.3 Peer object endpoint

Each node exposes a small mTLS HTTPS service on the Edge interface.

V1 endpoints:

```http
HEAD /v1/blobs/sha256/<hash>
GET  /v1/blobs/sha256/<hash>
```

No upload endpoint. No directory listing. No arbitrary path.

Responses:

```http
ETag: "sha256:<hash>"
Accept-Ranges: bytes
Cache-Control: public, immutable
Content-Length: ...
```

Range behavior must implement only valid single-range requests initially. Reject malformed, multi-range or out-of-bounds requests with an explicit response rather than attempting complex parsing.

### 14.4 Peer authorization

Before serving any bytes:

1. TLS client certificate chains only to the installation Edge CA.
2. certificate purpose and installation ID are valid.
3. exact certificate serial/fingerprint is not revoked.
4. durable node ID is not disabled.
5. requested object exists and is marked `peerable`.
6. request path hash exactly matches the stored object's validated hash.

For an outbound peer fetch, the client also knows the expected node ID from the authenticated object-availability reply. It must verify that the peer HTTPS certificate's SAN/OID node ID matches that expected node ID. Hostname/IP verification may be disabled for changing private addresses only when this Tilecast identity check and installation-CA-only chain validation are both enforced.

A valid peer certificate grants **read access only to peerable immutable objects**, not to the local database or renderer state.

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

### 14.6 Ranking peers

Maintain a bounded rolling score using:

- most recent successful RTT;
- recent effective throughput;
- consecutive failures;
- whether the peer is on the same preferred interface/subnet;
- peer's current transfer load if reported;
- recent object-availability freshness.

Do not build a complex distributed optimizer in v1. A simple weighted score with failure cooldown is sufficient.

### 14.7 No striped multi-peer downloads in v1

Do not split one object into chunks fetched concurrently from multiple peers yet.

Reasons:

- most schools will have 1 Gb/s LANs and small fleets;
- a single peer can usually saturate the destination link;
- multi-source range assembly complicates partial verification and failure recovery;
- the main win is avoiding origin traffic, not maximizing BitTorrent-style swarm throughput.

The protocol should not make future chunking impossible, but it is not a release requirement.

### 14.8 Partial downloads and source switching

A `.part` record stores:

```text
hash
expected_size
bytes_present
last_source
etag
updated_at
```

Because the identity is the expected SHA-256, an interrupted peer transfer can resume from another peer or from the server if the source presents the same immutable object and honors Range.

If a source sends `200` after a Range request, restart the partial from zero unless the response can be proven to represent the identical full object. Preserve the conservative semantics of the current downloader.

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

## 15. Fast change propagation without making every node contact the server

The CDN solves bytes. State propagation needs two related but distinct mechanisms:

1. a signed feed that proves ordered delivery/completeness; and
2. independently versioned signed state documents that can apply urgent or newer state without waiting behind an unrelated screen's missing feed event.

A peer never creates authority. It only relays server-signed material.

### 15.1 State epoch

Every signed Edge state item belongs to a server-managed `stateEpoch`.

`stateEpoch` changes only during an explicit control-plane recovery that intentionally re-anchors authoritative state, such as restoring PostgreSQL to a point older than state already accepted by nodes.

This is distinct from `authorityEpoch`:

- `authorityEpoch` identifies the signing-key generation.
- `stateEpoch` identifies the authoritative control-plane history generation.
- `feedSequence` orders published feed records inside one state epoch.
- `subject.revision` decides freshness for one resource inside one state epoch.

A server restore must not reuse old feed/resource numbers inside the same state epoch with the same signing key. If the restored database is older than an already published checkpoint, the operator performs a direct authenticated re-anchor that creates a new state epoch. Peer relay alone cannot authorize a state-epoch change.

The server persists the current state epoch in backup/recovery metadata. The node persists the newest trusted epoch/checkpoint outside any local state that can be silently reconstructed from peer snapshots.

### 15.2 Why not gossip raw manifests

A peer must not be able to invent:

- a new screen assignment;
- a new configuration;
- a takeover;
- a certificate revocation;
- a Context definition;
- an update authorization.

Peers may relay signed server state and immutable content only.

### 15.3 Server outbox and feed storage

Authoritative domain transactions insert an outbox row in the same PostgreSQL transaction as the domain mutation.

```text
edge_change_outbox
  id                  UUID PRIMARY KEY
  state_epoch         BIGINT
  organization_id     UUID
  type                TEXT
  target_kind         TEXT
  target_id           UUID NULL
  subject_kind        TEXT NULL
  subject_id          UUID/TEXT NULL
  subject_revision    TEXT NULL
  object_hash         TEXT NULL
  payload             BYTEA/JSONB
  created_at          TIMESTAMPTZ
  expires_at          TIMESTAMPTZ NULL
  object_ready_at     TIMESTAMPTZ NULL
  projected_at        TIMESTAMPTZ NULL

edge_feed_state
  state_epoch         BIGINT PRIMARY KEY
  last_sequence       BIGINT
  head_digest         BYTEA NULL

edge_changes
  state_epoch         BIGINT
  sequence            BIGINT
  previous_sequence   BIGINT NULL
  previous_digest     BYTEA NULL
  feed_digest         BYTEA
  outbox_id           UUID UNIQUE
  organization_id     UUID
  type                TEXT
  target_kind         TEXT
  target_id           UUID NULL
  subject_kind        TEXT NULL
  subject_id          UUID/TEXT NULL
  subject_revision    TEXT NULL
  object_hash         TEXT NULL
  payload             BYTEA/JSONB
  signed_envelope     BYTEA
  created_at          TIMESTAMPTZ
  expires_at          TIMESTAMPTZ NULL
  PRIMARY KEY (state_epoch, sequence)
```

The outbox captures the exact immutable authoritative resource revision/generation. A background worker must not re-read the latest mutable resource and label it as an older event.

If the event references an immutable Edge Object, compile/store that exact captured revision first and pin the source publication until object compilation succeeds. Only an object-ready outbox row may be signed into the feed.

The serialized signer-projector locks the installation feed state and, in one transaction:

1. assigns the next sequence inside the current state epoch;
2. includes the current `previousSequence` and `previousDigest`;
3. includes the captured subject revision and already durable object hash/size;
4. canonicalizes and signs the envelope;
5. computes/stores the new feed digest over the canonical signed record chain;
6. inserts `edge_changes`;
7. advances `edge_feed_state`;
8. marks the outbox row projected.

A rollback publishes either the complete next feed position or nothing.

### 15.4 Signed envelope

Conceptual v1 envelope:

```json
{
  "schema": 1,
  "installationId": "...",
  "stateEpoch": "7",
  "sequence": "1234",
  "previousSequence": "1233",
  "previousDigest": "...",
  "feedDigest": "...",
  "type": "screen.presentation.changed",
  "target": {
    "kind": "screen",
    "id": "..."
  },
  "subject": {
    "kind": "screen.manifest",
    "id": "...",
    "revision": "42"
  },
  "object": {
    "sha256": "...",
    "sizeBytes": "18241"
  },
  "issuedAt": "2026-09-22T19:00:00Z",
  "expiresAt": null,
  "authorityEpoch": 1,
  "signature": "..."
}
```

Canonicalize the envelope without `signature` using RFC 8785/JCS, sign those bytes, then attach the encoded signature.

Every potentially 64-bit counter/revision is an unsigned decimal string. Duplicate JSON object keys are rejected before canonicalization. Protocol schemas define unknown-field behavior, UTF-8 requirements, Ed25519 key/signature encoding, Base64/Base64url rules and malformed-input fixtures across Go, Rust, TypeScript and C.

`previousDigest` makes a same-epoch fork detectable. A node that sees the same `(stateEpoch, sequence)` with a different digest reports a feed-fork incident and stops peer advancement until direct server reconciliation.

### 15.5 Feed order versus resource freshness

Feed sequence is delivery/completeness order, not semantic resource freshness.

Every mutable change carries a type-specific signed subject generation. Initial mapping includes:

| Change type | Subject freshness value |
| --- | --- |
| `screen.presentation.changed` | `screen_manifest_state.manifest_version` |
| `screen.configuration.changed` | `screen_config_state.config_revision` |
| certificate/node revocation | revocation generation |
| Context definition/value policy | Context resource generation |
| authority transition | authority epoch/transition generation |

If a later feed position carries an older subject revision than the node has already applied, the node records a stale no-op and still advances feed continuity.

Deletion/removal is represented by an explicit signed tombstone at a newer subject revision. A node does not need to wait for a future snapshot to learn that a mutable resource was removed.

### 15.6 Urgent independently versioned state

A global contiguous feed must not delay security or urgent state behind an unrelated screen event.

At minimum, the server publishes independently versioned signed state documents for:

- certificate-instance revocations and durable-node disablement;
- current screen presentation/configuration state;
- active takeover state where urgency requires it;
- Context definition/rule state.

A node may apply a valid newer signed state document when its resource generation is newer, even if the ordinary feed cursor has a gap. The node does **not** skip the missing feed position; it separately records the newer resource watermark and continues feed recovery.

Revocation state uses this path. A missing presentation event for another screen cannot delay application of a newer revocation generation.

Peer `latestSequence` hints are wakeups only. They never advance `highest_seen_sequence`, state epoch, resource revision or revocation generation. Only a verified authority-signed envelope/checkpoint or direct authenticated server response can do that.

### 15.7 Feed scope and scaling

Do not require every node to download every other screen's payload indefinitely merely to advance its own useful state.

V1 may keep one installation feed for audit/completeness, but implementations must support at least one bounded strategy before broad rollout:

- compact multi-target events for one authoritative mutation that affects many screens;
- target-aware range filtering with signed skip/checkpoint proofs; or
- scoped feed partitions with an installation-level security stream.

The chosen strategy must preserve fork/gap detection without O(N²) fleet fan-out. E7 includes a scale test using an organization-wide change across a representative fleet.

### 15.8 Sequence gaps

Within one state epoch, a feed gap means a published feed position is missing locally.

The node tracks:

```text
state_epoch
last_contiguous_sequence
last_contiguous_digest
highest_verified_sequence
per-resource revision watermarks
```

A gap triggers range recovery. The node does not infer loss from PostgreSQL sequence allocation because protocol positions are assigned only by the serialized signer-projector.

A same-sequence/different-digest record is not a normal gap. It is a fork and requires direct server reconciliation.

### 15.9 Signed snapshot checkpoints

If a node is behind retention, the server returns an authority-signed checkpoint:

```json
{
  "schema": 1,
  "installationId": "...",
  "stateEpoch": "7",
  "scope": {
    "kind": "screen",
    "id": "..."
  },
  "baseSequence": "81234",
  "baseDigest": "...",
  "authorityEpoch": 1,
  "generatedAt": "2026-09-22T19:00:00Z",
  "object": {
    "sha256": "...",
    "sizeBytes": "..."
  },
  "signature": "..."
}
```

Snapshot scope is explicit. Prefer screen-scoped snapshots for ordinary player recovery; use installation/security snapshots only for state that is truly installation-wide.

The immutable snapshot object contains the current applicable projected state and per-resource revision/generation watermarks.

Snapshot creation uses the feed serialization lock plus a consistent PostgreSQL snapshot so:

- every authoritative mutation visible in the snapshot has a feed position at or below `baseSequence`; and
- every mutation not visible in the snapshot receives a feed position above `baseSequence`.

The node verifies state epoch, authority chain, checkpoint signature, base digest and object hash before applying it.

After destructive local DB recovery, peer snapshots are insufficient to establish a new trust anchor. The node first performs direct authenticated server re-anchoring or uses a separately persisted trusted checkpoint that proves the received state is not older than its previous trust state.

Feed/object retention is linked. Objects referenced by the retained replay window and current recovery snapshots remain retained.

### 15.10 Expiry semantics

`expiresAt` is permitted only for change types whose effect is explicitly ephemeral.

Durable configuration, resource tombstones, certificate/node revocation state, authority transitions and state-epoch transitions have `expiresAt = null`.

For a valid ephemeral envelope that has expired, the node verifies it and advances feed continuity but does not activate its effect. If trusted-time uncertainty overlaps the expiry boundary, safety-sensitive effects stay inactive/pending until trusted time or newer signed state is available.

### 15.11 Server WebSocket and peer relay

The authenticated server WebSocket remains a low-latency hint path.

Example hints:

```text
edge.change.available
edge.security.changed
edge.snapshot.available
```

A hint carries bounded identifiers only. It does not become authoritative merely because it arrived over the socket.

Peers relay exact signed bytes. They do not reserialize or resign them.

### 15.12 Change types

Initial signed types include:

```text
screen.presentation.changed
screen.configuration.changed
screen.takeover.changed
screen.command.available          # hint only; command still server-authorized/persistent
edge.security.changed
edge.context.definition.changed
edge.context.value.changed
edge.authority.changed
edge.state_epoch.changed
```

### 15.13 Secrets stay direct

Peer relay must not carry:

- device bearer credentials;
- node private keys;
- Presentation Network passwords/PSKs;
- integration secrets;
- dashboard/session secrets.

The server remains the direct authority for secrets and command execution authorization.

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

### 18.2 Context record

A context candidate is conceptually:

```json
{
  "key": "school.phase",
  "type": "string",
  "value": "lunch",
  "scope": {
    "kind": "organization",
    "id": "..."
  },
  "sourceId": "bell-schedule",
  "sourceRevision": "418",
  "priority": 50,
  "observedAt": "2026-09-22T16:10:00-04:00",
  "expiresAt": "2026-09-22T16:55:00-04:00",
  "freshness": "live"
}
```

Supported v1 value types should be deliberately small:

```text
boolean
integer
number
string
timestamp
duration
string enum
bounded list of scalar values
bounded object with declared schema
```

Do not accept unbounded arbitrary JSON blobs as “context.”

### 18.3 Scopes

Support:

```text
organization
location
display_group
screen
```

Effective value selection uses more-specific scope before less-specific scope when both apply to the current screen.

Suggested precedence:

1. screen;
2. display group;
3. location;
4. organization.

Within the same specificity:

1. higher configured source priority;
2. higher source revision;
3. stable source-ID tie-break.

Do **not** resolve conflicts by whichever machine's wall-clock timestamp looks newest.

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

Locally authored observations use a signed envelope with at least:

```text
nodeId
certificateFingerprint
sourceId
sourceEpoch
sourceSequence
key
scope
value
observedAt
expiresAt
schema
signature
```

`sourceEpoch` is a random 128-bit source-incarnation identifier created when local source state is initialized. `sourceSequence` is a canonical decimal string increasing within `(nodeId, sourceId, sourceEpoch)`.

A new source epoch supersedes the previous authenticated incarnation for that `(nodeId, sourceId)`. Sequence numbers from different epochs are never compared numerically.

Replay watermarks for an old epoch may be deleted only after every observation from that epoch can no longer satisfy the receiver's maximum permitted freshness window and the issuing certificate can no longer make that observation acceptable. Bounded storage alone is not sufficient if pruning would make an old signed packet look new again.

Freshness is receiver-bounded. Each source definition declares a maximum TTL. The receiver computes an acceptance deadline from trusted receive time and clamps any sender-provided `expiresAt` to that policy. A compromised but otherwise authorized node cannot make one sensor value fresh for years by choosing a distant expiry.

The observation signature is accepted only after certificate instance, installation binding, durable node state, current revocation generation, source permission, scope, value schema, epoch and replay state validate.

Server-only Context keys remain impossible for an Edge-local source to claim.

Peer propagation is a low-latency path. Server reconciliation remains able to replace/retire a source epoch and restore canonical policy.

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

Studio provides a Spectrum 2 condition builder:

```text
Show when

[ School phase ] [ is ] [ Lunch ]
           AND
[ Football game today ] [ is ] [ Yes ]
```

The builder stores canonical CEL.

An **Advanced expression** mode may expose the CEL source for administrators/editors who need it.

### 19.3 Validation

The server is the publication gate.

At save/publish time:

1. parse the expression using `cel-go`;
2. type-check against Tilecast's declared context schema;
3. reject unknown keys/functions/type mismatches;
4. reject unsupported constructs outside the Tilecast Edge CEL subset;
5. store source text plus normalized rule metadata;
6. compile/evaluate known test vectors.

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

### 21.2 Per-renderer profiles

Every installed renderer release has a trusted static capability manifest shipped with the signed release. Runtime probes refine availability but do not invent protocol support.

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

Electron has its own profile.

Do not report the union of WPE and Electron capabilities as though one renderer can satisfy every combined requirement. The server may know the node has multiple profiles, but one complete renderer profile must satisfy one prepared presentation contract.

This preserves the current server/player model where `nativePresentationCapabilities` maps capability name to version.

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

Compatibility requires one renderer profile plus current host/runtime capabilities to satisfy the full requirement set.

### 21.5 Reporting

The node reports each renderer profile independently, the active renderer/profile revision, and host capabilities. Studio may summarize them, but server negotiation keeps the distinction.

A renderer process may report runtime evidence after launch. That evidence validates/refines the signed installed profile; it is not the bootstrap source used to decide which renderer binary can be launched.

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

Safe examples:

```text
installation-id=<uuid>
node-id=<uuid>
edge-version=<version>
protocol=1
port=7448
```

Do not include:

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

When a Presentation Network activates, `tilecastd` re-evaluates interfaces but must keep Zenoh and peer blob listeners off that sidecar Wi-Fi.

No peer traffic should accidentally expose Tilecast Edge to AirPlay sender VLANs.

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

If PipeWire capture is not available, retain an explicitly reported unsupported/degraded state. The browser-based path may remain only during Electron transition.

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

### 27.1 `tilecast-edge.service`

Illustrative service properties:

```ini
[Service]
Type=notify
User=tilecast-edge
Group=tilecast-edge
ExecStart=/opt/tilecast-edge/current/bin/tilecastd
Restart=always
RestartSec=2
WatchdogSec=30s
RuntimeDirectory=tilecast-edge
StateDirectory=tilecast-edge
UMask=0077
```

Create `renderer.sock`, `media.sock` and `admin.sock` with dedicated systemd `.socket` units and pass the listening file descriptors to `tilecastd`. Example ownership intent:

```ini
# renderer/media socket units
SocketUser=tilecast-edge
SocketGroup=tilecast-renderer
SocketMode=0660

# admin socket unit
SocketUser=tilecast-edge
SocketGroup=tilecast-admin
SocketMode=0660
```

The Edge service must support the inherited listening descriptors at startup and must not unlink/rebind them itself. This keeps socket ownership independent from `UMask=0077` and avoids granting `tilecast-edge` extra group-management privilege.

Add hardening after testing required hardware access:

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

Do not copy the current helper unit's settings blindly if they would block DRM/I²C/udev access. Build a tested capability matrix.

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

Renderer isolation and display-session ownership must be designed together.

The separate `tilecast-renderer` UID remains the security target, but a system service cannot assume it can connect to a Wayland/X11 socket owned by an arbitrary logged-in kiosk user.

Support explicit host modes:

1. **Dedicated Tilecast compositor/session** — the compositor/session is owned by or grants narrowly scoped access to `tilecast-renderer`. This is the preferred Wayland migration mode.
2. **Existing desktop/session compatibility** — a narrow session bridge or controlled ACL passes only the display/session handles/environment required by the renderer. Do not expose the server bearer credential or Edge identity to the logged-in user session.
3. **Direct DRM/KMS appliance mode** — WPE owns the display directly and no compositor is required. Electron compatibility fallback is unavailable unless the system deliberately transitions to a compositor-backed mode.

Do not claim that a separate system UID plus `WPE_PLATFORM=wayland` is sufficient by itself.

`tilecastd` launches one renderer instance with a random instance generation. It passes only renderer/media sockets, the instance generation, presentation bootstrap data and required display/media device access.

Renderer lifecycle control uses a fixed systemd unit relationship or narrow helper. Do not grant generic systemd manager authority.

The service must not inherit read access to `/var/lib/tilecast-edge/identity` or direct CAS paths.

### 27.5 Safe mode

Preserve the current recovery concept but redefine the layers:

```text
renderer retry
current item retry/skip
re-activate prepared presentation
renderer reload/recreate
renderer process restart
renderer type fallback (WPE -> Electron where available)
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

---

## 28. Renderer architecture and WPE WebKit migration

WPE is a renderer replacement, not a replacement for Tilecast Edge.

`tilecastd` owns the player. WPE renders the presentation.

### 28.1 Target WPE baseline

Target **WPE WebKit 2.54+** and the new **WPEPlatform** API.

Do not build new Tilecast code around:

- legacy `libwpe` embedding;
- WPEBackend-fdo;
- new Cog dependencies.

WPE 2.54 made WPEPlatform stable/default and provides built-in:

```text
WPE_PLATFORM=wayland
WPE_PLATFORM=drm
WPE_PLATFORM=headless
```

This maps almost perfectly to Tilecast:

- `headless`: CI and renderer integration tests;
- `wayland`: development and existing kiosk desktops;
- `drm`: dedicated production signage machines with no compositor.

### 28.2 First-party launcher

Build `apps/edge/renderer-wpe` as a small C11/GLib program using:

```text
wpe-webkit-2.0
wpe-platform-2.0
```

Responsibilities:

- connect to Edge Unix socket;
- negotiate renderer protocol;
- create WPE display/view;
- load trusted Tilecast web renderer assets;
- expose a strict native-to-JS bridge;
- enforce website navigation/permission policies;
- report progress/errors;
- support capture for bounded live preview;
- exit on unrecoverable engine failure so systemd/Edge can recreate it.

It must not contain playlist selection, schedule policy, context merge logic, content downloading, credentials or update logic.

### 28.3 Shared trusted web runtime

Extract the dependency-free DOM interpreter from the current Electron renderer into a shared package:

```text
packages/player-renderer-web
```

Both Electron and WPE load the same trusted renderer assets during migration.

This package should contain:

- image/video presentation DOM;
- transition/crossfade implementation;
- native widget render-tree interpreter;
- layout DOM rendering;
- QR/SVG/chart primitives;
- browser-local clock/countdown visual ticking;
- renderer progress instrumentation;
- safe fallback surfaces.

It should **not** contain server networking, filesystem state or player policy.

### 28.4 Trusted runtime URI scheme

Register explicit trusted runtime/media schemes, for example:

```text
tilecast://runtime/...
tilecast://media/<hash>
```

The runtime handler serves only embedded/versioned trusted resources.

The media handler proxies to `media.sock`; it does not open the CAS path directly.

Remote website origins must not gain cross-origin read access to trusted Tilecast schemes. WebKit blocks cross-origin access to custom schemes unless the embedder explicitly opts into CORS. Tilecast keeps the media/runtime schemes **not CORS-enabled** for remote website contexts.

Tests must prove that an arbitrary remote website cannot:

- fetch `tilecast://media/<hash>`;
- enumerate or probe local hashes through response differences;
- fetch trusted runtime JS/HTML;
- navigate a trusted top-level runtime view;
- receive the native bridge.

Path traversal is impossible because handlers resolve validated identifiers, not filesystem paths.

Large media custom-scheme behavior is an early prototype gate. Before WPE becomes eligible for video, tests must prove Range/seeking, pause/resume, looping, transition reads and cancellation on representative large MP4/H.264 files.

### 28.5 Native/JS bridge

Use WebKit's user-content/script-message APIs for a strict message bridge.

Trusted runtime may call methods corresponding to the renderer IPC contract, e.g.:

```text
ready
progress
itemError
websiteState
previewReady
```

Never expose a generic native invocation function.

Untrusted remote website content must not receive the Tilecast native bridge.

### 28.6 Website playback is the hardest parity area

The current Electron player has useful website isolation/session behavior. WPE does not have Electron's `<webview>` tag/session-partition abstraction.

WPE rollout must explicitly prove:

- top-level host allowlist enforcement;
- remote-page navigation policy decisions;
- cookie policy and clearing;
- per-asset or suitably isolated website data stores/sessions;
- permission denial for microphone/camera/geolocation unless a future typed feature opts in;
- timeout/reload behavior;
- custom user agent;
- fallback image behavior;
- YouTube IFrame API behavior;
- remote-site crash/process termination;
- multiple website placements inside layouts;
- z-order/cropping if separate WebViews are needed;
- WebKit subprocess sandbox enabled before any web process is created;
- no remote-origin access to Tilecast custom URI schemes or native bridge.

The Linux WebKit subprocess sandbox is a release requirement, not optional hardening. If required GPU/media/device access breaks under sandboxing, qualify the minimum explicit sandbox allowances rather than disabling the sandbox globally.

### 28.7 Renderer compatibility selection

Every prepared presentation contains the versioned requirement contract from §21.

`tilecastd` evaluates each installed renderer profile independently. One renderer must satisfy the complete requirement set.

Conceptually:

```text
for renderer in policy_order:
    if renderer.profile + host/runtime probes satisfy all requirements:
        choose renderer
        break
otherwise:
    presentation incompatible
```

The union of WPE and Electron capability maps is never treated as one renderer capability set.

Studio reports a bounded reason when WPE cannot be selected, including the exact missing capability/version or host-mode constraint.

This turns WPE migration into a controlled capability rollout without regressing the current versioned negotiation model.

### 28.8 Renderer preference policy

Effective policy:

```text
preferred: auto | wpe | electron
fallbackAllowed: true/false
```

`auto` is the normal setting.

If an administrator explicitly forces WPE and content requirements are unsupported, Tilecast should report “presentation incompatible” rather than silently omit part of the content.

### 28.9 DRM/KMS

DRM/KMS is the desired dedicated-appliance path because WPEPlatform can render directly with no compositor.

That property changes compatibility behavior: an Electron renderer cannot run as an ordinary Wayland/X11 client when no compositor/session exists.

Define the mode explicitly:

```text
displayMode = wayland_compat | drm_dedicated
```

In `drm_dedicated`:

- WPE can own the display directly;
- Electron compatibility fallback is unavailable unless a tested mode transition starts a compositor/session;
- renderer selection must reject content that requires Electron before tearing down the compositor compatibility environment;
- rollback to a legacy Electron release may require reboot/host-mode restoration, not only a process restart.

Before making DRM default, validate connector selection, modes, hotplug, VT/session ownership, device ACLs, old Intel/Mesa behavior and renderer crash recovery.

### 28.10 Wayland

Wayland is the migration/general-purpose mode where WPE and Electron compatibility can coexist.

WPEPlatform Wayland requires a compositor. Tilecast must therefore own or deliberately integrate with that compositor/session.

Preferred production-compatible migration layout:

```text
Tilecast-managed compositor/session
    ├── WPE renderer as tilecast-renderer
    └── Electron compatibility renderer as tilecast-renderer
```

If Tilecast runs inside an existing user's compositor instead, use the controlled session-bridge/ACL model from §27.4 and treat it as a separate qualification mode.

Do not depend on ambient `WAYLAND_DISPLAY`, `DISPLAY`, or `XDG_RUNTIME_DIR` values that happen to exist in the installer user's shell.

### 28.11 Headless CI

Every WPE renderer PR should run a headless integration suite.

Test at least:

- idle/setup surfaces;
- image;
- video DOM lifecycle using test media;
- widget render trees;
- layouts;
- transitions;
- synchronized item projection;
- website policy decisions with a local fixture server;
- renderer crash/restart;
- preview capture if supported headlessly.

### 28.12 Parity testing

Build a corpus of deterministic renderer fixtures.

For each fixture, run both Electron and WPE and compare:

- semantic renderer events;
- item timing within tolerance;
- DOM/layout assertions;
- screenshot perceptual difference where meaningful;
- error/fallback behavior.

Do not require text rasterization to be pixel-identical across Chromium and WebKit. Use visual tolerances and semantic assertions.

### 28.13 Meaningful progress remains authoritative

WPE changing the browser engine must not weaken Tilecast's existing health model.

`renderer.ready` is not meaningful playback progress.

Progress remains content-aware:

- video position advances;
- image displayed successfully and duration boundaries continue;
- website first meaningful render succeeds;
- layout zones render/rotate as expected;
- item transition occurs;
- bounded health check only for indefinite content where no other signal exists.

### 28.14 WPE process model

Keep WebKit's multi-process model and enable its Linux subprocess sandbox before any web process is created.

The first-party launcher owns:

- WPEPlatform display/view lifetime;
- WebKitWebContext/WebsiteDataManager policy;
- sandbox enablement;
- custom URI handlers;
- navigation/permission decisions;
- native bridge endpoint;
- renderer IPC and instance generation.

It does not own server networking, content authority, scheduling, Context merge, updates, or secrets.

A WebProcess/GPUProcess/network-process crash is renderer health input. `tilecastd` retains authority and may restart/fallback according to the renderer state machine.

## 29. Renderer selection state machine

## 29. Renderer selection state machine

Use an explicit state machine rather than scattered fallback booleans.

Conceptually:

```text
NoRenderer
   ↓
EvaluateRequirements
   ├─ WPE compatible ───────► StartingWPE
   │                            │
   │                          Ready
   │                            │
   │                        unhealthy
   │                            ▼
   │                     RecoveringWPE
   │                            │
   │                     repeated failure
   │                            ▼
   │                    FallbackElectron
   │
   └─ WPE incompatible ────► StartingElectron
```

A renderer fallback event is persisted and sent to Activity with bounded reason codes. After a healthy period or content change, policy may attempt WPE again according to a cooldown.

The fallback must never cause a manifest/content downgrade: both renderers consume the same prepared presentation contract.

---

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

### 30.2 Release signing and compatibility metadata

Keep the existing offline/CI release signing model.

Signed artifact kinds include:

```text
tilecast-edge-linux
tilecast-renderer-wpe-linux
tilecast-renderer-electron-linux
tilecast-wpe-runtime-linux
```

Each byte artifact has independent hash/size metadata.

Release metadata also declares:

```text
component
version
ipcMinProtocol
ipcMaxProtocol
stateSchemaMinReadable
stateSchemaMaxReadable
stateSchemaWritten
requiredWpeRuntimeAbi/version
rollbackCompatibleWith
```

An activation is rejected before promotion if the selected Edge daemon, renderer and private WPE runtime have no compatible protocol/ABI set.

A database migration that makes the previous release unable to read the resulting state may not ship while automatic rollback to that previous release remains part of the safety contract.

### 30.3 Peer prefetch

When a signed release is available:

- release manifest is peerable;
- release artifacts are peerable;
- the soft release seeder may download them once from origin;
- other targeted nodes fetch over peer CDN;
- nodes may prefetch before their maintenance window;
- install does not begin until their persistent deployment state says it is authorized.

### 30.4 Release directory model

For Edge-owned binaries, prefer immutable release directories:

```text
/opt/tilecast-edge/releases/1.3.0/
/opt/tilecast-edge/releases/1.4.0/
/opt/tilecast-edge/current -> releases/1.4.0
/opt/tilecast-edge/previous -> releases/1.3.0
```

Neither `tilecast-edge` nor `tilecast-renderer` should have arbitrary write permission to `/opt/tilecast-edge`.

### 30.5 Privileged promotion

A narrowly scoped root update helper may perform only:

```text
install_verified_release
activate_release
rollback_pending_release
confirm_release
```

Inputs are release IDs/hashes, not arbitrary filesystem paths or commands.

The helper independently checks:

- source path is under Edge's fixed staging directory;
- signed release manifest validates against pinned release public key;
- hash/size match;
- target version path is valid and non-existing or exactly matching;
- installed files have fixed expected names/modes;
- symlinks point only inside `/opt/tilecast-edge/releases`.

The helper must avoid a verify-then-open TOCTOU race. It opens the staged artifact with no-follow semantics, verifies the manifest/hash/size against that opened file descriptor, and copies/installs from the same descriptor or an equivalently pinned inode. A writable path must not be re-opened after verification.

### 30.6 Crash-safe activation and rollback

Activation flow:

```text
download to CAS/staging
      ↓
verify signature/hash/size + compatibility metadata
      ↓
install immutable release dir/runtime bundle
      ↓
record root-owned previous/current/pending rollback metadata
      ↓
run only rollback-compatible state migrations
      ↓
atomically switch current symlink
      ↓
fsync /opt/tilecast-edge parent directory
      ↓
restart Edge service
      ↓
new daemon reports READY
      ↓
stable external confirmation timer remains armed
      ↓
minimum health window + schema/renderer checks
      ↓
confirm release and disarm timer
```

The rollback mechanism lives outside the candidate release and does not depend on opening the candidate SQLite schema.

A stable root-owned confirmation timer/watchdog rolls back a pending release when confirmation does not arrive by the deadline. This handles both crash loops and a daemon that remains alive after `READY=1` but never becomes healthy enough to settle.

Rollback verifies that the previous binary declares the resulting local state schema readable before switching back. If schema rollback is impossible, activation must have been rejected before migration/promotion.

Atomic `current`/`previous` symlink replacement is followed by parent-directory fsync where supported.

### 30.7 Health settlement

Mirror existing update semantics:

- expected version observed;
- daemon uptime reaches at least 120 seconds (or a later documented threshold);
- daemon not in Edge safe/fatal mode;
- renderer can be launched or an expected sleep state is active;
- no pending update error.

Healthy **playback** need not be required to settle an Edge binary update if the screen is deliberately sleeping/no content is assigned, but the local renderer-management path must be functional.

### 30.8 WPE runtime dependency and packaging

Tilecast's renderer baseline is WPE WebKit 2.54+ / WPEPlatform. Do not assume a supported Debian/Ubuntu release provides that runtime merely because WebKitGTK or an older WPE package exists. The installer must probe the exact WPEPlatform API/runtime version before enabling WPE.

For general-purpose installations, support one of two explicit modes:

1. a distribution/repository whose packaged WPE WebKit satisfies Tilecast's tested baseline; or
2. a Tilecast-owned, versioned WPE runtime bundle installed under a private immutable prefix and updated through a defined signed release path.

Do not overwrite arbitrary distribution libraries in place and do not silently mix an old distro WPE runtime with a launcher compiled for WPEPlatform 2.54+. Mesa/GStreamer and other host graphics/media dependencies may remain distribution-owned initially, but their tested compatibility range must be reported.

As of this RFC date, Ubuntu's public package index does not provide a WPE 2.54 package for Ubuntu 26.04, so Ubuntu support cannot rely on the stock WPE package alone. This is a packaging requirement, not a reason to lower the WPEPlatform baseline.

A later Tilecast appliance image can make the entire OS/runtime atomic.

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

Suggested files/packages within the domain:

```text
authority.go          # signing/verification material management
certificates.go       # node issuance/renewal/revocation
changes.go            # append/read/prune signed feed
objects.go            # immutable object metadata/storage
snapshots.go          # state snapshot generation
context.go            # definitions/rules/server values
status.go             # current Edge node status projection
settings.go           # organization Edge policy
```

HTTP handlers remain thin in `internal/httpapi`.

### 32.1 Database migrations

Add migrations, not edits to shipped migrations.

Suggested tables:

#### `edge_node_certificates`

```text
id
screen_id
player_installation_id
serial_number
public_key_fingerprint
not_before
not_after
revoked_at
revocation_reason
created_at
```

Do not store node private keys.

Certificate rows represent certificate **instances**. Revocation by `serial_number`/`public_key_fingerprint` is distinct from disabling the durable `player_installation_id`. Re-enrollment/renewal may revoke one certificate row without disabling the node. Node disablement should reuse the authoritative existing player/device lifecycle state where possible rather than inventing a conflicting second active flag.

#### `edge_node_status`

Current projection only:

```text
screen_id PK
edge_version
renderer_kind
renderer_version
mesh_state
peer_count
mesh_endpoints
cache_used_bytes
cache_limit_bytes
clock_source
clock_offset_ms
clock_uncertainty_ms
capability_revision
last_applied_change_sequence
highest_seen_change_sequence
snapshot_base_sequence
last_edge_contact_at
last_mesh_change_at
last_error_code
updated_at
```

Do not append every heartbeat into this table.

#### `edge_changes`

As described above, stores sequence and canonical signed envelope.

#### `edge_objects`

```text
sha256 PK
kind
size_bytes
storage_key
content_type
peerable
created_at
expires_at NULL
```

#### `edge_context_sources`

Server configuration for typed sources, scopes and priorities.

#### `edge_context_rules`

```text
id
target_kind
target_id
name
expression
schema_version
enabled
created_by
updated_by
created_at
updated_at
```

Published presentation revisions should reference immutable compiled/context-rule versions where reproducibility matters rather than silently changing behavior under an already-approved publication.

#### `edge_settings`

Prefer extending the existing typed settings registry when the setting fits organization/group/screen policy. Add a dedicated table only for state that genuinely is not a setting-registry value.

### 32.2 Current status vs history

Meaningful Edge events belong in existing Activity/incident infrastructure:

```text
edge.peer_integrity_failure
edge.mesh_unavailable
edge.certificate_renewal_failed
edge.renderer_fallback
edge.ptp_lost
edge.context_source_stale
edge.update_rollback
```

Do not invent a second parallel audit/history subsystem for Edge.

---

## 33. Server API

Preserve the existing separation between dashboard APIs and player-authenticated APIs.

### 33.1 Player/Edge endpoints

Suggested namespace:

```text
/api/v1/player/edge/...
```

Endpoints:

```http
POST /api/v1/player/edge/enroll
POST /api/v1/player/edge/renew
GET  /api/v1/player/edge/config
GET  /api/v1/player/edge/changes?after=<seq>&limit=<n>
GET  /api/v1/player/edge/objects/<sha256>
POST /api/v1/player/edge/status
POST /api/v1/player/edge/context/observations
```

Every route uses the existing player bearer credential. Dashboard cookies are not accepted.

Strictly bound:

- request sizes;
- query limits;
- number of observations/status entries;
- strings/enums;
- timestamps;
- certificate/CSR sizes.

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

A bounded status model might contain:

```json
{
  "schemaVersion": 1,
  "edgeVersion": "1.0.0",
  "nodeId": "...",
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
  "changeFeed": {
    "lastAppliedSequence": "81234",
    "highestSeenSequence": "81234",
    "snapshotBaseSequence": "80000"
  },
  "cache": {
    "usedBytes": 13812412342,
    "limitBytes": 17179869184,
    "peerServedBytesDelta": 12345678,
    "originFetchedBytesDelta": 1234
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
    "state": "healthy",
    "fallbackReason": null
  },
  "capabilityRevision": 42
}
```

Feed sequence fields are canonical decimal strings on the wire. Counters are deltas/rollups, not ever-growing event payloads. The server bounds and validates advertised endpoint count/address/port values before using them as seed hints.

---

## 35. Backward compatibility

Edge must coexist with:

- existing Android players;
- existing Electron Linux players not yet upgraded;
- Edge-enabled Linux players using Electron renderer;
- Edge-enabled Linux players using WPE renderer.

### 35.1 Server behavior

All new fields/endpoints are capability gated.

A legacy player continues receiving current manifests, config and socket hints exactly as today.

An Edge-enabled player advertises a protocol/capability marker during hello/status, allowing the server to expose Edge object/change-feed behavior.

### 35.2 Mixed display groups

Display group synchronization must remain correct across old/new players.

Do not change shared playback epoch semantics merely to benefit Edge. Edge should consume the same server-defined playback anchor and use its improved Clock Authority locally.

If an optional low-latency mesh hint reaches Edge members first, legacy members still converge through the existing server path. The group must not depend on every member being Edge-enabled.

### 35.3 Android future participation

Do not require Zenoh in Android v1.

Later options:

- Android receives server-signed change feed but not peer serving;
- Android participates in HTTPS peer CDN discovery through server hints;
- Android runs a compatible Zenoh library if operational/size constraints justify it.

These are future decisions. Linux Edge must stand on its own.

---

## 36. Tilecast Studio: Spectrum 2 Edge workspace

The Edge UI must be implemented against the Spectrum 2 migration, not the legacy `components/ui` layer currently present on `main`.

### 36.1 Dependency rule

When implementation begins, use the project's established Spectrum 2 dependency/import convention. Current upstream examples use `@react-spectrum/s2` components such as `SideNav`, `TableView`, `StatusLight`, `Meter`, `ProgressBar`, `Tabs`, `InlineAlert` and `ContextualHelp`.

Do not add:

- new Lucide icons for Edge once the Spectrum migration has an S2 icon path;
- a bespoke Edge design token set;
- another global Edge CSS sheet duplicating S2 primitives;
- custom status pills where `StatusLight` or S2 semantic components fit;
- a fake graph/topology visual just because this is called a fabric.

### 36.2 Information architecture

Edge is an operational workspace, not twenty new top-level routes.

Recommended product navigation:

```text
Operations
  Screens
  Edge
  Activity
```

Edge workspace:

```text
/edge                 Overview
/edge/nodes           Nodes
/edge/nodes/:id       Node detail
/edge/content         Content delivery
/edge/context         Context
/settings/edge        Edge settings
```

Keep configuration under Settings when it is organization policy. Keep current operational state under Edge.

### 36.3 Edge overview

The overview should show only measurements the backend actually provides.

Example composition:

```text
Tilecast Edge
Fabric healthy                                      ● Healthy
7 of 7 Edge nodes mesh-present

Nodes                       Content delivery
7 mesh-present              93% of eligible bytes from peers
0 degraded                  34.8 GB origin traffic avoided

Clock                       Context
6 synchronized              14 effective values
1 degraded                  1 stale source

Recent Edge activity
Library      Served 486 MB to Cafeteria             4 sec ago
Office       WPE renderer recovered                  1 min ago
Cafeteria   PTP synchronization lost                6 min ago
```

Do not show invented “health scores,” percentages without defined denominators, or projected savings.

### 36.4 Status semantics

Use `StatusLight` with visible labels. Spectrum guidance explicitly requires a label; color alone is insufficient.

Suggested semantic mapping:

```text
positive     Healthy / Synchronized / Available
notice       Degraded / Stale / Falling back
negative     Failed / Blocked / Integrity failure
neutral      Unsupported / Not configured
informative  Updating / Preparing / Discovering
```

The server supplies semantic state; React should not duplicate complex thresholds.

### 36.5 Nodes page

Use Spectrum 2 `TableView` because nodes are comparison-heavy operational data.

Columns:

```text
Name
Server status
Mesh status
Renderer
Peers
Cache
Clock
Edge version
Needs attention
```

Do not cram raw capability JSON into the table.

Rows link to node detail.

Filters:

```text
Status
Renderer
Clock source
Capability problem
Version
Location/group (using existing Tilecast resources)
```

Bulk actions should reuse the S2 TableView/ActionBar pattern only for safe operations that already have server-side previews and authorization, such as `Run Edge self-test` or an update deployment action.

### 36.6 Node detail

Use related tabs:

```text
Overview
Capabilities
Network
Content
Audio & Inputs
System
```

Spectrum 2 Tabs automatically handle constrained-width overflow, which is useful on smaller Studio windows.

#### Overview

Show:

- live preview/current presentation from existing screen system;
- server and mesh presence separately;
- renderer and fallback reason;
- Edge version;
- clock source/quality;
- peer count;
- cache usage;
- last healthy playback;
- latest relevant incidents.

#### Capabilities

Group by category with state + provider + safe reason.

Example:

```text
Display control
● HDMI-CEC power             Available · cec-ctl
● DDC brightness             Available · ddcutil
○ DDC volume                 Unsupported by display

Rendering
● WPE DRM/KMS                Available · WPE 2.54.0
● H.264 hardware decode      Available
! Isolated website runtime   Electron fallback required
```

#### Network

Show:

- server path;
- selected Edge interface;
- mesh endpoint;
- peer count;
- multicast discovery state;
- configured/static seeds;
- Presentation Network state in the existing secure model;
- certificate expiry/fingerprint suffix safe for diagnostics.

Never show Wi-Fi PSKs or full device credentials.

#### Content

Show:

- cache used/limit/free-space reserve;
- pinned bytes;
- peer vs origin bytes for the selected recent time window;
- active transfers;
- recent integrity/fallback events.

Use `ProgressBar` for an active system operation such as a file transfer. Use `Meter` for a quantity such as cache utilization. Spectrum distinguishes system progress from quantities.

#### Audio & Inputs

Show real PipeWire outputs/inputs and registered typed sensor adapters.

Controls are capability gated. A missing PipeWire session should render an explanatory `InlineAlert`, not a broken empty selector.

#### System

Show:

- uptime;
- systemd watchdog state;
- renderer service state;
- CPU architecture;
- kernel;
- storage free;
- Edge process memory;
- WPE runtime/Mesa/GStreamer versions where reported;
- last cold boot verification if retained from existing reliability behavior.

### 36.7 Content delivery page

This page answers one question: **how effectively is Edge distributing content?**

Metrics with precisely defined denominators:

```text
Peer bytes served
Peer bytes received
Origin bytes received
Peer-hit ratio by eligible bytes
Peer transfer success rate
Median peer throughput
Cache used / limit
Integrity failures
```

A peer-hit ratio must exclude bytes that were never peer-eligible, or its meaning becomes misleading.

Active transfer rows:

```text
Object / safe content label
Source node or Origin
Destination
Bytes / total
Rate
State
Started
```

Avoid showing raw SHA-256 by default; make it available in technical details/copy action.

### 36.8 Context page

Two views:

#### Current context

`TableView` columns:

```text
Key
Value
Scope
Effective source
Freshness
Observed
Expires
```

Example:

```text
school.phase              lunch       Organization   Bell schedule     Live
school.period             4           Organization   Bell schedule     Live
events.football_game      true        Organization   Calendar          Live
weather.condition         rain        Organization   Weather           4m ago
cafeteria.noise           71.4        Location       Cafeteria sensor  Live
```

#### Rules

Show target, friendly summary, status and advanced CEL source on demand.

The rule editor starts with the visual condition builder. `ContextualHelp` explains freshness, precedence and advanced expressions next to the relevant controls rather than hiding all guidance in docs.

### 36.9 Edge settings

Recommended sections:

```text
Fabric
Content delivery
Discovery & interfaces
Context
Clock
Hardware & sensors
Renderer
Updates
```

Settings should expose safe policy, not transport internals that administrators should not need.

Examples:

Fabric:
- Enable Edge fabric
- Static seed endpoints (advanced)
- Mesh listen port (advanced)

Content delivery:
- Enable peer delivery
- Cache limit
- Reserved free space
- Max outbound peer transfers
- Max inbound download concurrency

Clock:
- Prefer host PTP when synchronized
- Managed PTP (future/experimental, off)

Renderer:
- Auto / Prefer WPE / Prefer Electron
- Allow compatibility fallback

Sensors:
- globally allow local sensor providers;
- explicit mappings/enabled devices.

### 36.10 Empty/degraded states

Examples:

- No Edge nodes yet: explain that Linux Edge appears after upgraded pairing/installation, with a path to install documentation.
- Multicast unavailable but seeds working: `notice`, not `negative`.
- Peer CDN disabled: neutral “Origin delivery only.”
- PTP absent: neutral; NTP/server clock is expected fallback.
- PipeWire absent: capability-specific neutral/notice, not whole-node failure.
- WPE unsupported presentation: show Electron fallback as a normal compatibility state unless fallback itself fails.

### 36.11 Activity/Incidents integration

Do not create an “Edge logs” page that duplicates Activity.

Add Edge categories/links to the existing Activity system. Node detail can embed filtered recent entries.

Incident derivation remains server-side using bounded measurements and hysteresis.

---

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
cache_bytes
cache_pinned_bytes
cache_evictions
change_sequence_lag
context_live_values
context_stale_values
clock_offset_ms
clock_uncertainty_ms
renderer_restarts
renderer_fallbacks
edge_uptime_seconds
```

Send current gauges/counter deltas through the existing telemetry architecture. The server's Prometheus-compatible fleet health can expose server-side aggregate metrics.

### 38.3 Activity

Activity records meaningful state transitions, not packet noise.

Good events:

```text
Edge joined fabric
Edge lost all peers for N minutes
Renderer fell back WPE → Electron
WPE restored after cooldown
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
20. Renderer/admin IPC authority is derived from separate OS identities, socket permissions and peer credentials; a renderer cannot self-declare an admin role.
21. Renderer media access is limited to the daemon-issued active/prepared hash capability set; renderer processes cannot open the Edge state/CAS tree directly.
22. A CA-valid peer cannot impersonate another node's logical identity/keyspace, and outbound peer trust is installation-CA-only.
23. Feed sequence proves delivery completeness but never overrides a newer signed resource revision.
24. Snapshot recovery resumes only from an authority-signed base sequence consistent with the state contained in that snapshot.
25. Locally authored Context observations are signed, source-scoped, epoch-scoped and replay-protected.
26. A malformed optional Edge heartbeat field cannot suppress ordinary player contact/status processing.

---

## 40. Data retention and privacy

### 40.1 Local

Retain:

- active/previous configuration;
- current and pending presentation bundles;
- CAS objects according to policy;
- bounded server change log required for offline continuity;
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

## 41. Migration strategy: no flag day

The migration is a sequence of fenced ownership transfers. A local marker alone is not enough because the old and new process can crash/restart independently while sharing one server bearer credential.

### 41.1 Migration phases

```text
Today
Electron owns player + renderer
        │
        ▼
Phase A
Electron owner + shadow tilecastd
        │
        ▼
Phase B
server fences ownership to tilecastd; Electron renders
        │
        ▼
Phase C
Edge fabric/CDN/context active; Electron renders
        │
        ▼
Phase D
WPE available in Wayland compatibility mode
        │
        ▼
Phase E
WPE default where one renderer profile satisfies content
        │
        ▼
Phase F
optional DRM dedicated mode / Electron retirement after parity
```

### 41.2 Shadow mode

Shadow mode may:

- open its own SQLite DB;
- report local system capabilities through a non-owner/bootstrap path;
- test watchdog/systemd/socket plumbing;
- inspect existing player state read-only;
- send comparison diagnostics.

Shadow mode does not read or copy the active player bearer credential and does not enroll a production Edge node certificate through that credential.

If early mesh/certificate testing is required, use a distinct one-time installer/bootstrap enrollment grant whose scope is limited to certificate enrollment and expires after use. Do not make two concurrent processes owners of the bearer credential.

Shadow mode must not execute server commands, activate content, update the player, mutate Presentation Network state, or own the legacy cache.

### 41.3 Server ownership fencing

The server issues a monotonically increasing `playerOwnerGeneration` when ownership changes.

All owner-sensitive Linux player traffic carries the current generation, including:

- authenticated WebSocket ownership;
- command polling/ack/result;
- manifest/config owner status;
- update execution/reporting;
- state-changing Edge owner endpoints.

Once generation N+1 is committed, generation N is rejected for owner-sensitive operations even if an old process still has the bearer credential.

The bearer credential authenticates the device. The owner generation fences the currently authorized runtime process generation.

A connection lease/session token derived from the owner generation may be used for ordinary calls, but it cannot outlive or bypass a newer server owner generation.

### 41.4 Credential handoff

Preferred sequence:

1. Electron stops owner-sensitive activity and reports quiesced state.
2. installer/controlled handoff moves or copies the existing credential into Edge's protected identity path without logging it.
3. `tilecastd` verifies server installation identity.
4. `tilecastd` requests a new owner generation using the existing credential and a handoff nonce/record.
5. server atomically commits Edge owner generation N+1.
6. generation N traffic from Electron is now rejected.
7. `tilecastd` authenticates normal owner traffic with generation N+1.
8. Electron restarts as renderer-only client.

If the server does not commit step 5, legacy generation N remains authoritative and rollback removes the uncommitted Edge copy.

A fresh Edge install pairs directly through `tilecastd`.

### 41.5 Cache migration

Do not re-download current media unnecessarily.

Migration tool:

- enumerate legacy cache entries;
- correlate with active/pending manifest variant metadata;
- verify size + SHA-256;
- import only verified files;
- create blob/reference/pin metadata transactionally;
- keep legacy cache until Edge ownership checkpoint is confirmed;
- remove legacy cache in a later cleanup release.

### 41.6 State migration and anti-rollback

Importers cover server identity, credential state, active/pending manifest/config, clock offset, supervisor state, playback checkpoint, command idempotency and update staging metadata.

Each importer is versioned/idempotent. Keep originals until Edge writes a confirmed checkpoint.

The trusted Edge checkpoint/state epoch is not reconstructed from arbitrary peer state after destructive DB recovery.

### 41.7 Command semantics

Do not promise generic exactly-once physical side effects.

Every command type declares one execution class:

- **idempotent/reconcilable** — safe to retry until confirmed;
- **at-most-once initiation** — persist the intent/idempotency record before triggering a disruptive action;
- **retryable with state reconciliation** — effect can be checked and safely converged.

Local idempotency records remain at least as long as the server can redeliver the command or until a newer owner/command epoch proves the command cannot reappear. Count-only trimming is not sufficient.

After destructive local command-state recovery, disruptive command consumption remains disabled until direct server reconciliation or a new owner generation establishes a safe boundary.

### 41.8 Rollback during transition

Rollback to the legacy player is fenced like forward handoff.

The server issues a newer owner generation to the legacy runtime. An old Edge daemon that later wakes with the same bearer but an older generation cannot resume commands/updates.

Rollback must preserve assignments/groups/history and must account for display host mode. A machine already converted to compositorless DRM may require explicit restoration of a compatible compositor/session before a legacy Electron binary can render.

Once the server records the newer legacy owner generation, Edge certificates may remain dormant unless node/device revocation requires otherwise.

## 42. Implementation roadmap

This roadmap is intentionally granular. Prefer a sequence of reviewable PRs over one enormous Edge branch.

The milestone numbers below are Edge milestones and do not replace Tilecast's existing historical product milestone numbering.

---

### E0 — Canonical RFC and protocol scaffolding

**Goal:** merge the architecture/contracts before runtime code begins.

### E0.1 Add this document

Repo path:

```text
docs/tilecast-edge.md
```

Update:

- `docs/architecture.md` with the Edge boundary;
- `README.md` only after Edge is actually available;
- `AGENTS.md` with Rust/Edge conventions once code exists.

### E0.2 Protocol package

Create:

```text
packages/edge-protocol/
  schemas/
    ipc-v1.schema.json
    capabilities-v1.schema.json
    context-v1.schema.json
    node-message-v1.schema.json
    change-envelope-v1.schema.json
    snapshot-envelope-v1.schema.json
    presentation-bundle-v1.schema.json
  fixtures/
    valid/
    invalid/
    cel/
```

Decide canonical signed encoding in this milestone. Recommended: JCS-canonical JSON because contracts remain inspectable and the server/dashboard ecosystem already understands JSON. Add golden-byte tests in Go and Rust.

### E0.3 Architecture tests/docs

Document:

- port defaults;
- key hierarchy;
- file paths;
- service users/groups;
- Edge keyspace;
- security invariants;
- downgrade compatibility.

### E0 exit criteria

- Go and Rust test code independently produce identical canonical bytes/signature verification fixtures, including the rule that `signature` itself is excluded from signed canonical bytes.
- Signed protocol counters that can exceed the JSON safe-integer range are decimal strings, with cross-language fixtures above 2^53.
- Change-feed fixtures prove projector-assigned contiguous positions and signed `previousSequence` chaining; PostgreSQL `SERIAL`/sequence allocation is not the protocol order.
- Change fixtures prove feed sequence and resource revision are independent and that a later feed position cannot roll a resource back.
- Snapshot fixtures define a signed `baseSequence` checkpoint and per-resource revision watermarks.
- IPC schema has explicit maximum frame and protocol negotiation rules.
- IPC authorization fixtures prove renderer/admin roles are derived from socket + OS peer identity rather than client-supplied role text.
- Renderer-media fixtures prove only active/prepared hashes can be read through `media.sock`.
- A checked-in Zenoh mTLS fixture covers listener and connector credentials, installation-CA-only outbound trust, certificate expiry handling and logical node binding.
- No implementation PR has to guess a trust boundary.

---

### E1 — Rust workspace and daemon skeleton

**Goal:** a packaged, supervised, unprivileged daemon with no player ownership yet.

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

Shadow mode only.

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

### E2 — Local IPC and Electron renderer split

**Goal:** establish the daemon/renderer boundary while Electron still owns normal player behavior.

### E2.1 IPC implementation

Implement Rust server and TypeScript client with shared fixtures.

Tests:

- oversized frame rejected;
- malformed JSON rejected;
- wrong role rejected;
- unsupported protocol rejected;
- reconnect/resubscribe works;
- slow client cannot unboundedly buffer daemon memory;
- peer credentials validated.

### E2.2 Extract shared renderer assets

Move the current dependency-free renderer into `packages/player-renderer-web` without behavior changes.

Electron's BrowserWindow loads the extracted bundle.

### E2.3 Renderer event adapter

Electron sends progress/error/preview events over Edge IPC in shadow/dual-report mode, while existing runtime still controls content.

Compare Edge-observed events to existing in-process callbacks in tests.

### E2 exit criteria

- Electron screenshots/playback fixtures are unchanged within tolerance;
- Edge can observe renderer health/progress without owning server connection;
- IPC reconnect does not force content reload unless state actually changed.

---

### E3 — Edge identity, central server client and ownership handoff

**Goal:** `tilecastd` becomes the Linux player's authoritative network/state process; Electron becomes renderer-only.

### E3.1 Port server client logic

Implement Rust equivalents of current:

```text
server URL normalization/policy
system identity verification
pairing/enrollment
credential storage
REST client
WebSocket hello/ping/liveness/reconnect
manifest/config reconciliation
commands polling/ack/result
```

Maintain protocol compatibility with current Go server before adding new Edge-specific APIs.

### E3.2 Credential migration

Implement the transactional handoff described in §41.

Server records a capability/protocol marker indicating Edge owns the Linux player's connection.

### E3.3 Durable commands

Port idempotency behavior before any disruptive command is enabled.

Tests must include crash at each boundary:

```text
fetched → acknowledged → persisted idempotency → executed → result reported
```

A restart must never execute a disruptive command twice.

### E3.4 Manifest/config state

Port pending/current/previous configuration and active/pending presentation semantics into SQLite/CAS abstractions while still downloading from origin only.

### E3.5 Electron renderer-only mode

Remove from Electron ownership:

- player bearer credential;
- server WebSocket;
- manifest/config polling;
- command polling;
- server clock calculation;
- update authority.

Electron consumes prepared presentations over IPC.

### E3 exit criteria

- server sees identical expected player lifecycle/status;
- all existing Linux integration tests adapted/passing;
- offline cached startup works with Edge owning state;
- Electron can be killed/restarted without server disconnect;
- `tilecastd` can be restarted without corrupting renderer/current content state;
- legacy rollback path verified.

---

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

### E5 — Edge certificate authority and Zenoh mesh

**Goal:** secure peer discovery/presence with no CDN yet.

### E5.1 Server authority

Implement:

- Edge CA generation/storage;
- Edge dynamic authority key generation/storage;
- enrollment/renew endpoints;
- node certificate DB;
- revocation generation;
- authority public fingerprint in Edge config.

### E5.2 Node enrollment

Generate key locally; issue cert; atomic storage; rotation scheduler.

### E5.3 Zenoh

Embed peer session with:

- mTLS;
- TLS-only protocol whitelist;
- multicast scouting;
- gossip;
- static/server seed support;
- permitted-interface selection;
- Presentation Network exclusion.

### E5.4 Liveliness and node summary

Publish liveliness token and bounded summary/capability revision.

### E5.5 Admin visibility

Server receives current mesh status through ordinary Edge status reporting.

### E5 exit criteria

- two fresh nodes discover each other with no manual seed on same LAN;
- unauthorized machine running Zenoh cannot establish Edge peer session;
- valid cert from another Tilecast installation is rejected;
- a publicly trusted non-Tilecast certificate is rejected on outbound Zenoh connection even with IP/hostname verification disabled;
- multicast-blocked nodes connect using configured seed + gossip;
- revoking one superseded certificate does not disable a newly issued certificate for the same durable node;
- disabling a node rejects all of that node's certificate instances;
- certificate-instance revocation and durable-node disablement stop new matching sessions and tear down/reject data from already-connected matching peers;
- CA-valid certificate from one node cannot be used to publish or answer as another node ID;
- node-originated keyspace/payload identity is verified even if Zenoh ACL cannot express a dynamic own-node rule;
- TLS certificate validity behavior under bad host wall time matches the documented Clock Authority integration/degraded path;
- Presentation Network activation does not move mesh listener/traffic onto Wi-Fi sidecar.

---

### E6 — Peer CDN

**Goal:** verified local media/object distribution.

### E6.1 Peer HTTPS server

Implement fixed HEAD/GET Range endpoints with mTLS.

Fuzz Range parser and path handling.

### E6.2 Zenoh object query

Implement exact `has` queryable plus best-effort cache add/evict hints.

### E6.3 Source selector

Implement local → peers → origin fallback with rolling peer scores and cooldowns.

### E6.4 Bandwidth/limits

Configuration:

```text
max inbound downloads
max outbound peer transfers
max outbound bytes/sec optional
peer source timeout
failure cooldown
```

Defaults should work on low-end mini PCs without starving playback.

### E6.5 Metrics

Add peer/origin byte counters and transfer results.

### E6 exit criteria

- a second screen prepares a large object from first screen with origin transfer count zero;
- partial transfer resumes from a different peer/origin only after exact `Content-Range` validation;
- concurrent requests for the same hash share one local transfer and never race on the partial file;
- a peer endpoint presenting a different valid installation node certificate than the advertised node ID is rejected;
- malicious/corrupt peer bytes never enter CAS;
- disabling peer CDN immediately reverts to origin without affecting playback;
- serving peers cannot read non-peerable objects;
- 1+ GiB transfer soak does not cause renderer stalls on reference hardware.

---

### E7 — Signed Edge Change Feed and immutable Edge Objects

**Goal:** a peer can relay an authoritative server change and its prepared state so other nodes do not need an immediate origin round trip.

### E7.1 Server outbox and `edge_changes`

Insert an unsequenced Edge outbox row in the same PostgreSQL transaction as the authoritative domain mutation.

Do not create a race where a playlist revision commits but its Edge change can be permanently lost, and do not assign protocol order with `BIGSERIAL` in that domain transaction.

The outbox row captures the authoritative subject revision/generation in the domain transaction. If the change needs an immutable object, an object compiler first builds the **captured revision**, stores/verifies its bytes, and marks the row object-ready. It must not compile the latest mutable state at worker execution time.

A serialized/locked deterministic signer-projector claims only ready rows and, in one transaction:

1. locks the installation's `edge_feed_state`;
2. assigns `sequence = last_sequence + 1`;
3. sets signed `previousSequence = last_sequence`;
4. includes the captured subject revision/generation and already-durable object hash/size;
5. canonicalizes the unsigned envelope;
6. signs it;
7. inserts the final `edge_changes` row;
8. advances `edge_feed_state.last_sequence`;
9. marks the outbox row projected.

A projector crash/rollback therefore publishes either the complete next feed position or nothing. It cannot leave a permanent protocol hole caused by PostgreSQL sequence allocation. Projection order does not redefine resource freshness; consumers use the signed subject revision to reject stale rollback.

### E7.2 Presentation bundle compiler

Create immutable object from existing manifest assembly logic rather than duplicating scheduling/content resolution rules.

The compiler should call/shared-package the same domain services used by `/player/manifest`.

### E7.3 Peer relay

Implement:

- latest sequence hint;
- peer missing-range query;
- server fallback;
- contiguous apply;
- replay after restart;
- retention/snapshot fallback.

### E7.4 Fast propagation

When a node sees `manifest.changed` or new Edge sequence from server, publish the signed hint immediately after verification.

### E7 exit criteria

Test scenario:

```text
A, B, C online
only A can reach Tilecast Server
server publishes new presentation
A receives signed change/object
B and C learn change from A
B/C fetch bundle/media from A/peers
B/C activate correct server-authorized revision
```

Also test:

- A sends altered envelope → rejected;
- B receives sequence gap → does not silently skip;
- revision 13 projects before revision 12 → both feed positions advance, final applied resource remains revision 13;
- signed expired event advances feed continuity but does not activate its expired effect;
- stale screen-targeted bundle reaches wrong screen → cached if allowed, never applied;
- committed feed row never references a not-yet-durable object;
- snapshot checkpoint is built from a database view whose visible mutations are all at/below its signed base sequence;
- objects referenced by retained feed/snapshot state cannot be garbage-collected;
- server reconnect reconciles to identical state.

---

### E8 — Context Engine and CEL

**Goal:** shared typed context works online/offline and across peers.

### E8.1 Server schema/API

Implement context source definitions, values and rules.

### E8.2 Local store/merge

Implement scope/priority/revision/freshness algorithm in Rust with golden fixtures. Local signed observations use `sourceEpoch` + decimal-string `sourceSequence`; reinstall/reset creates a new epoch while replay state for recent old epochs remains bounded/persistent.

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
- remove client ownership from Electron;
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

### E10 — Clock Authority and PTP reporting

**Goal:** explicit synchronization quality with existing playback semantics preserved.

### E10.1 Clock module

Port server-offset logic, monotonic playback anchor and timezone/clock transition detection.

### E10.2 Host sync inspection

Detect NTP/chrony/system synchronization in a provider-neutral way where practical.

### E10.3 PTP

- detect PHC/ptp4l;
- observe configured state;
- optionally read allowed management status;
- no auto-grandmaster;
- report source/offset/uncertainty.

### E10.4 UI/API

Expose quality, not just a `ptp: true` boolean.

### E10 exit criteria

- a 30-second wall-clock jump does not make active synchronized video jump 30 seconds;
- schedules reevaluate correctly after clock correction;
- PTP loss falls back to next authority and reports transition;
- nodes without PTP behave exactly as existing corrected-clock players.

---

### E11 — Edge-managed updates and peer release seeding

**Goal:** update daemon/renderers safely and efficiently.

### E11.1 Release workflows

Add CI build/sign/publish pipeline for Edge artifacts.

Requirements mirror current Linux release workflow:

- release version matches manifest;
- stable release includes current main unless explicit hotfix override;
- signed release metadata;
- hashes/sizes verified after build;
- signing keys ephemeral in CI;
- artifacts reproducibly named.

### E11.2 Server update domain

Extend release model/deployment target capabilities for Edge components without breaking Android/current Linux records.

### E11.3 Peer delivery

Update artifacts use CAS/peer CDN.

### E11.4 Atomic install/rollback

Implement immutable release dirs and external rollback helper.

### E11 exit criteria

- 7-node deployment downloads artifact from origin once in the ideal LAN case;
- canary failure pauses rollout;
- power cut before/after symlink switch boots a valid current or previous release;
- repeated new-release crash causes automatic rollback;
- rollback is visible in Studio/Activity.

---

### E12 — WPE renderer: headless and Wayland experimental

**Goal:** establish WPE rendering without making it default.

### E12.1 Launcher

Build C/GLib WPEPlatform launcher and Unix IPC bridge.

### E12.2 Shared renderer runtime

Run extracted trusted browser renderer in WPE.

### E12.3 Content support wave 1

Required:

```text
idle/setup/safe surfaces
images
H.264 video
native widgets/render trees
basic layouts without remote websites
transitions
synchronized playback
branding/plugins that do not require unsupported browser integrations
```

### E12.4 Headless CI

Add parity corpus.

### E12.5 Wayland field mode

Enable opt-in renderer policy on selected screens.

### E12 exit criteria

- reference presentations pass semantic parity suite;
- 24-hour Wayland soak on reference old hardware;
- WPE failure automatically falls back/recover according to policy;
- unsupported requirement automatically selects Electron under `auto`.

---

### E13 — WPE websites, YouTube and advanced parity

**Goal:** remove the largest compatibility blocker.

### E13.1 Website security prototype

Prove and document:

- navigation allowlist;
- permission policy;
- cookie/data isolation strategy;
- clearing/reload/timeout;
- crash recovery;
- fallback behavior.

If isolated multiple website surfaces require an embedder-level composition design, implement that deliberately rather than weakening isolation to meet a deadline.

### E13.2 Layout website zones

Test multiple sites, z-order, clipping and lifecycle.

### E13.3 YouTube

Validate IFrame API, autoplay, origin/referrer, progress/end/error semantics.

### E13 exit criteria

The server's presentation requirement compiler can mark all currently supported Tilecast presentation types as WPE-capable or explain a precise remaining fallback reason.

---

### E14 — WPE DRM/KMS production path

**Goal:** remove the compositor requirement on dedicated signage hosts.

### E14.1 DRM platform qualification

Hardware matrix:

```text
Ivy Bridge / Intel HD 4000 reference box
modern Intel iGPU
representative AMD/Mesa box
one ARM/Raspberry Pi target when ARM package is supported
```

### E14.2 Kiosk lifecycle

Verify:

- boot directly to renderer;
- no desktop login required for dedicated image/setup;
- hotplug/mode behavior;
- display sleep/active hours;
- CEC/DDC coexistence;
- live preview;
- renderer restart without losing DRM ownership indefinitely.

### E14 exit criteria

- 72-hour DRM soak on at least reference Intel hardware;
- no progressive memory growth outside documented bounds;
- repeated renderer crash/restart reclaims display reliably;
- video decode performance meets target.

---

### E15 — Spectrum 2 Edge administration UI

This can begin in parallel once E5/E6 server contracts stabilize and the Spectrum 2 migration foundation is merged.

### E15.1 Routes/API types

Implement Overview, Nodes, Node detail, Content, Context, Settings.

### E15.2 Existing screen integration

Add Edge summary to Screen detail without duplicating entire node view.

### E15.3 Activity/incidents

Add Edge categories/filters/links using existing Activity patterns.

### E15.4 Accessibility

- S2 semantic components;
- label all status lights;
- keyboard reachable tables/actions;
- no hover-only operations;
- no color-only state;
- reduced motion respected;
- table loading/empty/error states.

### E15 exit criteria

- no new legacy `components/ui` usage introduced by Edge;
- no custom global CSS where S2 component/style APIs suffice;
- Playwright/accessibility tests cover core operational flows;
- UI displays only backend-provided real metrics.

---

### E16 — Partition resilience and coordinator roles

**Goal:** prove Edge remains useful when infrastructure fails.

Implement/enable soft roles only after basic mesh/CDN/change feed is stable.

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

### E17 — WPE default, Electron compatibility

**Goal:** new/eligible Linux installations use WPE by default.

Change `auto` policy to prefer WPE when requirements permit.

Electron remains installed as compatibility fallback through at least one stable release window.

Collect real metrics:

```text
% WPE sessions
fallback count/reasons
renderer restart rate
playback incident rate by renderer
memory use
website failure rate
```

Do not compare raw incident counts without normalizing by playback time/fleet size.

### E17 exit criteria

- no material reliability regression versus Electron across measured deployments;
- top fallback reasons are understood;
- support documentation exists for WPE/DRM/Wayland capability issues;
- explicit rollback policy tested.

---

### E18 — Electron retirement

Electron is removable only when:

- all supported current content requirements have WPE implementations or the product deliberately drops a feature;
- website isolation policy is at least equivalent in security intent;
- WPE has a stable field window;
- upgrade/rollback path no longer depends on AppImage behavior;
- old Electron-only installs have a documented upgrade route.

Removal work:

- delete Electron networking/runtime code already superseded;
- remove Chromium/Electron packaging dependency;
- remove old AppImage update path after compatibility cutoff;
- keep migration importer as long as supported upgrades can originate from the last Electron release.

This milestone should be a product decision based on data, not an arbitrary target date.

---

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

- IPC envelopes;
- capability schema;
- canonical change-envelope encoding;
- presentation-bundle skeleton;
- CEL fixture harness skeleton.

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

### Renderer boundary PRs

### PR 6 — `refactor(player-linux): extract shared browser renderer runtime`

Pure behavior-preserving extraction from Electron.

### PR 7 — `feat(edge-ipc): add Unix socket protocol`

- Rust server;
- TS client;
- systemd socket units for renderer/media/admin sockets;
- renderer media socket with active-hash capability set;
- schema/golden tests;
- SO_PEERCRED checks;
- backpressure.

### PR 8 — `feat(player-linux): report renderer progress over Edge IPC`

Shadow only. Existing player remains authoritative.

### PR 9 — `test(edge): add renderer IPC parity harness`

Compare old callbacks vs Edge-observed event stream.

### Server ownership PRs

### PR 10 — `feat(edge-server): port server identity and URL policy`

No credential migration yet.

### PR 11 — `feat(edge-server): implement pairing/enrollment client`

Fresh-development Edge install can pair against existing server protocol.

### PR 12 — `feat(edge-server): port authenticated REST/WebSocket client`

Hello/ping/liveness/reconnect only.

### PR 13 — `feat(edge-state): add command idempotency and command client`

Run non-disruptive test command first.

### PR 14 — `feat(edge-state): port config and manifest reconciliation`

Still origin-backed cache.

### PR 15 — `feat(edge-migration): migrate Linux credential/state ownership`

- explicit one-owner handoff;
- server capability marker;
- rollback.

### PR 16 — `refactor(player-linux): renderer-only Edge mode`

Electron loses server credential and networking when Edge ownership enabled.

### CAS PRs

### PR 17 — `feat(edge-cas): add verified content-addressed store`

### PR 18 — `feat(edge-cas): add resumable origin downloads and pinning`

### PR 19 — `feat(edge-cas): migrate legacy Linux media cache`

### PR 20 — `feat(edge-cas): add eviction, reserve and scrubber`

After PR 20, the disk model should already be final enough for CDN work.

### Identity/mesh PRs

### PR 21 — `feat(server-edge): add Edge CA and authority key management`

Security review required.

### PR 22 — `feat(server-edge): add node certificate enrollment/renewal`

### PR 23 — `feat(edge-identity): enroll and rotate node certificate`

- versioned atomic identity generations;
- certificate-instance serial/fingerprint revocation;
- durable node disablement kept separate from certificate replacement.

### PR 24 — `feat(edge-mesh): add mTLS Zenoh peer session`

No app data beyond presence.

### PR 25 — `feat(edge-mesh): add liveliness and node summaries`

### PR 26 — `feat(edge-mesh): add seed fallback and interface policy`

### PR 27 — `feat(server-edge): add revocation propagation`

### CDN PRs

### PR 28 — `feat(edge-cdn): serve peerable CAS objects over mTLS`

### PR 29 — `feat(edge-cdn): add Zenoh object availability query`

### PR 30 — `feat(edge-cdn): add peer-first source selector`

### PR 31 — `feat(edge-cdn): add transfer scoring, metrics and integrity incident inputs`

### Change feed PRs

### PR 32 — `feat(server-edge): add signed Edge change outbox/feed`

- captured subject revisions;
- object-ready gating;
- decimal-string signed counters;
- authority transition chain.

### PR 33 — `feat(server-edge): compile immutable presentation bundles`

Compile the exact outbox-captured immutable revision before its feed row can be signed.

### PR 34 — `feat(edge-sync): apply signed change feed and peer relay`

Track feed continuity separately from per-resource revision watermarks.

### PR 35 — `feat(edge-sync): add gap recovery, retention and state snapshot fallback`

Add signed snapshot checkpoints, explicit node feed progress and feed/object retention coupling.

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

### PR 50 — `feat(edge-clock): add Clock Authority`

### PR 51 — `feat(edge-clock): add PTP detection/reporting`

### Updates PRs

### PR 52 — `build(edge): publish signed Edge release artifacts`

### PR 53 — `feat(server-updates): support Edge component deployments`

### PR 54 — `feat(edge-update): fetch releases through CAS/peer CDN`

### PR 55 — `feat(edge-update): add immutable release activation and rollback helper`

### WPE PRs

### PR 56 — `feat(renderer-wpe): add minimal WPEPlatform launcher`

Headless hello/IPC only.

### PR 57 — `feat(renderer-wpe): load shared Tilecast renderer runtime`

### PR 58 — `feat(renderer-wpe): add image/video/widget/layout wave 1`

### PR 59 — `test(renderer): add Electron/WPE parity corpus`

### PR 60 — `feat(edge-renderer): add capability-based renderer selector`

### PR 61 — `feat(renderer-wpe): add Wayland field mode`

### PR 62 — `feat(renderer-wpe): harden website navigation/permissions/data policy`

### PR 63 — `feat(renderer-wpe): add YouTube and website layout parity`

### PR 64 — `feat(renderer-wpe): qualify DRM/KMS mode`

### Spectrum 2 UI PRs

These start only after the Spectrum 2 shell/components used by Tilecast are stable enough to avoid building the same Edge pages twice.

### PR 65 — `feat(studio-edge): add Edge overview and node API client`

### PR 66 — `feat(studio-edge): add Spectrum 2 Nodes TableView`

### PR 67 — `feat(studio-edge): add node detail tabs`

### PR 68 — `feat(studio-edge): add content-delivery view`

### PR 69 — `feat(studio-edge): add Context value/rule UI`

### PR 70 — `feat(studio-edge): add Edge settings`

### PR 71 — `feat(activity): integrate Edge events/incidents`

### Final rollout PRs

### PR 72 — `test(edge): add network-partition/failure-injection suite`

### PR 73 — `perf(edge): add benchmark and low-end resource gates`

### PR 74 — `feat(edge-renderer): prefer WPE in auto mode for compatible content`

### PR 75+ — parity gaps and field fixes

### Final PR — `refactor(player-linux): remove Electron compatibility renderer`

Only after E18 criteria are met. Do not pre-schedule this PR.

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
renderer selector
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

The same fixture directory is consumed by:

```text
Go
Rust
TypeScript
C renderer where applicable
```

For signed envelopes, verify exact canonical bytes and signatures across languages.

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

Tests must kill processes at exact durability boundaries:

- after DB transaction, before file rename;
- after file fsync, before CAS rename;
- after CAS rename, before destination-directory fsync;
- after directory fsync, before DB metadata commit;
- after command persistence, before execution;
- after update symlink switch, before daemon READY;
- while serving a Range response;
- while receiving the final content chunk;
- while replacing node certificate;
- during SQLite WAL checkpoint.

Every state machine should document what happens after restart at each boundary.

### 44.6 WPE renderer tests

Use `WPE_PLATFORM=headless` in CI for:

- runtime startup;
- presentation fixtures;
- bridge messages;
- navigation policy;
- permission denial;
- timeout/recovery;
- process termination behavior.

Wayland/DRM hardware jobs are separate because headless cannot validate display drivers/video decode.

### 44.7 Security tests

Required adversarial cases:

- wrong installation certificate;
- publicly trusted but non-Tilecast certificate on outbound Zenoh connector;
- expired/revoked certificate;
- replacement certificate for same node after old certificate-instance revocation;
- disabled node attempts to use a newly issued/old certificate;
- peer cert with modified node SAN;
- CA-valid peer attempts to claim another node ID;
- revoked peer already connected when revocation arrives;
- peer HTTPS endpoint presents a different node certificate than its signed availability reply;
- plaintext Zenoh endpoint attempt;
- unsigned/modified Edge change;
- replay old sequence;
- stale resource revision at a later feed sequence;
- expired event in the middle of a valid feed chain;
- rolled-back domain transaction does not create a missing Edge feed position;
- signer/projector crash does not create a permanent sequence hole;
- snapshot/feed race cannot put visible snapshot state above its signed base sequence;
- valid signed Context observation replayed after a newer sourceSequence;
- old Context source epoch replayed after reinstall/new epoch;
- target another screen's presentation bundle;
- path traversal in peer HTTP;
- malformed/huge Range;
- mismatched resume `Content-Range`;
- two concurrent consumers request the same missing hash;
- object body larger than expected;
- same-size wrong hash;
- malformed CSR;
- unsupported IPC role;
- local socket from wrong UID;
- renderer tries undeclared native method;
- remote website attempts top navigation/bridge access;
- malicious context expression outside supported subset;
- HID/device hotplug storm;
- untrusted sensor tries server-only context key.

### 44.8 Compatibility tests

Matrix:

```text
Server new + legacy Electron player
Server new + Android player
Server new + Edge/Electron renderer
Server new + Edge/WPE renderer
Mixed Display Group with all above where supported
```

A server upgrade must not strand old players.

---

## 45. Failure-mode contract

Every major failure has a predetermined safe behavior.

| Failure | Correct behavior |
| --- | --- |
| Tilecast Server unreachable | Continue active/cached schedules, mesh, peer CDN, local context; show server status offline separately. |
| Internet unreachable but local server reachable | Normal self-hosted operation; no special degradation except internet-backed sources. |
| All peers disappear | Continue standalone; use server origin when reachable. |
| Multicast blocked | Use configured/server seed; if none reachable, standalone + server. |
| Zenoh crashes/fails to open | Playback/server path continues; mesh capability degraded. |
| Peer HTTPS fails | Try next peer/origin; never block active presentation. |
| Peer sends corrupt object | Reject hash; penalize source; refetch. |
| Disk full | Preserve active pinned objects; stop new preparation; report incident; never delete active content to satisfy update. |
| SQLite unavailable/corrupt | Enter Edge safe/recovery mode; preserve CAS; do not silently recreate identity/credentials. |
| Node cert expires | Server playback still works if bearer valid, but peer mesh disabled until renewal; visible incident. |
| Edge CA mismatch | Refuse peers; do not auto-trust new CA. |
| Change-feed gap | Fetch missing range; do not skip feed position. |
| Later feed event has older resource revision | Advance feed cursor but treat event as stale no-op; never roll resource state backward. |
| Signed event expired | Advance verified feed cursor; do not activate expired effect. |
| Server change retention gap | Fetch signed snapshot checkpoint, restore resource watermarks and resume from signed base sequence. |
| Context source stale | Mark stale/expire per policy; no fabricated fresh value. |
| PTP lost | Fall back to NTP/server offset and report clock-quality transition. |
| System wall clock jumps | Reevaluate schedules; active playback progresses monotonic. |
| PipeWire unavailable | Audio/sensor capability degraded; visual playback continues. |
| Avahi unavailable | Manual/server discovery and Zenoh seeds still work. |
| NetworkManager absent | Presentation Network unsupported; Ethernet Tilecast unaffected. |
| CEC/DDC permission denied | Display-control capability blocked; playback unaffected. |
| Renderer crashes | Edge/server/mesh remain alive; restart renderer and restore current presentation. |
| WPE repeatedly crashes | Fall back to Electron if policy/content permits; otherwise safe mode. |
| `tilecastd` crashes | systemd restarts; renderer may hold/freeze briefly; daemon restores cached state; no command double execution. |
| Power cut mid-download | `.part` remains resumable or is discarded safely; active content intact. |
| Power cut mid-update | boot current or previous verified release; pending release never becomes unverified executable truth. |
| Presentation Network active | Edge mesh remains on allowed management/Ethernet path only. |
| Soft coordinator dies | Another eligible node takes role; correctness unchanged. |
| LAN partition | Each partition continues local operation; no authority conflict; reconcile sequences on heal. |

---

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

Track:

```text
legacy origin-only fleet publish → all prepared
Edge peer-CDN fleet publish → all prepared
```

The metric is time to **verified prepared revision**, not just notification delivery.

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
edge.wpe.enabled
edge.wpe.preferred
```

Do not leave permanent boolean-flag soup. Remove transitional flags once a milestone becomes the stable behavior.

### 47.2 Canary screens

Use the existing deployment/canary philosophy.

Recommended school rollout:

1. one non-critical screen;
2. two screens on same LAN to validate mesh/CDN;
3. one screen from each hardware generation;
4. a small display group;
5. remaining Linux screens;
6. WPE separately canaried after Edge daemon is already stable.

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
WPE preference
sensor contributions
```

without unpairing the screen or deleting cached content.

If Edge itself is the failing component during the transitional releases, the documented local rollback returns the screen to the legacy Linux player.

---

## 48. Code-review rules for Edge

Add these to the Edge-specific `AGENTS.md` once implementation begins.

1. No new root privilege without a written threat-boundary review.
2. No shell invocation with interpolated values.
3. No arbitrary path from server/peer input.
4. All network/body/frame sizes bounded.
5. No application of peer-relayed authoritative state without server signature verification.
6. Content bytes are not trusted until hash+size verification succeeds.
7. Durable state transitions that can cause duplicate commands/updates require crash-point tests.
8. Optional provider failures cannot abort main playback initialization.
9. Every capability must explain unsupported vs blocked vs degraded.
10. High-rate data must be aggregated/coalesced before persistence/network.
11. No secret in logs/tests/screenshots.
12. Edge/server protocol changes require cross-language fixtures.
13. WPE changes touching remote website content require a navigation/permission/data-isolation review.
14. New Spectrum 2 UI must use existing S2 composition patterns rather than re-skinning old custom components.
15. Never claim a physical display state was confirmed when only a command send succeeded.
16. Never infer health solely from process/socket liveness when meaningful playback evidence is available.

---

## 49. Final technical decision table

| Area | Decision | Do not do |
| --- | --- | --- |
| Edge daemon | Rust `tilecastd` | Keep growing Electron main process |
| Renderer host | WPE WebKit WPEPlatform 2.54+ in small C/GLib process | New Cog/libwpe/WPEBackend-fdo architecture |
| Transitional renderer | Existing Electron, stripped to renderer role | Flag-day Electron deletion |
| Local persistence | SQLite WAL + immutable CAS files | Proliferate JSON state files for new relational state |
| Local IPC | Separate renderer/admin AF_UNIX sockets + length-prefixed strict JSON + OS peer credential authorization | Client-selected role on one shared socket; open localhost admin HTTP API |
| Mesh | Embedded Zenoh peer mode | Mandatory central broker |
| Mesh security | Installation-scoped mTLS, installation-CA-only outbound trust, TLS-only Zenoh links, application identity binding | Trust LAN/subnet membership or public WebPKI roots |
| Mesh discovery | Zenoh multicast + gossip + seed fallback | Depend on multicast working |
| Human/bootstrap discovery | Avahi daemon via D-Bus | Another embedded JS mDNS stack |
| Large bytes | mTLS HTTPS single-range peer service | Send MP4s as Zenoh publications |
| Content identity | SHA-256 content-addressed objects | Filenames/URLs as trust identity |
| Peer authority | None; peers relay signed server state | Peer becomes second Tilecast server |
| Dynamic signing | Dedicated Edge authority key on server | Reuse offline update-signing private key |
| Node key | Generated/stored on node | Server-generated/exported private node key |
| Change ordering | Projector-assigned contiguous feed position for completeness + independent signed resource revisions for freshness | Treat feed position as resource revision; PostgreSQL `SERIAL`/sequence gaps; wall-clock/HLC last-write-wins |
| Snapshot recovery | Authority-signed base sequence + resource revision watermarks from one consistent database view | Unsigned “current state” snapshot with an inferred cursor |
| Canonical signed format | RFC 8785/JCS JSON over envelope excluding `signature`; 64-bit counters as decimal strings; golden unsigned bytes | Sign arbitrary serializer output, unsafe JSON integers or the signature field recursively |
| Coordinator | Soft deterministic optimization roles | Raft/elected authoritative leader |
| Context conditions | CEL subset validated by `cel-go`, cross-tested in Rust | Tilecast scripting/eval language |
| Time | PTP if already synchronized, then host NTP, then server offset; monotonic playback progression | Automatically become PTP grandmaster |
| NetworkManager | Existing narrow root helper first | Give daemon sudo/broad polkit |
| Display control | typed CEC/DDC providers | Raw shell/CEC command field |
| Audio | PipeWire typed provider | Remote arbitrary media graph scripting |
| Sensors | udev + typed adapters | Generic arbitrary `/dev` access |
| Supervision | systemd notify/watchdog, renderer separately restartable | Electron process owns whole machine health |
| Software update | signed artifact + peer delivery + immutable release dirs + external rollback | Peer presence authorizes installation |
| Studio UI | Spectrum 2 composition patterns | New legacy custom design system |
| Physical display choreography | Deferred | Build topology editor in Edge v1 |

---

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

### 50.8 Electron removal date

Removal is evidence-based. WPE capability/field telemetry determines the date.

---

## 51. Definition of Done for Tilecast Edge v1

Tilecast Edge v1 is complete when all of the following are true.

### Architecture

- `tilecastd` owns the Linux player's server credential, connection, durable content state and Linux host integrations.
- Renderer is a separate disposable process.
- The server remains the single authoritative control plane.
- Existing Android and supported old Linux players still work against the same server.

### Fabric

- Edge nodes discover/connect securely over Zenoh with mTLS and installation-CA-only outbound trust.
- Node identity/keyspace is cryptographically checked even when Zenoh ACL cannot express dynamic own-node rules.
- Multicast-blocked installations have a tested seed fallback based on validated reported listener endpoints.
- Revoked certificate instances and disabled durable nodes behave independently and correctly.
- Revoked/wrong-installation peers cannot connect.
- Losing every peer does not interrupt standalone playback.

### Content

- Linux cache is content-addressed and integrity verified.
- Peer CDN serves only eligible immutable objects.
- Peer/source failure falls back safely.
- Active content cannot be evicted under cache pressure.
- A typical multi-screen publish downloads shared large media from origin only as many times as necessary, ideally once per connected LAN fabric.

### Changes

- Server changes use signed, contiguous Edge feed positions for completeness and signed per-resource revisions/generations for freshness.
- A later feed position cannot roll a resource back to an older revision.
- A node can receive applicable presentation change/object data from a peer without immediate server contact.
- A peer cannot forge an applicable change.
- Signed snapshot checkpoints restore both feed base sequence and resource watermarks after long disconnection.
- Retained feed/snapshot state retains every referenced immutable object required for recovery.

### Context

- Context values are typed, scoped, attributable and freshness-aware.
- CEL rule results match between server and Edge conformance suite.
- Context can drive published presentation eligibility/visibility offline within its declared freshness policy.
- Sensor values cannot spoof server-only context.

### Linux platform

- Avahi integration is host-native and optional.
- Presentation Network retains current privilege/routing safety.
- CEC/DDC is owned by Edge and capability reported.
- PipeWire inventory and local Noise Meter work on supported sessions without raw audio egress.
- udev hotplug changes capability state without reboot.
- Clock Authority reports source/quality and PTP when available.
- systemd watchdog/restart behavior is verified.

### WPE

- WPEPlatform headless/Wayland/DRM paths are implemented and tested on their appropriate tiers.
- `auto` renderer selection is capability/requirement based.
- Unsupported WPE content safely selects Electron while compatibility renderer is shipped.
- WPE is default for compatible content after field qualification.
- Meaningful playback health semantics are unchanged.

### Updates

- Edge release artifacts are signed using the release-signing trust path.
- Release bytes can be peer seeded.
- Deployment authorization remains server-controlled.
- New Edge release activation is atomic and has an external rollback path.

### Studio

- Edge operational UI uses Spectrum 2.
- Overview, Nodes, node detail, Content, Context and Settings are available.
- status is never color-only;
- backend metrics have documented meanings;
- Edge Activity/Incidents reuse existing systems.

### Reliability

The multi-node failure matrix passes, including:

- server outage;
- multicast outage;
- peer corruption;
- disk-full;
- renderer crash;
- Edge crash;
- wall-clock jump;
- PTP loss;
- update power cut;
- LAN partition/heal.

### Resource qualification

- reference low-end Intel hardware completes 72-hour final WPE/Edge soak;
- no unexplained memory/FD growth;
- peer serving does not break 1080p playback;
- cold cached restart restores presentation without requiring server access.

---

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

### 52.7 Do not couple Spectrum 2 migration to runtime correctness

Server/Edge protocols should be independently testable from Studio. Spectrum migration should not block daemon/CDN correctness, and Edge should not force new legacy UI into `main` just to expose early debug state—use API/tests/`tilecastctl` until S2 surfaces are ready.

---

## 53. Research notes and upstream references

This plan was built against the current Tilecast repository and current upstream documentation as of **September 22, 2026**. Prefer official/upstream documentation when implementation details change.

### Tilecast repository material reviewed

- `AGENTS.md`
- `README.md`
- `docs/architecture.md`
- `docs/player-protocol.md`
- `docs/player-updates.md`
- `docs/reliability-and-power.md`
- `docs/display-control.md`
- `docs/presentation-networks.md`
- `apps/player-linux/README.md`
- `apps/player-linux/src/core/player.ts`
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
- `apps/server/internal/devices/types.go`
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

Developer overview:

<https://wpewebkit.org/developers/>

Important decisions derived from current upstream:

- WPEPlatform is stable/default in 2.54;
- new code should target WPEPlatform rather than legacy libwpe;
- Wayland, DRM/KMS and headless are built in;
- DRM/KMS can run without a compositor;
- new projects should prefer a small custom launcher rather than new Cog-based architecture.

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

### React Spectrum / Spectrum 2

Spectrum 2 React component docs:

- SideNav: <https://react-spectrum.adobe.com/SideNav>
- TableView: <https://react-spectrum.adobe.com/TableView>
- Tabs: <https://react-spectrum.adobe.com/Tabs>
- StatusLight: <https://react-spectrum.adobe.com/StatusLight>
- ProgressBar: <https://react-spectrum.adobe.com/ProgressBar>
- Meter: <https://react-spectrum.adobe.com/Meter>
- InlineAlert: <https://react-spectrum.adobe.com/InlineAlert>
- ContextualHelp: <https://react-spectrum.adobe.com/ContextualHelp>

Spectrum status-light guidance:

<https://spectrum.adobe.com/page/status-light/>

Spectrum meter guidance:

<https://spectrum.adobe.com/page/meter/>

The UI plan follows these components instead of adding a new bespoke Edge dashboard design language.

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
10. Make the Spectrum 2 UI explain the system; do not make the UI become the system.
```

That is the intended shape of **Tilecast Edge**: a secure, local-first distributed execution layer that makes a building full of displays feel like one coherent Tilecast installation without turning the product into a distributed database.

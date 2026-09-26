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

Edge 1 adds no general root daemon. Operations that need root keep the existing narrow-helper model: the Presentation Network helper (`tilecast-networkd`) stays a root-owned process with a fixed NetworkManager allowlist, and `tilecastd` talks to it over a Unix socket. Edge uses the helper without changes and adds no privileged network code.

Display control and input use udev rules and group membership, not root. The udev rule gives HDMI-CEC adapters and the I2C buses of display adapters to the `tilecast-display` group. Only `tilecast-edge.service` joins that group (`SupplementaryGroups=`), and `DevicePolicy=closed` with `DeviceAllow=char-cec rw` and `DeviceAllow=char-i2c rw` limits the daemon to those device classes. The `tilecast` account is not a member, so the renderer and the session bridge do not get the group.

A new root operation needs a written threat-boundary review before it is added.

### 4.4 Session bridge (amendment, M9)

This amendment adds a third Edge process. PipeWire and WirePlumber are per-user services, so a system service cannot read the audio graph or open a microphone without a user session.

```text
         Tilecast Server
               |
           tilecastd                 (authority: credential, state, policy)
          /          \
  renderer-wpe    tilecast-session-bridge   (optional, unprivileged)
       |                  |
  WPE WebKit      PipeWire / WirePlumber
```

`tilecastd` stays the only authority. The bridge is an optional integration process, not a second authority:

- it receives no device credential and has no server connection;
- it owns no durable Tilecast state, no playback policy and no scheduling;
- it takes no arbitrary host operation: its whole inbound surface is `capture.set {enabled}`;
- raw audio stays inside its GStreamer pipeline. No sample crosses Edge IPC, reaches `tilecastd`, the renderer or the server, or is written to SQLite or a log. Only bounded derived values leave it.

`tilecast-session-bridge` is a small C11 program (GIO, json-glib, GStreamer, libwireplumber 0.5). It runs as the systemd user unit `tilecast-session-bridge.service` in the `tilecast` account's session, with `ConditionUser=tilecast`. A user path unit starts it while `/run/tilecast-edge/edge.sock` exists, and the bridge exits when the socket is gone for 30 s, so it runs only while Edge runs. The migrator turns lingering on for the account, so the session exists at boot.

The bridge:

- connects to `tilecastd` with the IPC role `session_bridge`, which only the daemon's own UID may take;
- sends `audio.inventory` from WirePlumber (not `wpctl`): whether PipeWire is reachable, the number of audio sources and sinks, and whether WirePlumber names a default source and sink. PipeWire object IDs and device names stay in the bridge;
- opens the microphone only after `capture.set {enabled: true}`, through `pipewiresrc ! audioconvert ! level` (no custom DSP), and sends one RMS value in `[0, 1]` per 60 ms level interval as `audio.level`;
- runs with no capabilities, `NoNewPrivileges=yes` and seccomp filters (`RestrictAddressFamilies=AF_UNIX`, `SystemCallFilter=@system-service`, `MemoryDenyWriteExecute=yes`, `RestrictNamespaces=yes`, `LockPersonality=yes`). A systemd user unit cannot have more: options that shrink the capability bounding set (`CapabilityBoundingSet=`, `PrivateDevices=`, `ProtectKernelModules=`, `ProtectKernelLogs=`, `ProtectClock=`) fail every start with `218/CAPABILITIES`, and the filesystem options need a private user namespace, inside which `connect()` to the daemon's socket fails with `EACCES` on Ubuntu 24.04. The bridge has no filesystem confinement beyond the `tilecast` account's own permissions, the same account the renderer uses; [`tilecast-edge-future.md`](tilecast-edge-future.md) records Landlock self-restriction as the follow-up.

`tilecastd` asks for capture only while all three hold: the current presentation has a Noise Meter plugin, a ready renderer shows it, and the runtime's meter reports that it wants readings (`noiseMeter: "host-levels"`). It forwards at most 20 levels a second to the renderer, disconnects a bridge that floods it, stores the runtime's ten-second history buckets in SQLite, and removes them only when the heartbeat answer acknowledges them.

The bridge is optional. A missing user session, bridge, PipeWire or microphone never stops playback and never fails a migration; it sets the audio capabilities to `blocked` or `unsupported` with a stable reason (`session_bridge_not_connected`, `pipewire_unavailable`, `no_microphone`, [`tilecast-edge-capabilities.md`](tilecast-edge-capabilities.md)), and the runtime's meter shows itself unavailable. The installer checks only that the units are installed and enabled.

A server-side migration session with a separate candidate credential is not part of Edge 1. It becomes worth its complexity only if field evidence shows legacy players being restarted beside Edge; [`tilecast-edge-future.md`](tilecast-edge-future.md) records it as deferred.

## 15. Updates

Release authorization stays on the server, as for the Android and Electron players. Edge 1 update basics:

- releases are signed artifacts published from the fixed release workflow; the player verifies the signature and digest before staging;
- artifacts are downloaded through the CAS like any other object and pinned while staged;
- a release is installed into a new `/opt/tilecast-edge/<version>/` directory; activation switches the `current` link atomically; the previous version stays for rollback;
- success is provisional until the new version reconnects and reports meaningful playback; otherwise the previous version is restored;
- the state schema migration of a new version runs only after activation, and a downgraded daemon refuses a newer schema (§6.1) instead of writing to it.

`tilecastd` never replaces its own binaries in place. The privileged activation step is a narrow, separately reviewed helper (§4.3).

M10 must first prototype `systemd-sysupdate` (transfer definitions, verified downloads, versioned installs under `/opt/tilecast-edge/<version>/`) and use it where it meets these rules. Custom update code is written only for a gap that the prototype shows. Mender is not a candidate.

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

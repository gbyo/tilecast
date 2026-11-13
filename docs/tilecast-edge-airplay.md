# Tilecast Edge AirPlay receiver: architecture amendment

**Status:** proposed amendment to [`tilecast-edge.md`](tilecast-edge.md). This document records the decision and its tradeoffs, but nothing in it is implemented yet. Edge continues to answer the AirPlay commands with `unsupported_command` until the stages in §12 merge and pass their acceptance evidence.

**Scope:** single-screen AirPlay Present on Tilecast Edge, plus the Presentation Network join for that screen. Group sessions (gateway, follower, fan-out, multicast) are not part of this amendment.

The threat-boundary review is [`tilecast-edge-airplay-threat-review.md`](tilecast-edge-airplay-threat-review.md). The product contract that this receiver implements is [`airplay-present.md`](airplay-present.md). The Presentation Network contract is [`presentation-networks.md`](presentation-networks.md).

## 1. Decision

On 2026-09-25, AirPlay was excluded from Edge 1 ([`tilecast-edge-future.md`](tilecast-edge-future.md)). On 2026-11-13, that exclusion is replaced by these decisions:

1. Edge supports single-screen AirPlay Present.
2. A new unprivileged process, `tilecast-airplay`, runs the receiver. It runs in its own socket-activated unit and uses its own account. `tilecastd` still starts no processes.
3. UxPlay runs in RTP-forward mode for every session. It never draws to the display. The WPE renderer shows the forwarded stream inside the Player Runtime `external-presentation` state.
4. Every Edge release carries a pinned UxPlay **1.73.7**, which the release builder compiles against the private GStreamer build. The release stays dependency-closed and signed. No compiler goes on a screen.
5. Edge reports `airplayGroupSupported: false`. The existing Server check (`airplay_group_not_ready`) keeps Edge screens out of group sessions. This amendment needs no Server change.

The legacy Electron Player keeps its own baseline (UxPlay 1.73.6, `apps/server/internal/airplay/policy.go`). This amendment does not change the Electron Player, the Server installer scripts, or the vendored 1.73.6 archive.

## 2. Why the Electron design cannot be copied

The Electron Player starts `uxplay` and `gst-launch-1.0` from the kiosk process. UxPlay draws with its own fullscreen video sink. Two binding Edge rules prevent that design:

| Electron behavior                             | Edge rule                                                                                                     | Consequence                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| The Player process starts UxPlay.             | `tilecastd` starts no other processes (§4.1).                                                                 | A different unit must own the UxPlay process.                    |
| UxPlay opens a fullscreen sink over the UI.   | On dedicated signage, the renderer is the DRM master (`--platform=drm`, §10.1).                               | A second process cannot draw. The renderer must show the stream. |
| The provisioning script compiles on the host. | A release is dependency-closed (`release/runtime_closure.py`). An update installs only signed releases (§15). | UxPlay must arrive inside the signed release.                    |

## 3. Options that were rejected

- **The renderer releases DRM master, and UxPlay draws with `kmssink`.** This is the nearest copy of Electron. It was rejected for these reasons:
  - Two processes would exchange DRM master during a session, and a crash at the wrong time leaves a dark screen.
  - The method does not work under a Wayland kiosk compositor.
  - The Runtime could not show the ready page, the PIN, or an emergency takeover over the mirrored video.
- **`tilecastd` starts UxPlay.** This breaks §4.1, and it puts a network listener for untrusted senders in the process that holds the device credential.
- **UxPlay from the host installer (`install-airplay-support.sh`).** That script compiles from source on the host. Edge releases would stop being self-contained, and the version on a screen would not follow the release.
- **Link the UxPlay library into the renderer.** UxPlay is a GPL-3.0 program, not a stable library. The renderer would also become a network listener for untrusted senders.

## 4. Processes

```text
            Tilecast Server
                  |
              tilecastd            (authority: session state, policy, grants)
            /     |      \
 renderer-wpe  tilecast-airplay   tilecast-networkd (root, existing)
      |           |   (unprivileged, socket activated)
 WPE WebKit     uxplay  --RTP over loopback-->  renderer-wpe (tcpresent source)
```

### 4.1 `tilecast-airplay`

`tilecast-airplay` is a small Rust supervisor in `apps/edge/tilecast-airplay/`.

- It runs in `tilecast-airplay.service` as the new system account `tilecast-airplay`. `sysusers.d` creates the account. The account is not a member of `tilecast`, `tilecast-display`, `tilecast-network`, `tilecast-web`, `video`, `render`, `input`, or `audio`.
- `tilecast-airplay.socket` starts it. The socket is `/run/tilecast-airplay/control.sock`, owned `root:tilecast` with mode 0660. The supervisor accepts a peer only if `SO_PEERCRED` gives the `tilecast` UID and the peer cgroup is `tilecast-edge.service`. The renderer and the session bridge use the same UID, so the cgroup check refuses them. This is the same rule as `tilecast-edge-update.socket`.
- It holds one control connection. When the connection closes, the supervisor stops UxPlay and exits. systemd starts it again at the next connection.
- It is the only Edge process that may start a program. It starts exactly one program: the release's `bin/uxplay`, with a fixed path. It builds the argument vector from validated typed fields and never uses a shell.
- It writes the session options (receiver name, PIN, device ID) to a 0600 file in its private `RuntimeDirectory` and passes the file with `-rc`. The PIN and the device ID therefore never appear in a process argument. The supervisor deletes the file when the session ends and at start.
- `KillMode=control-group` and `TimeoutStopSec=` make sure that no `uxplay` process lives longer than the unit.

The supervisor owns no durable Tilecast state, no playback policy, and no Server connection. It receives no device credential and no Presentation Network secret.

### 4.2 Control protocol

The protocol uses the bounded types in `edge-protocol`. Fixtures go in `packages/edge-protocol/fixtures`, with tests on both sides (review rule 8). One JSON object per line.

| Direction          | Message               | Fields                                                                                                                                                                                                        |
| ------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tilecastd` → unit | `start`               | `sessionId`, `receiverName` (bounded, validated), `pin` (four digits), `deviceId` (locally administered MAC), `profile` (`1080p30`, `720p30`), `audioMode` (`gateway_only`, `none`), `videoPort`, `audioPort` |
| `tilecastd` → unit | `stop`                | `sessionId`                                                                                                                                                                                                   |
| `tilecastd` → unit | `probe`               | none                                                                                                                                                                                                          |
| unit → `tilecastd` | `probe_result`        | `uxplayVersion`, `avahiAvailable`, `limitation`. The renderer reports the H.264 decoder, because UxPlay does not decode in RTP mode.                                                                          |
| unit → `tilecastd` | `advertising`         | `sessionId`                                                                                                                                                                                                   |
| unit → `tilecastd` | `client_connected`    | `sessionId`                                                                                                                                                                                                   |
| unit → `tilecastd` | `client_disconnected` | `sessionId`                                                                                                                                                                                                   |
| unit → `tilecastd` | `failed`              | `sessionId`, `code` (stable code)                                                                                                                                                                             |
| unit → `tilecastd` | `stopped`             | `sessionId`                                                                                                                                                                                                   |

The supervisor derives `client_connected` and `client_disconnected` from UxPlay's own output. Those lines are bounded and parsed with a fixed grammar. Raw UxPlay output never crosses the socket, and it never goes to the Server. The PIN never goes to a log.

## 5. Media path

UxPlay forwards decrypted, compressed H.264 with `-vs 0 -vrtp "<rtph264pay options> ! udpsink host=127.0.0.1 port=<videoPort>"`. When `audioMode` is `gateway_only`, it forwards decoded L16 audio with `-artp "<rtpL16pay options> ! udpsink host=127.0.0.1 port=<audioPort>"`. When `audioMode` is `none`, it uses `-as 0`. UxPlay 1.73.6 has both `-vrtp` and `-artp` (`uxplay.cpp`). Stage 3 must confirm both options in 1.73.7 before it pins the archive.

The renderer adds one GStreamer element, `tcpresent`, in `apps/edge/renderer-wpe/src/`. It follows the pattern of `gst-tcmedia.c`:

- It handles the URI scheme `tcpresent://session/<opaque-id>`. The page never supplies a port or an address.
- The renderer maps the opaque ID to the ports only from a `tilecastd` grant. The grant ends when the session ends.
- Inside the element: `udpsrc address=127.0.0.1 → rtpjitterbuffer → rtph264depay → h264parse` for video, and the L16 equivalent for audio. The element is live.
- `WEBKIT_GST_ALLOWED_URI_PROTOCOLS` adds `tcpresent`.

The renderer advertises a new feature in `renderer.ready`. The Runtime shows a `<video>` element in its `external-presentation` view only if the host advertises that feature (`packages/player-runtime/src/views/status-surface.ts`). Without the feature, the view keeps the current Electron behavior: the external receiver owns the screen. The Runtime decides from the capability, never from a host name. Presentation behavior stays in the Runtime.

Audio uses the renderer's existing audio output. The AirPlay unit therefore needs no audio device. Video and audio share one media element, so WebKit keeps them in sync with the RTP timestamps. If the Stage 4 spike shows that one source with two streams does not work in WebKit's player, the fallback is this: the unit plays audio through ALSA, it gets the `audio` group, and the documents record the loss of A/V sync. A change to that fallback needs an update to this document and to the threat review.

**Main technical risk.** WebKit can add latency to a live source with its buffering. Stage 4 begins with a spike that measures the delay from sender to glass with a synthetic RTP stream. The target is at most 300 ms above Electron on the same hardware. If the spike misses the target, stop and update this document before more work.

## 6. Session state and priority

Priority does not change ([`airplay-present.md`](airplay-present.md), [`quick-present.md`](quick-present.md)):

1. Emergency Takeover
2. AirPlay Present
3. Quick Present
4. The scheduled or assigned presentation
5. Outside hours

`tilecastd` keeps the session in SQLite. A new migration, `crates/player-state/migrations/0014_external_presentation.sql`, adds it. Do not change the bytes of an existing migration. The row holds the session ID, the receiver name, the expiry, and the state. The PIN and the device ID are kept only until the session ends, and are deleted with the row. Only `tilecastd` reads the row.

The rules come from the Electron Player:

- Every session has an absolute `expiresAt`. `tilecastd` enforces it on the monotonic clock and the wall clock.
- A single-screen session is prepared and started by one command, so after a reboot an unexpired session is resumed. An expired session is deleted, and signage is evaluated.
- Each session has a new PIN and a new locally administered device ID. The Server generates them.
- A sender disconnect returns to the ready page. Stop, expiry, emergency takeover, and a fatal receiver failure stop UxPlay and evaluate the current signage state. The Player never restores a stale content snapshot.
- Manifest and schedule changes continue to sync during a session.

Every durable transition (prepare, start, stop, expire, recover) needs a crash-point test (review rule 6).

## 7. Commands and reports

`tilecastd` replaces the `unsupported_command` branch for the three AirPlay commands (`apps/edge/tilecastd/src/command_handlers.rs`):

- `prepare_airplay_session` with `role: "single"`: validate the payload, store the session, join the Presentation Network if the payload has one (§8), send `start`, and grant `tcpresent` to the renderer. A `gateway` or `receiver` role fails with the stable code `airplay_group_unsupported`. The Server must not send those roles, because Edge reports `airplayGroupSupported: false`.
- `stop_airplay_session`: send `stop`, revoke the grant, leave the Presentation Network, and delete the session.
- `test_airplay_support`: send `probe` and report the result.

Heartbeat uses the existing `airplay*` fields (`apps/server/internal/devices/airplay_heartbeat.go`):

- `airplaySupported` is true only if the unit is installed, UxPlay answers `probe`, avahi-daemon is reachable, and the renderer advertises the `tcpresent` feature.
- `airplayHardwareDecode` and `airplayDecoder` report the decoder that the renderer's GStreamer selects.
- `airplayGroupSupported` is always false.
- `airplayLimitation` names the first failed dependency in one sentence, in the Electron order, so that Studio can show it unchanged.

The capability is `external_presentation.airplay`. The category already exists in `crates/player-types/src/capability.rs`. [`tilecast-edge-capabilities.md`](tilecast-edge-capabilities.md) gets its row when Stage 5 merges.

## 8. Presentation Network binding

The Presentation Network client already exists (`apps/edge/tilecastd/src/presentation_network.rs`). It uses the unchanged root helper `tilecast-networkd`. This amendment adds only the binding to a session:

1. Before `start`, if the payload has `presentationNetworkId`, `tilecastd` activates that network through the existing connect path. The command fails with the helper's stable code if the connection fails.
2. After stop, expiry, or failure, `tilecastd` deactivates the network and restores the radio state.
3. If Ethernet stops being the default route, `tilecastd` stops the session and reports `ethernet_default_route_lost`.

The credential path does not change. `tilecastd` fetches the credential only to install a profile, and it never stores it.

A new Edge installation (not a migration) does not install `tilecast-networkd`. The operator runs the Server-published `install-presentation-network.sh`. The script grants its socket group to the `tilecast` account by default, so it works for Edge without change. The public install page for Edge must say so when Stage 6 merges.

## 9. Discovery

UxPlay advertises `_airplay._tcp` and `_raop._tcp` through the host `avahi-daemon` over the system D-Bus (`avahi-compat-libdns_sd`). The release carries the compatibility library. avahi-daemon is a host service that the operator installs. `tilecastd` already uses Avahi for LAN discovery (M5). If avahi-daemon is missing, the probe reports a limitation and AirPlay stays unavailable. Signage is not affected.

The unit advertises only while a session is active. It does not create a permanent advertisement.

## 10. Network contract

The ports are the existing AirPlay firewall contract ([`airplay-present.md`](airplay-present.md)):

| Purpose                          | Ports                   | Bind                         |
| -------------------------------- | ----------------------- | ---------------------------- |
| UxPlay AirPlay control and media | TCP and UDP 37000–37002 | all interfaces, session only |
| Forwarded H.264 RTP              | UDP 42000               | `127.0.0.1` only             |
| Forwarded L16 audio RTP          | UDP 42002               | `127.0.0.1` only             |
| Bonjour/mDNS                     | UDP 5353 (avahi-daemon) | host                         |

The single-screen RTP stream never leaves the screen. A future group amendment must define how loopback and LAN receivers share these ports.

## 11. Licensing

UxPlay is GPL-3.0. Edge ships it as a separate program in the release tree. The release SBOM (`apps/edge/release/sbom.py`) lists it. The release carries the exact source archive and the license notice next to the binary. The archive is pinned by version, tag commit, and SHA-256 in the release builder inputs.

## 12. Stages

Each stage is a separate pull request. Each pull request stacks on the one before it.

| Stage | Scope                                                                                                                                                        | Acceptance evidence                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | This amendment and the threat review. Pointer updates in the Edge documents.                                                                                 | `make docs-check`. The user approves the decision.                                                                                                                                                                        |
| 2     | `tilecast-airplay` crate, units, `sysusers.d` entry, `edge-protocol` messages and fixtures.                                                                  | A Rust and fixture test suite. An integration test with a fake `uxplay` under real systemd in the Linux image: peer refusal for the renderer cgroup, no orphan after `SIGKILL` of the supervisor, no PIN in argv or logs. |
| 3     | Release bundling: build UxPlay 1.73.7 in `release/Dockerfile.builder`; `runtime_closure.py`; `system-baseline.txt` (avahi-daemon); SBOM, source, and notice. | `run-closure-check.sh` and `run-sandbox-check.sh` pass. `uxplay -v` reports 1.73.7 in the packaged sandbox. `-vrtp`, `-artp`, `-rc`, and `-pin` are confirmed in 1.73.7.                                                  |
| 4     | Renderer `tcpresent` element, `renderer.ready` feature, Runtime external-presentation video view. The latency spike comes first.                             | Headless end-to-end test with a synthetic RTP stream. Runtime unit tests for the capability gate. The recorded latency measurement.                                                                                       |
| 5     | `tilecastd` session: command handlers, migration `0014`, priority in `presentation.rs`, Presentation Network binding, heartbeat, capability.                 | Crash-point tests for every transition. A command redelivery test. A takeover-during-session test. `python3 scripts/ci/check-player-architecture.py`.                                                                     |
| 6     | Public documentation and qualification.                                                                                                                      | The manual procedure in [`airplay-present.md`](airplay-present.md) (single-screen steps) on Edge reference hardware with iPhone, iPad, and Mac senders, recorded in the qualification ledger.                             |

Until Stage 6 is recorded, the readiness documents must not show AirPlay on Edge as available, and an AirPlay-dependent screen must stay on the Electron Player.

## 13. Changes to binding documents

When Stage 2 merges, these changes take effect:

- [`tilecast-edge.md`](tilecast-edge.md) §4 adds `tilecast-airplay` as a fourth Edge process (§4.5). It is unprivileged and it is the only Edge process that starts a program.
- §3 no longer lists AirPlay as out of scope. Group AirPlay is still out of scope.
- `apps/edge/AGENTS.md` adds the fixed decision for the unit.
- [`tilecast-edge-future.md`](tilecast-edge-future.md) keeps a row for group AirPlay.

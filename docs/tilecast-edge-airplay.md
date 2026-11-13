# Tilecast Edge AirPlay receiver: architecture amendment

**Status:** amendment to [`tilecast-edge.md`](tilecast-edge.md), implemented in stages (§12). Stage 2 (the supervisor, its units and its protocol), Stage 3 (UxPlay in the release), Stage 4 (the renderer relay, the `tcpresent` source, and the Runtime view), Stage 5 (the `tilecastd` session), and the Stage 6 documentation are implemented. The Stage 6 hardware qualification is open. AirPlay on Edge is not available until Stage 6 records hardware evidence.

**Scope:** single-screen AirPlay Present on Tilecast Edge, plus the Presentation Network join for that screen. Group sessions (gateway, follower, fan-out, multicast) are not part of this amendment.

The threat-boundary review is [`tilecast-edge-airplay-threat-review.md`](tilecast-edge-airplay-threat-review.md). The product contract that this receiver implements is [`airplay-present.md`](airplay-present.md). The Presentation Network contract is [`presentation-networks.md`](presentation-networks.md).

## 1. Decision

On 2026-09-25, AirPlay was excluded from Edge 1 ([`tilecast-edge-future.md`](tilecast-edge-future.md)). On 2026-11-13, that exclusion is replaced by these decisions:

1. Edge supports single-screen AirPlay Present.
2. A new unprivileged process, `tilecast-airplay`, runs the receiver. It runs in its own socket-activated unit and uses its own account. `tilecastd` still starts no processes.
3. UxPlay runs in RTP-forward mode for every session. It never draws to the display. The WPE renderer shows the forwarded stream inside the Player Runtime `external-presentation` state.
4. Every Edge release carries a pinned UxPlay **1.73.7**, which the release builder compiles against the Debian 13 GStreamer that the release already uses (`system-baseline.txt`). The release stays dependency-closed and signed. No compiler goes on a screen.
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
 WPE WebKit     uxplay  --RTP over loopback-->  renderer-wpe relay --Unix socket--> web process (tcpresent)
```

### 4.1 `tilecast-airplay`

`tilecast-airplay` is a small Rust supervisor in `apps/edge/tilecast-airplay/`.

- It runs in `tilecast-airplay.service` as the new system account `tilecast-airplay`. `sysusers.d` creates the account. The account is not a member of `tilecast`, `tilecast-display`, `tilecast-network`, `tilecast-web`, `video`, `render`, `input`, or `audio`.
- `tilecast-airplay.socket` starts it. The socket is `/run/tilecast-airplay/control.sock`, owned `root:tilecast` with mode 0660. The supervisor accepts a peer only if `SO_PEERCRED` gives the `tilecast` UID and the peer process is in the `tilecast-edge.service` cgroup. The renderer and the session bridge use the same UID, so the cgroup check refuses them. This is the same rule as `tilecast-edge-update.socket`. The unit has `ProtectProc=invisible`, so the supervisor cannot read the peer's `/proc/<pid>/cgroup`. It reads `/sys/fs/cgroup/system.slice/tilecast-edge.service/cgroup.procs` instead (`edge_platform::peer::allow_daemon_listed`). That list has only the processes in that cgroup, not in a child cgroup, so the rule does not change.
- `tilecast-edge.service` pulls the socket in with `Wants=tilecast-airplay.socket`. No installer enables the socket. An update installs the units of the new release, but the installer is the previous release's helper, and it installs only the unit names that it knows ([`tilecast-edge-update-threat-review.md`](tilecast-edge-update-threat-review.md) §4.5). The `sysusers.d` file has a fixed name, so the account arrives with the first AirPlay release. The two AirPlay units arrive with the next update after it, or at once on a new migration. Until then, `tilecastd` cannot connect, and AirPlay reports a limitation. Signage is not affected.
- It holds one control connection. It refuses other connections while it serves one (`rejected` with `connection_busy`). When the connection closes, the supervisor stops UxPlay and exits. systemd starts it again at the next connection.
- It is the only Edge process that may start a program. It starts exactly one program: the release's `bin/uxplay`, with a fixed path. It builds the argument vector from validated typed fields and never uses a shell.
- It writes the session options (receiver name, PIN, device ID) to a 0600 file in its private `RuntimeDirectory` and passes the file with `-rc`. The PIN and the device ID therefore never appear in a process argument. The supervisor deletes the file when UxPlay reports that its server sockets are open (UxPlay reads the file before that), when the session ends, and at start.
- The argument vector also has a bare `-pin`. UxPlay parses the `-rc` file first and the command line after it, and a bare `-pin` keeps the PIN of the file. If UxPlay could not open the file, it ignores it and continues. The bare `-pin` then still requires a random PIN that no one sees, so no sender can connect.
- It clears the environment of UxPlay. It sets `HOME` and the GStreamer registry to the session directory and passes only a fixed list of library and plugin path variables.
- UxPlay prints the PIN on its output when a sender starts pairing. The supervisor reads UxPlay's output only to classify lines. It never logs or forwards a line.
- UxPlay writes its log with `printf` and never flushes it. Through a pipe, its lines stay in a 4 KiB buffer, so the supervisor would not see them in time (the Stage 3 packaged check found this). The supervisor therefore gives UxPlay a pseudo-terminal for its standard output and standard error, on which the C library writes each line at once. This starts no other program.
- Senders that enter a wrong PIN 10 times end the session (`pin_attempts_exceeded`). UxPlay itself has no limit in `-pin` mode (threat review §6).
- `KillMode=control-group` and `TimeoutStopSec=` make sure that no `uxplay` process lives longer than the unit.

The supervisor owns no durable Tilecast state, no playback policy, and no Server connection. It receives no device credential and no Presentation Network secret.

### 4.2 Control protocol

The protocol uses the bounded types in `edge-protocol`. Fixtures go in `packages/edge-protocol/fixtures`, with tests on both sides (review rule 8). One JSON object per line.

| Direction          | Message               | Fields                                                                                                                                                                                                        |
| ------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tilecastd` → unit | `start`               | `sessionId`, `receiverName` (bounded, validated), `pin` (four digits), `deviceId` (locally administered MAC), `profile` (`1080p30`, `720p30`), `audioMode` (`gateway_only`, `none`), `videoPort`, `audioPort` |
| `tilecastd` → unit | `stop`                | `sessionId`                                                                                                                                                                                                   |
| `tilecastd` → unit | `probe`               | none                                                                                                                                                                                                          |
| unit → `tilecastd` | `probe_result`        | `uxplayVersion`, `avahiAvailable`, `limitation` (a stable code, see below). The renderer reports the H.264 decoder, because UxPlay does not decode in RTP mode.                                               |
| unit → `tilecastd` | `advertising`         | `sessionId`                                                                                                                                                                                                   |
| unit → `tilecastd` | `client_connected`    | `sessionId`                                                                                                                                                                                                   |
| unit → `tilecastd` | `client_disconnected` | `sessionId`                                                                                                                                                                                                   |
| unit → `tilecastd` | `failed`              | `sessionId`, `code` (stable code)                                                                                                                                                                             |
| unit → `tilecastd` | `stopped`             | `sessionId`                                                                                                                                                                                                   |
| unit → `tilecastd` | `rejected`            | `code`. The last line did not decode, or the peer is refused. The supervisor closes the connection after it.                                                                                                  |

The types are `edge_protocol::airplay`. A line is at most 4096 bytes. `videoPort` decodes only as 42000 and `audioPort` only as 42002. The receiver name must not have a control character or a line separator, must not start with `-` or white space, and must not have both `"` and `'`: the `-rc` grammar splits words at spaces, and a quoted word ends at its quote character. `tilecastd` (Stage 5) normalizes a Server name that breaks these rules before it sends `start`.

`limitation` is a code, not a sentence: `uxplay_missing`, `uxplay_not_executable`, `uxplay_version_failed`, `uxplay_version_unrecognized`, `uxplay_version_unsupported`, `avahi_unavailable`, in the Electron order. `tilecastd` maps the code to the Electron sentence (Stage 5), so the operator text stays in one process. A second `start` for the running session is answered with its current state. A `start` for another session fails with `session_active`.

The supervisor derives `client_connected` and `client_disconnected` from UxPlay's own output. Those lines are bounded and parsed with a fixed grammar. Raw UxPlay output never crosses the socket, and it never goes to the Server. The PIN never goes to a log.

## 5. Media path

UxPlay forwards decrypted, compressed H.264 with `-vs fakesink -vrtp "config-interval=1 ! udpsink host=127.0.0.1 port=42000"`. When `audioMode` is `gateway_only`, it forwards decoded L16 audio with `-artp "pt=96 ! udpsink host=127.0.0.1 port=42002"`. When `audioMode` is `none`, it uses `-as 0`.

**Change from the first version of this amendment (Stage 2).** The first version used `-vs 0 -vrtp`. The UxPlay source does not support that. In 1.73.7 (and in the vendored 1.73.6), `-vs 0` sets `use_video = false`, and UxPlay then never calls `video_renderer_init`, so the `-vrtp` pipeline is never built and no video is forwarded (`uxplay.cpp`). `-vrtp` by itself already replaces the decoder and the sink with `rtph264pay` (`renderers/video_renderer.c`), so UxPlay does not draw. `-vs fakesink` keeps a sink that cannot draw for any path that does not use RTP (for example cover art). The decision "UxPlay never draws" does not change. The Electron group gateway uses `-vs 0 -vrtp` with 1.73.6; that path is outside this amendment and needs its own check.

### 5.1 The relay and the `tcpresent` source (Stage 4)

**Change from the first version of this amendment (Stage 4).** The first version put `udpsrc address=127.0.0.1` inside the `tcpresent` element. The element runs in the WebKit web process. WebKit starts that process through bubblewrap with `--unshare-net`, so the web process has its own network namespace and its own loopback interface. Stage 4 confirmed this in the `tilecast-edge-dev` image with the sandbox on (`docker run --privileged`): the web process's `udpsrc` was bound to `127.0.0.1:42000` in network namespace `4026532449`, and the renderer and UxPlay were in `4026532383`. No packet arrived. The first design works only with `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS`, which a release never sets (`tilecast-edge-sandbox-review.md` §4).

The media path is therefore:

```text
uxplay --udp 127.0.0.1:42000/42002--> renderer main process (host network namespace)
         udpsrc reuse=false ! unixfdsink   (present-relay.c)
           --> <present dir>/<id>-video.sock, <id>-audio.sock
web process (own network namespace)
         tcpresent: unixfdsrc ! rtpjitterbuffer ! rtph264depay ! h264parse
                    unixfdsrc ! rtpjitterbuffer ! rtpL16depay
```

- The renderer's main process (`tilecast-renderer-wpe`) is not in the bubblewrap sandbox. It stays in the host network namespace and its unit already allows `AF_INET`.
- The main process creates a private 0700 directory under the unit's private `/tmp` at start (`TILECAST_PRESENT_DIR`). It adds the directory to the web process sandbox. It is the only path that the web process gets for AirPlay.
- When an activation carries an `external-presentation` document with `sourceId`, the main process asks `tilecastd` for the present grant over the media socket: `{"op":"present","session":"<id>"}`. `tilecastd` answers from its grant registry with the fixed ports (`{"status":"ok","videoPort":42000,"audioPort":42002}`, without `audioPort` when the session forwards no audio). The client refuses any other port. The page and the document never name an address or a port.
- The main process then starts one pipeline for each stream: `udpsrc address=127.0.0.1 port=<fixed> reuse=false ! unixfdsink socket-path=<dir>/<id>-<stream>.sock`. `reuse=false` makes the relay fail, not share the port, when another socket holds it.
- The main process delivers the activation to the Runtime only after the relay runs or failed. A failed relay reports `renderer.health` `degraded` with `external_presentation_unavailable`.
- The main process asks for the grant again each second. When `tilecastd` denies it, or a new activation has another `sourceId` or none, the main process stops the relay and removes its sockets.
- In the web process, `tcpresent://session/<id>` builds the socket paths from the ID, as `tcwebsrc` builds a frame socket path from a capability. An ID with no relay names no socket, and the element fails like a missing file. The audio branch exists only when `<id>-audio.sock` exists.
- `WEBKIT_GST_ALLOWED_URI_PROTOCOLS` adds `tcpresent`.

A UDP socket passed to the web process with `SCM_RIGHTS` would remove the copy. It was rejected: a sandboxed web process with a socket of the host network namespace could send UDP to any address on the network (threat review §8).

### 5.2 Renderer feature and Runtime view

The renderer adds `external-presentation-video-v1` to the `renderer.ready` features, and `externalPresentation` with the H.264 decoder of the highest rank (`decoder`, `hardwareDecode`). It does this only when GStreamer starts and every element of the relay and of the source exists (`tc_present_relay_probe`). `tilecastd` (Stage 5) sends `sourceId` only to a renderer with the feature.

The WPE bridge sets the Runtime capability `externalPresentationVideo`. The Runtime external-presentation view shows `<video src="tcpresent://session/<sourceId>">` only when the capability is set and `sourceId` is 64 lowercase hexadecimal characters (`packages/player-runtime/src/views/status-surface.ts`). Without both, the view keeps the Electron behavior: the external receiver owns the screen. The Runtime decides from the capability, never from a host name.

The view mounts the `<video>` when the session starts, under the ready page, and shows it when `connected` is true. iOS sends a key frame only when mirroring starts. A pipeline that starts after the sender connects can wait for a long time for the next key frame. The same element stays mounted while `connected` changes, so a sender that disconnects and connects again reuses the running pipeline.

Video and audio share one media element. Stage 4 confirmed that WebKit 2.54.2 accepts one source with two pads: the element exposed one video track and one audio track, with the sandbox on and off. The fallback (ALSA in the AirPlay unit) is not used. The container has no audio device, so Stage 4 did not measure audio latency or A/V sync. Stage 6 must measure them on hardware.

### 5.3 Latency measurement (Stage 4)

`apps/edge/renderer-wpe/spike/present-latency/run.sh` measures the delay from the sender to the composited output in the `tilecast-edge-dev` image (WPE 2.54.2, GStreamer 1.28, headless WPEPlatform, 8 CPUs, software decoding with `avdec_h264`). A Python sender sends a 1280x720, 30 fps H.264 stream (libx264 baseline, from ffmpeg) as RTP to `127.0.0.1:42000`. With audio, it also sends L16 stereo 44.1 kHz to `:42002`. The stream changes between black and white each second. The sender records the time at which the first packet of each change leaves. Each receiver records the time at which the center pixel changes: WebKit in the composited `WPEView` buffer, and the reference pipelines in the decoded frame at an `appsink`. 40 changes for each row:

| Path                                                                                                             | Median   | p90      | Range      |
| ---------------------------------------------------------------------------------------------------------------- | -------- | -------- | ---------- |
| Minimal decode: `udpsrc ! rtph264depay ! h264parse ! avdec_h264 ! appsink sync=false`                            | 9.5 ms   | 10.0 ms  | 6–10 ms    |
| Electron receiver pipeline (`buildReceiverArgs`: `rtpjitterbuffer latency=80 drop-on-latency=true`, `sync=true`) | 99.8 ms  | 102.4 ms | 93–108 ms  |
| WebKit, relay and `tcpresent`, video only                                                                        | 112.0 ms | 117.1 ms | 105–119 ms |
| WebKit, relay and `tcpresent`, video and audio                                                                   | 111.6 ms | 113.1 ms | 103–121 ms |
| WebKit, relay and `tcpresent`, video only, WebKit sandbox on                                                     | 112.2 ms | 115.1 ms | 107–120 ms |
| WebKit, relay and `tcpresent`, video and audio, WebKit sandbox on                                                | 111.5 ms | 113.6 ms | 109–120 ms |

The WebKit path is 12 ms above the Electron receiver pipeline and 102 ms above the minimal decode. Both are below the limit of 300 ms. Most of the delay is the 80 ms jitter buffer, which `tcpresent` takes from the Electron receiver. A smaller buffer is possible on loopback. Stage 6 can tune it with hardware evidence. A relay through `unixfdsink` and `unixfdsrc` alone, measured with the Electron receiver pipeline, also gave 100.2 ms. The relay adds no measurable delay.

The measurement does not include the sender, Wi-Fi, UxPlay, display scan-out, or a hardware decoder. The Electron single-screen path (UxPlay draws with its own sink) was not measured, because UxPlay cannot draw in this image. Stage 6 measures from the sender to the glass on reference hardware.

### 5.4 Capture exclusion

Preview, snapshot, and Watch Live never capture a mirrored frame. Two layers enforce this:

- `tilecastd` maps the `external-presentation` document to the protected capture state `CaptureState::ExternalPresentation` (Player Core). It refuses a capture before it asks the renderer, and it discards a frame when the screen changed to that state during the capture.
- The renderer refuses a preview with `unavailable` and the code `external_presentation` while the relay runs or waits for its grant. Watch Live gets black frames of the presented size, and the renderer does not read the presented pixels (`preview.c`).

### 5.5 Main technical risk

WebKit can add latency to a live source with its buffering. Stage 4 measured the risk (§5.3). If hardware evidence in Stage 6 shows more than 300 ms above Electron on the same hardware, stop and update this document before more work.

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

### 6.1 Implementation (Stage 5)

The session lives in `apps/edge/tilecastd/src/airplay.rs`. One task owns it and the one `ReceiverConnection` of the session.

- **Priority.** The offline activation loop of Player Core has a host hook, `OfflineActivationHost::external_presentation`. While it is true, Core shows the session through `show_external_presentation`. The session replaces the selection, the outside-hours surface, and the disabled surface. Core does not try a pending manifest: it suspends the trial, as it does under a policy surface. Only a takeover target outranks the session. Core then calls `yield_external_presentation`, and `tilecastd` stops the session with the reason `takeover`. A `prepare_airplay_session` during a takeover fails with `emergency_takeover_active`. Hosts without an external presentation keep the default, so the Windows and Android hosts do not change.
- **Durable states.** `tilecastd` writes the row before each effect: `prepared` before the Presentation Network join and `start`; `started` after the supervisor reports `advertising`; `stopping`, with the reason, before UxPlay stops and the network is left. Then it deletes the row.
- **Recovery.** At start, `tilecastd` reads the row. It finishes a `stopping` row and deletes an expired or invalid row. It resumes an unexpired `prepared` or `started` row: it connects, sends `start` again, and shows the ready page. If the supervisor cannot run the session, `tilecastd` stops it with `receiver_unavailable`. At start, the network task keeps a Presentation Network connection when the resumed row still uses it.
- **Expiry.** The task stops the session when the monotonic deadline passes. It also stops the session when the wall clock passes `expiresAt` (checked each second), so a clock correction past the expiry ends the session at once.
- **Redelivery.** A `prepare_airplay_session` for the running session is answered `airplay_started`, and UxPlay does not start again. A new `expiresAt` for the same session is stored in place. Another change to the same session (name, PIN, device ID, profile, audio, or network) stops it with `reconfigured` and starts it again. A `prepare` for another session stops the running one with `replaced`. `stop_airplay_session` for a session that does not run is answered `airplay_already_stopped`.
- **Events.** `client_connected` and `client_disconnected` change `connected` and the screen. `failed` stops the session with the supervisor's code. `stopped`, `rejected`, and a lost connection stop it with `receiver_stopped` or `receiver_lost`.
- **Screen.** The `external-presentation` document has the receiver name, the PIN (the ready page shows it), the expiry, `connected`, the Presentation Network state, and `sourceId` when the renderer advertises `external-presentation-video-v1`. `tilecastd` grants the stream again for each new renderer instance. A stop revokes the grant, and the activation loop evaluates signage at once.
- **Receiver name.** Before `start`, `tilecastd` removes control characters, trims white space, removes leading `-` characters, cuts the name to 120 characters, and replaces `"` with `'` when both quote characters are present. If no character is left, the command fails with `airplay_prepare_failed`.
- **Activity.** The Electron Player ends the presentation session with the reason `external_presentation`. That reason is not in the Activity terminal-reason vocabulary ([`activity-event-contract.md`](activity-event-contract.md)), and the Server does not accept it. Edge does not add it. The `external-presentation` document ends the presentation session with the reason that Edge sends for every other surface that is not content (`schedule_transition`). A contract change for AirPlay belongs to the owner of the Activity contract.

## 7. Commands and reports

`tilecastd` replaces the `unsupported_command` branch for the three AirPlay commands (`apps/edge/tilecastd/src/command_handlers.rs`):

- `prepare_airplay_session` with `role: "single"`: validate the payload, store the session, join the Presentation Network if the payload has one (§8), send `start`, and grant `tcpresent` to the renderer. A `gateway` or `receiver` role fails with the stable code `airplay_group_unsupported`. The Server must not send those roles, because Edge reports `airplayGroupSupported: false`.
- `stop_airplay_session`: send `stop`, revoke the grant, leave the Presentation Network, and delete the session.
- `test_airplay_support`: send `probe` and report the result.

Heartbeat uses the existing `airplay*` fields (`apps/server/internal/devices/airplay_heartbeat.go`):

- `airplaySupported` is true only if the unit is installed, UxPlay answers `probe`, avahi-daemon is reachable, and the renderer advertises `external-presentation-video-v1` (§5.2).
- `airplayHardwareDecode` and `airplayDecoder` report the decoder that the renderer's GStreamer selects (`renderer.ready` `externalPresentation`, §5.2).
- `airplayGroupSupported` is always false.
- `airplayLimitation` names the first failed dependency in one sentence, in the Electron order, so that Studio can show it unchanged.

**Change to the limitation text (Stage 5).** Most Electron sentences end with "Run the server's /install-airplay.sh installer as root." That remedy is wrong on Edge: the installer compiles UxPlay on the host, and Edge carries UxPlay in its release. Edge keeps the Electron sentences and order, and ends the UxPlay sentences with "Install a Tilecast Edge release that includes it." Edge adds sentences for dependencies that the Electron Player does not have:

- The unit is not installed yet (the control socket is missing or nothing answers). This sentence is first, because no probe answer exists: "The AirPlay receiver service is not installed yet. It arrives with the next Tilecast Edge update."
- In the place of the Electron GStreamer and decoder checks: the renderer is not connected, or it does not advertise `external-presentation-video-v1` with a decoder. The sentences are "The display renderer is not connected, so AirPlay video cannot be shown." and "No supported H.264 decoder was found; the display renderer cannot show AirPlay video."

The Avahi sentence is the Electron sentence. A software decoder is a quality limitation, as on the Electron Player, with the sentence "Hardware H.264 decoding is unavailable; use 720p30 to limit CPU load." `airplayMaxProfile` is `1080p30` with a hardware decoder and `720p30` without one.

The command results use the Electron codes: `airplay_started`, `airplay_not_ready` (with the limitation sentence), `airplay_prepare_failed` (a payload field is not valid), `emergency_takeover_active`, `airplay_stopped`, `airplay_already_stopped`, and `airplay_supported`. Edge adds `airplay_group_unsupported`. When a start fails, the result has the supervisor's code (for example `uxplay_start_failed`) or the code of the Presentation Network helper.

The capability is `external_presentation.airplay`. The category already exists in `crates/player-types/src/capability.rs`. [`tilecast-edge-capabilities.md`](tilecast-edge-capabilities.md) gets its row when Stage 5 merges.

## 8. Presentation Network binding

The Presentation Network client already exists (`apps/edge/tilecastd/src/presentation_network.rs`). It uses the unchanged root helper `tilecast-networkd`. This amendment adds only the binding to a session:

1. Before `start`, if the payload has `presentationNetworkId`, `tilecastd` activates that network through the existing connect path. The command fails with the helper's stable code if the connection fails.
2. After stop, expiry, or failure, `tilecastd` deactivates the network and restores the radio state.
3. If Ethernet stops being the default route, `tilecastd` stops the session and reports `ethernet_default_route_lost`.

Stage 5 joins through `PresentationNetwork::join_for_session`. It uses the existing connect path, and the payload's `presentationNetworkId` must be the assignment of this player (`presentation_network_not_assigned` otherwise). The join checks the default route once. While the session runs, `tilecastd` checks the route again every 15 seconds. `leave_for_session` leaves the network and restores the radio state from the persisted record.

The credential path does not change. `tilecastd` fetches the credential only to install a profile, and it never stores it.

A new Edge installation (not a migration) does not install `tilecast-networkd`. The operator runs the Server-published `install-presentation-network.sh`. The public install page for Edge says so (Stage 6).

**Change from the first version of this amendment (Stage 6).** The first version said that the script grants its socket group to the `tilecast` account by default. That is true only when root runs the script directly. The script uses `SUDO_USER` first, so `curl … | sudo bash` grants the group to the administrator who ran `sudo`, and `tilecastd` cannot reach the helper. The Edge install page therefore gives `--user tilecast`. The script does not change.

## 9. Discovery

UxPlay advertises `_airplay._tcp` and `_raop._tcp` through the host `avahi-daemon` over the system D-Bus (`avahi-compat-libdns_sd`). The release carries the compatibility library. avahi-daemon is a host service that the operator installs. `tilecastd` already uses Avahi for LAN discovery (M5). If avahi-daemon is missing, the probe reports a limitation and AirPlay stays unavailable. Signage is not affected.

The unit advertises only while a session is active. It does not create a permanent advertisement.

## 10. Network contract

The ports are the existing AirPlay firewall contract ([`airplay-present.md`](airplay-present.md)):

| Purpose                          | Ports                   | Bind                                                                         |
| -------------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| UxPlay AirPlay control and media | TCP and UDP 37000–37002 | all interfaces, session only                                                 |
| Forwarded H.264 RTP              | UDP 42000               | `127.0.0.1` only, by the renderer's main process while a grant exists (§5.1) |
| Forwarded L16 audio RTP          | UDP 42002               | `127.0.0.1` only, by the renderer's main process while a grant exists (§5.1) |
| Bonjour/mDNS                     | UDP 5353 (avahi-daemon) | host                                                                         |

The single-screen RTP stream never leaves the screen. A future group amendment must define how loopback and LAN receivers share these ports.

## 11. Licensing

UxPlay is GPL-3.0 (version 3 or later). Edge ships it as a separate program in the release tree, and no Tilecast code links it. The release SBOM (`apps/edge/release/sbom.py`) lists it. The release carries the exact source archive (`share/tilecast/source/UxPlay-1.73.7.tar.gz`), the license, and a notice (`share/doc/tilecast-edge/licenses/uxplay/`).

`apps/edge/release/build-uxplay.sh` pins the archive:

| Input      | Value                                                              |
| ---------- | ------------------------------------------------------------------ |
| Version    | 1.73.7                                                             |
| Tag commit | `df67c212a433cf6dda3676dd40c097900d24e645` (`v1.73.7`)             |
| Archive    | `https://github.com/FDH2/UxPlay/archive/refs/tags/v1.73.7.tar.gz`  |
| SHA-256    | `65feb8732de666a7161a9e562aa603a7f5fe0ebb890c2a30c5e1a9c85c76309f` |

The tag archive was downloaded twice with the same SHA-256, and its tree is identical to the archive of the tag commit. The script builds without X11 and without `-march=native`, checks `uxplay -v`, and checks that `-h` lists every option that the supervisor uses.

The UxPlay build dependencies (libplist, OpenSSL, the Avahi DNS-SD compatibility library) are in `Dockerfile.builder`. Every change to that file changes the WPE inputs key (`inputs.py`). The first release after Stage 3 therefore compiles WebKit, unless `wpe-prebuild.yml` publishes the prebuild for the new key first. The libraries that parse sender input (libplist, OpenSSL) and the DNS-SD library are in `system-baseline.txt`, so Debian keeps them patched. `avahi-daemon` is in the baseline too.

## 12. Stages

Each stage is a separate pull request. Each pull request stacks on the one before it.

| Stage | Scope                                                                                                                                                                                       | Acceptance evidence                                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | This amendment and the threat review. Pointer updates in the Edge documents.                                                                                                                | `make docs-check`. The user approves the decision.                                                                                                                                                                                                                                  |
| 2     | `tilecast-airplay` crate, units, `sysusers.d` entry, `edge-protocol` messages and fixtures.                                                                                                 | A Rust and fixture test suite. An integration test with a fake `uxplay` under real systemd in the Linux image: peer refusal for the renderer cgroup, no orphan after `SIGKILL` of the supervisor, no PIN in argv or logs.                                                           |
| 3     | Release bundling: build UxPlay 1.73.7 in `release/Dockerfile.builder`; `runtime_closure.py`; `system-baseline.txt` (avahi-daemon); SBOM, source, and notice.                                | `run-closure-check.sh` and `run-sandbox-check.sh` pass. `uxplay -v` reports 1.73.7 in the packaged sandbox. `-vrtp`, `-artp`, `-rc`, and `-pin` are confirmed in 1.73.7.                                                                                                            |
| 4     | Renderer relay and `tcpresent` element, media-socket `present` grant, `renderer.ready` feature, Runtime external-presentation video view, capture exclusion. The latency spike comes first. | The recorded latency measurement (§5.3). The relay test with real loopback UDP and `unixfdsrc` (`tests/test_present_relay.c`). Media and IPC fixtures with Rust and C tests. Runtime unit tests for the capability gate. The headless end-to-end test moves to Stage 5 (see below). |
| 5     | `tilecastd` session: command handlers, migration `0014`, priority (a Player Core host hook, §6.1), Presentation Network binding, heartbeat, capability.                                     | Crash-point tests for every transition. A command redelivery test. A takeover-during-session test. The headless `airplay` scenario under systemd (`ci/run-airplay-e2e.sh`). `python3 scripts/ci/check-player-architecture.py`.                                                      |
| 6     | Public documentation and qualification.                                                                                                                                                     | The manual procedure in [`airplay-present.md`](airplay-present.md) (single-screen steps) on Edge reference hardware with iPhone, iPad, and Mac senders, recorded in the qualification ledger.                                                                                       |

**Change to the Stage 4 evidence.** The headless end-to-end test needs `tilecastd` to issue the grant and to project the `external-presentation` document. That is Stage 5. Stage 4 therefore records the latency measurement, which runs WebKit, the relay, and the `tcpresent` element with a synthetic RTP stream and a fake grant, and the component tests. Stage 5 adds the end-to-end scenario to `apps/edge/renderer-wpe/tests/e2e_headless.py`: a real `tilecastd`, the real supervisor with the fake UxPlay, synthetic RTP to 42000 and 42002, the Runtime showing the video, and capture excluded.

Until Stage 6 is recorded, the readiness documents must not show AirPlay on Edge as available, and an AirPlay-dependent screen must stay on the Electron Player.

## 13. Changes to binding documents

Stage 2 makes these changes:

- [`tilecast-edge.md`](tilecast-edge.md) §4 adds `tilecast-airplay` as a fourth Edge process (§4.5). It is unprivileged and it is the only Edge process that starts a program.
- §3 no longer lists AirPlay as out of scope. Group AirPlay is still out of scope.
- `apps/edge/AGENTS.md` adds the fixed decision for the unit.
- [`tilecast-edge-future.md`](tilecast-edge-future.md) keeps a row for group AirPlay.

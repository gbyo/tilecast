# Tilecast Edge remote web threat review

**Status:** Binding for Edge M11 remote web (Websites, YouTube, `presentation.kind = "web"` Widgets and remote web inside Layouts).
**Date:** 2026-09-26
**Scope:** The untrusted web process `tilecast-web-renderer-wpe`, its unit `tilecast-web-renderer.service`, its account `tilecast-web`, the frame transport, the renderer and runtime contracts for remote web, and the daemon changes that route remote web. The proof of the frame transport is [`tilecast-edge-m11-remote-web-spike.md`](tilecast-edge-m11-remote-web-spike.md).
**Rule:** A change to the boundaries in this document needs an update to this document in the same change ([`tilecast-edge.md`](tilecast-edge.md) §19 rule 12).

## 1. Decision

Arbitrary remote web content runs only in a separate process with a separate account and a separate systemd sandbox. That process has no Tilecast credential, state, content or socket. The trusted Player Runtime shows the pages as ordinary media surfaces. The pixels arrive as file-descriptor-backed frames.

```text
Tilecast Server
      │ HTTPS, device credential
      ▼
tilecastd  (tilecast, tilecast-edge.service)
      │ /run/tilecast-edge/edge.sock  (IPC v1, renderer role)
      ▼
tilecast-renderer-wpe  (tilecast + group tilecast-web, tilecast-renderer.service)
      │ TilecastRuntimeHostV1, remoteWeb: "host-view"
      ▼
@tilecast/player-runtime in tilecast://runtime/index.html
      │ HostRemoteWebSurface → <video src="tcweb://cap/<64 hex>">
      ▼
trusted runtime DOM compositor (Layout zones, transitions, clipping)
      ▲
      │ frames: /run/tilecast-web/frames/<capability>.sock
      │ unixfdsink → unixfdsrc (tcwebsrc), SCM_RIGHTS, memfd or DMA-BUF
      │
      │ control: /run/tilecast-web/control.sock (remote web protocol v1)
      ▼
tilecast-web-renderer-wpe  (tilecast-web, tilecast-web-renderer.service)
      │ one headless WPE WebView per surface, one WebKit network session per data profile
      ▼
Internet
```

## 2. Trust boundaries

| Boundary | Trusted side                 | Untrusted side                       | Control                                                            |
| -------- | ---------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| B1       | Tilecast Server              | the screen                           | device credential, installation identity (unchanged)               |
| B2       | `tilecastd`                  | renderer                             | IPC v1, `SO_PEERCRED`, closed messages (unchanged)                 |
| B3       | trusted runtime document     | renderer host code                   | `TilecastRuntimeHostV1`, closed members                            |
| B4       | renderer                     | remote web helper                    | remote web protocol v1, UID check, bounds, opaque capabilities     |
| B5       | remote web helper UI process | WebKit web processes of remote pages | WebKit process model, bubblewrap, navigation and permission policy |
| B6       | the screen                   | remote web servers                   | TLS validation, host allowlist, data profiles                      |

The helper is treated as compromised in the analysis below. B4 and the systemd sandbox of the helper must hold even when the helper runs attacker code.

## 3. Processes and accounts

| Process                                              | Account                                        | Unit                            | Holds                                                         |
| ---------------------------------------------------- | ---------------------------------------------- | ------------------------------- | ------------------------------------------------------------- |
| `tilecastd`                                          | `tilecast`                                     | `tilecast-edge.service`         | device credential, `state.db`, CAS, `edge.sock`, `media.sock` |
| `tilecast-renderer-wpe` and its WebKit processes     | `tilecast`, supplementary group `tilecast-web` | `tilecast-renderer.service`     | the trusted runtime; no credential, state or CAS (unchanged)  |
| `tilecast-web-renderer-wpe` and its WebKit processes | `tilecast-web`                                 | `tilecast-web-renderer.service` | remote pages, remote website data                             |

- `tilecast-web` is a system account from `sysusers.d` with no login shell, no home directory outside its state directory and no supplementary group except `render` (GPU render nodes) and `audio` (§11).
- `tilecast-web` is not a member of `tilecast`, `tilecast-display`, `tilecast-network`, `video` or `input`.
- The group `tilecast-web` has no members. Only `tilecast-renderer.service` joins it with `SupplementaryGroups=`, so only the renderer can reach the helper's sockets. `tilecastd` cannot. The pattern is the same as `tilecast-display` (§4.3 of the architecture).
- The helper starts no process except the WebKit auxiliary processes that WPE WebKit starts itself.

## 4. Filesystem visibility of the helper

| Path                                               | Access                                           | Reason                                         |
| -------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| `/opt/tilecast-edge/current/`                      | read                                             | the helper binary and the release's WPE WebKit |
| `/usr`, `/etc` (system libraries, fonts, CA store) | read                                             | `ProtectSystem=strict`                         |
| `/var/lib/tilecast-web/`                           | read and write, 0700 `tilecast-web`              | persistent remote website data profiles        |
| `/var/cache/tilecast-web/`                         | read and write, 0700                             | WebKit cache of the persistent profiles        |
| `/run/tilecast-web/`                               | read and write, 0750 `tilecast-web:tilecast-web` | control socket and frame sockets               |
| `/var/lib/tilecast-edge/`                          | none                                             | `InaccessiblePaths=`, and mode 0700 `tilecast` |
| `/run/tilecast-edge/`                              | none                                             | `InaccessiblePaths=`, and mode 0750 `tilecast` |
| `/run/tilecast-edge-update/`                       | none                                             | `InaccessiblePaths=`                           |
| `/run/tilecast/` (Presentation Network helper)     | none                                             | `TemporaryFileSystem=/run/tilecast:ro`         |
| `/var/cache/tilecast-renderer/`                    | none                                             | `InaccessiblePaths=`                           |
| `/home`, `/root`, `/run/user`                      | none                                             | `ProtectHome=yes`                              |
| `/tmp`                                             | private                                          | `PrivateTmp=yes`                               |

The helper never receives a path. Every path it opens comes from its own command line (fixed in the unit) or from a capability that it generated itself.

The helper's unit does not set `ProtectKernelTunables=`, `ProtectKernelLogs=` or `RestrictSUIDSGID=`. Each one stops WebKit's bubblewrap sandbox from starting a web process, and that sandbox is the boundary that matters most for remote pages. The helper is an ordinary account with an empty capability set and `NoNewPrivileges=yes`, so it cannot write `/proc/sys` or `/sys`, read the kernel log or use a setuid file. The evidence and the full list of directives that were tested are in [`tilecast-edge-sandbox-review.md`](tilecast-edge-sandbox-review.md) §4. The helper clears `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS` at start in every release build.

## 5. Unix sockets

| Socket                                       | Owner and mode                   | Listener              | Allowed peer                                                                  |
| -------------------------------------------- | -------------------------------- | --------------------- | ----------------------------------------------------------------------------- |
| `/run/tilecast-web/control.sock`             | `tilecast-web:tilecast-web` 0660 | helper                | peer UID of `tilecast` (checked with `SO_PEERCRED`), one connection at a time |
| `/run/tilecast-web/frames/<capability>.sock` | `tilecast-web:tilecast-web` 0660 | helper (`unixfdsink`) | members of `tilecast-web`: the renderer's web process                         |

- The renderer is the only client. A second control connection closes the first one and destroys every surface of the first one.
- The helper cannot connect to `edge.sock`, `media.sock` or `update.sock`. The directories are not visible in its mount namespace, the modes refuse its UID, and `tilecastd` checks `SO_PEERCRED` again.
- A frame socket carries only video frames and GStreamer events. The trusted side never sends data to the helper except the release notices of `unixfdsrc`.

## 6. The remote web protocol v1 (renderer ↔ helper)

The protocol is JSON over the control socket with the Edge framing: a big-endian `u32` length and one UTF-8 JSON object. The fixtures are in `packages/edge-protocol/fixtures/remote-web/`. The C tests of both programs read them.

- A frame larger than 64 KiB, a frame of length zero, invalid UTF-8, an unknown `type`, an unknown member, a missing member, or a value outside its bound closes the connection.
- Requests (renderer to helper): `hello`, `create`, `resize`, `visible`, `mute`, `reload`, `destroy`, `clear-data`.
- Replies and events (helper to renderer): `welcome`, `created`, `rejected`, `event`, `cleared`.
- There is no request that runs script, sends a message to a page, reads page content, sets a header, sets a cookie or names a path.

### 6.1 Bounds

The limits come from the spike measurements (software path, one 720p surface costs about 100 MB in the trusted process and more than two cores at 60 fps) and from the Layout limits.

| Item                        | Bound                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live surfaces               | 4, including warm surfaces                                                                                                                                    |
| Warm surfaces               | 2, each for at most 300 s                                                                                                                                     |
| Pixels of one surface       | 3840 × 2160 at most, each edge at least 16                                                                                                                    |
| Pixels of all live surfaces | 8 294 400 (one 4K frame)                                                                                                                                      |
| URL                         | 2048 bytes, `https:` or `http:`, no user information                                                                                                          |
| Allowed hosts               | 25 entries, each at most 253 bytes, lowercase DNS names or IPv4 literals; IPv6 literals are rejected at authoring because no remote web player navigates them |
| Custom User-Agent           | 256 printable ASCII bytes                                                                                                                                     |
| Zoom                        | 25 to 500 percent                                                                                                                                             |
| Scroll offset               | 0 to 100 000 pixels                                                                                                                                           |
| Surface identifier          | `[a-z0-9-]{1,48}`, chosen by the runtime                                                                                                                      |
| Requests in flight          | 8 creates or clears; more closes the connection                                                                                                               |
| Events                      | 32 a second to the renderer; the helper coalesces repeated events of one surface                                                                              |
| Trusted-side inbound budget | 64 frames a second from the helper; sustained excess closes the connection                                                                                    |
| Renderer outbound queue     | 16 frames; resize/visible/mute/reload coalesce per surface, a full queue closes the connection                                                                |
| Renderer write deadline     | 2 s for the head frame; a helper that stops consuming data is disconnected                                                                                    |
| Frame queue                 | 1 frame (leaky), the latest frame wins                                                                                                                        |
| Frame rate                  | 60 fps with a GPU; 30 fps on the software path                                                                                                                |
| Idle repeat                 | the latest frame again after 1 s without a new frame                                                                                                          |
| Control frame               | 64 KiB                                                                                                                                                        |

The runtime has the same bounds for reload interval (30 s to 86 400 s) and load timeout (5 s to 120 s), because it owns those timers.

The helper-side event deferral (32 a second) is a courtesy, not a security boundary: a compromised helper can ignore it. The boundary is the trusted-side inbound budget above, which runs in the renderer and closes the connection on sustained floods of otherwise-valid frames.

## 7. Frame transport and capabilities

- The helper creates one frame socket for each surface. The name is the capability: 32 bytes from the kernel CSPRNG as 64 lowercase hexadecimal characters.
- The runtime receives only `tcweb://cap/<capability>`. It receives no socket path, file descriptor, process ID or helper path. `tcwebsrc` accepts only that exact form and builds the path from the fixed frame directory and the validated capability, in the same way the CAS builds a path from a digest.
- The helper deletes the socket and stops its `unixfdsink` when the surface is destroyed, when its view fails permanently, when the control connection closes (a renderer restart or reconnect) and when the helper exits. A capability is therefore scoped to one renderer connection and one surface. A stale or guessed capability names no socket.
- The frames contain pixels only. A compromised helper can send wrong pixels or malformed buffers to the renderer's GStreamer pipeline. That is the same exposure the renderer has to a malicious video file, and it runs in the renderer's sandboxed WebKit web process.
- On the GPU path the helper copies each frame once, on the GPU, into a buffer that it owns, and waits for the copy before it sends the buffer. A zero-copy export of WebKit's own buffer is not used, because WebKit reuses that buffer without waiting for the consumer (spike §4).

## 8. Browser data ownership

WebKit website data never mixes between the trusted runtime and remote pages, and never mixes between cookie policies.

| Cookie policy           | Network session                                | Cookie acceptance                            | Storage                                                                             |
| ----------------------- | ---------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `disabled`              | a new ephemeral session for each surface       | `WEBKIT_COOKIE_POLICY_ACCEPT_NEVER`          | memory only, deleted with the surface                                               |
| `first_party`           | one persistent session, `profiles/first-party` | `WEBKIT_COOKIE_POLICY_ACCEPT_NO_THIRD_PARTY` | `/var/lib/tilecast-web/profiles/first-party`, `/var/cache/tilecast-web/first-party` |
| `first_and_third_party` | one persistent session, `profiles/all`         | `WEBKIT_COOKIE_POLICY_ACCEPT_ALWAYS`         | `/var/lib/tilecast-web/profiles/all`, `/var/cache/tilecast-web/all`                 |

- Each cookie policy has its own `WebKitNetworkSession` and so its own `WebKitWebsiteDataManager` and `WebKitCookieManager`. The helper never changes the cookie policy of a session after it creates the session, so two live surfaces with different policies cannot affect each other.
- Intelligent Tracking Prevention is off in every session (`webkit_network_session_set_itp_enabled (FALSE)`). ITP can block the cookies of classified third-party domains even under `ACCEPT_ALWAYS`, which would change the meaning of `first_and_third_party`.
- `dom_storage_enabled = false` turns off local storage and IndexedDB for the page through `WebKitSettings`. `disabled` cookies always use the ephemeral session, so no page data persists for that policy.
- The trusted renderer's own ephemeral network session is in another process under another account. It is not reachable from the helper.
- `clear_website_data` clears both persistent profiles (every data type with `webkit_website_data_manager_clear`) and the ephemeral sessions of live surfaces. It never touches the trusted renderer. `tilecastd` never opens the helper's directories.

## 9. Navigation and permission policy

The policy is a pure function (`policy.c`) with unit tests. It follows Android's `WebsiteNavigationPolicy`:

- Allowed schemes: `https:`; `http:` only when the configured URL is `http:`. No `file:`, `data:` (for navigation), `blob:` (for navigation), `about:` except `about:blank`, `javascript:`, `tilecast:`, `tcmedia:`, `tcweb:` or any other scheme.
- The host must equal one entry of `allowedHosts`, compared in lowercase after the trailing dot is removed. There is no wildcard and no suffix match.
- No user information in the URL. Only the default port of the scheme.
- WebKit 2.54 does not tell a `decide-policy` handler which frame a navigation action targets. The helper therefore enforces the policy at three points:
  - `decide-policy` (`WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION`) refuses local and custom schemes in every frame (`tc_policy_any_frame`). Frames may still load network URLs, `about:blank`, `about:srcdoc`, `data:` and `blob:`, because pages build frames from them.
  - `notify::uri` of the view reports each main-frame provisional URL and each redirect hop. A URL outside the allowlist stops the load and sends `navigation-blocked` with the code `blocked_navigation`. An empty URI, which WebKit sets when a provisional load fails, is not a navigation.
  - The main-frame response decision (`webkit_response_policy_decision_is_main_frame_main_resource`) checks the final URL again before the document commits.
- The runtime treats `navigation-blocked` as a Website failure, as Android does. A page can make the device send a request to a host outside the allowlist, as it can with `fetch`; it can never show that host's document.
- A main-frame response with an HTTP status of 400 or more fails the surface with `http_error`, as on Android.
- `WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION` is always refused. `javascript_can_open_windows_automatically` is off.
- `WEBKIT_POLICY_DECISION_TYPE_RESPONSE` refuses every response that WebKit cannot show, so downloads never start. The `download-started` signal of each network session cancels any download.
- `permission-request` refuses every request: camera, microphone, geolocation, notifications, clipboard, media key systems, pointer lock, device information and website data access.
- `run-file-chooser` cancels. `script-dialog` handles every alert, confirm, prompt and before-unload dialog without an answer: `alert` returns, `confirm` returns false, `prompt` returns null. `authenticate` cancels, because Website credentials are out of scope. `load-failed-with-tls-errors` fails the surface with `tls_failure`, and the network sessions keep `WEBKIT_TLS_ERRORS_POLICY_FAIL`.
- The helper registers no custom URI scheme for remote pages. WebKit asks `decide-policy` before it launches an external protocol, and the policy refuses every unknown scheme.
- Web MIDI, WebRTC capture and gamepads are off in `WebKitSettings`. `enable-developer-extras` is off.
- The logs carry the host of a blocked URL and never its path or query.

## 10. No native bridge in a remote page

- The helper creates remote views with a `WebKitUserContentManager` that has no script message handler and no user script. A remote page sees `globalThis.tilecastRuntimeHost === undefined` and `globalThis.webkit === undefined`.
- The helper uses `webkit_web_view_call_async_javascript_function` in a private script world only for two fixed functions: apply the scroll offset (two numbers as arguments) and read the YouTube wrapper state (§12). No function body is built from strings.
- The trusted runtime's bridge exists only in `tilecast://runtime/` in the trusted renderer, which loads nothing else.

## 11. Audio

- A surface starts muted. The runtime unmutes it only while it is visible and `audioEnabled` is true, with `webkit_web_view_set_is_muted`. `pause` and `destroy` mute before anything else, so a hidden or stale surface is never audible.
- WebKit plays the page's audio itself, through GStreamer in the helper's web process. No audio crosses the frame socket, the renderer or `tilecastd`.
- The helper unit gets `char-alsa` devices (`DeviceAllow`) and the `audio` group so an unmuted page can play. Device access is otherwise closed (`DevicePolicy=closed`): cameras, input, disks and other host devices stay denied even under full helper compromise. Physical audio routing with the trusted renderer on the same device is an M11 hardware qualification item.
- Residual risk, stated plainly: `permission-request` refuses the microphone to non-compromised pages, but under full helper compromise (arbitrary code as `tilecast-web`, §13.2) raw ALSA capture nodes are reachable wherever microphone hardware exists, because stock distributions grant playback and capture nodes to the same `audio` group. A hard output-only boundary would need a session audio broker (PipeWire/PulseAudio for the helper account) that the M11 targets do not run; GStreamer sink selection is not pinned to one. Operators who need capture to be impossible should use microphone-less signage hardware — confirming this is part of the M11 hardware qualification.
- WebKit has no per-view volume. A Website's `volume` is not applied; the capability reports this and the documentation says so. The YouTube wrapper applies the author's volume through the documented `setVolume` call (§12).

## 12. YouTube

The Studio YouTube Widget promises start and end times, looping, captions and caption language, controls, muting, a volume, "play until the video ends" and failure behavior. An embed URL cannot express the volume, the end of the video or a player error, so Edge uses the documented IFrame Player API inside a Tilecast-owned wrapper page in the helper.

- The wrapper is a fixed HTML page compiled into the helper. The helper loads it with `webkit_web_view_load_html` and the fixed base URL `https://org.tilecast.player/`. YouTube requires an HTTPS Referer that names the application in reverse-DNS form ([Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality)); without one the embed fails with error 153. The value is a constant. Authors and the server cannot set a Referer or any other header.
- The wrapper creates an `<iframe>` for `https://www.youtube-nocookie.com/embed/<id>` with documented parameters only (`enablejsapi`, `origin`, `autoplay=0`, `playsinline`, `controls`, `start`, `end`, `loop` with `playlist`, `list` with `listType=playlist`, `cc_load_policy`, `cc_lang_pref`, `rel=0`, `disablekb`, `fs=0`). It then attaches `new YT.Player(iframe, {events})`, as the API documentation describes for an existing iframe.
- YouTube content stays cross-origin in its own frame. The wrapper and YouTube talk only through the IFrame API's `postMessage`, which checks the origin.
- The wrapper writes one state token (`loading`, `ready`, `playing`, `ended`, `error:<code>`) into an attribute of its own document. The helper reads it with a fixed function in its private script world. The wrapper has no message handler, and no page can call the helper.
- The typed parameters (video or playlist ID `[A-Za-z0-9_-]{6,128}`, integer seconds, a volume 0 to 100, a language code) are validated by the renderer and again by the helper, and are written into the wrapper as a JSON document, never as script.
- Allowed main-frame hosts for the wrapper view: none except the wrapper itself. Allowed subframe hosts: `www.youtube-nocookie.com` and `www.youtube.com`.
- Playback starts only when the runtime makes the surface visible (`visible`), because an embedded player must not start playback before it is visible.
- The runtime refuses a second YouTube surface on one screen, and a YouTube surface smaller than 200 × 200 CSS pixels, with typed errors. The server Layout validation refuses the same Layouts first.

## 13. Compromise analysis

### 13.1 Arbitrary JavaScript compromises a WebKit web process of the helper

The attacker runs native code as `tilecast-web` inside WebKit's bubblewrap sandbox. The sandbox exposes only what WebKit gives a web process: no home directory, no D-Bus, no host `/run`.

- It cannot read the device credential, `state.db`, CAS objects, `edge.sock`, `media.sock` or `update.sock`: they are not in its mount namespace, and their modes refuse `tilecast-web`.
- It can read what its own page can read: the data of its data profile.
- It can use the network like the page.

### 13.2 The attacker compromises the helper's UI process

The attacker runs code as `tilecast-web` with the helper unit's sandbox.

- It can read and change every remote website data profile.
- It can send any frames and any events of the remote web protocol v1 to the renderer. The renderer validates each event, and the runtime handles a wrong event as a Website failure or recovery. It cannot send a message outside the protocol, because the renderer parses only the closed set.
- It can make the renderer's GStreamer pipeline parse malformed video buffers. That runs in the renderer's sandboxed web process without the credential.
- It cannot reach anything in §4 marked "none". It has no capability (`CapabilityBoundingSet=`, `NoNewPrivileges=yes`), so it cannot change user, load a module, open a raw socket or ptrace a process of another account.
- Its device reach is DRM render nodes and ALSA audio nodes only (`DevicePolicy=closed` with `DeviceAllow` for `char-drm` and `char-alsa`). Microphone capture through ALSA remains the stated residual risk of §11 wherever microphone hardware exists.
- It cannot connect to `tilecastd` and cannot become a renderer, because `edge.sock` refuses its UID and its directory is hidden.

### 13.3 Why remote content can never acquire Tilecast credentials, media or state

The credential and state are files of `tilecast` in `/var/lib/tilecast-edge` (0700). Media bytes leave `tilecastd` only over `media.sock`. The helper runs as another UID, and its unit hides all three paths. The only channel from the helper to Tilecast is the control socket, where the helper is the server and the renderer sends only surface requests. The renderer sends no credential, no manifest and no path over it, because it has none.

## 14. Denial of service

- The helper has `MemoryHigh=` and `MemoryMax=` (1 GiB and 1.5 GiB) and `TasksMax=512`: a page cannot take more than 1.5 GiB of memory or more than 512 processes from the machine, whatever it does. When the kernel kills a WebKit web process, the view's `web-process-terminated` signal fails that surface with `renderer_crash`.
- `CPUWeight=50` is a scheduler weight, not a quota: under contention the helper is deprioritized relative to the trusted renderer, but it is not capped, because any cap low enough to bound a hostile page would also throttle legitimate software rendering (the software path costs more than two cores at 60 fps). CPU is bounded instead by behavior, not by quota: the renderer's trusted-side inbound budget disconnects a flooding helper (64 frames a second), the outbound channel is bounded with a write deadline, the runtime fails pages that never load or stop producing frames, and a crashed web process fails only its surface. A page can still spend CPU inside its own helper; it cannot spend the renderer's main loop or its memory.
- The trusted side keeps only the latest frame. A slow page produces fewer frames; it never fills a queue in the renderer. The renderer's control reads are asynchronous, and a reply that never comes is bounded by the runtime's load timeout.
- The renderer's control writes never block its main loop either: they are queued on a bounded (16-frame) asynchronous channel with a 2 s write deadline (`apps/edge/renderer-wpe/src/rw-channel.c`). A helper that stops consuming data, or update chatter past the queue bound, disconnects into the existing reconnect path instead of stalling unrelated playback. Resize/visible/mute/reload updates coalesce per surface so chatter cannot grow the queue. A dispatched write cannot be recalled, so completions that arrive after disconnect — or after the channel is freed at shutdown — validate against the channel's identity record, which outlives the channel, and return without touching freed state.
- The software path sends at most 30 frames a second, because the trusted compositor pays the upload cost (spike §3.1).
- A page that never finishes loading is failed by the runtime's load timeout. A page that stops rendering is detected when the idle repeat stops: the runtime fails a surface that has no frame for 5 s.
- The renderer reconnects to the helper with a bounded backoff and never blocks its main loop on the helper.

## 15. Crash and restart behavior

- `tilecast-web-renderer.service` has `Restart=always` and `RestartSec=2`. Non-web playback never depends on it.
- A helper exit closes the control connection. The renderer sends `process-terminated` for each live surface to the runtime. The runtime fails those surfaces through the existing Website failure, fallback and back-off path, and the other content keeps playing.
- The renderer reconnects when the helper is back, then sends a `recovered` event. The next remote surface that loads reports the existing Website recovery (`reportRecovered`).
- A crash of one remote web process fails only its surface. The trusted runtime never reloads for it.
- A renderer restart closes the control connection, so the helper destroys every surface and revokes every capability. The restarted runtime creates new surfaces for the current activation.
- A daemon restart does not touch the helper or the renderer.

## 16. Renderer and daemon rules

- The renderer advertises `remote-web-v1`, `website` and `youtube` in `renderer.ready` only when the helper answered `welcome` within 5 s of start. It sends `renderer.ready` again with those features when the helper appears later. A helper crash after that is a degraded health reason (`remote_web_helper_restarting`), not a feature change.
- `tilecastd` requires `remote-web-v1` for a presentation from the explicit presentation features it computed, not from provider names. A presentation that needs it is not sent to a renderer without it; the screen shows the typed incompatibility.
- `clear_website_data` is a closed renderer command. The renderer answers `renderer.command_result` with the helper's result. A helper that is not connected answers `remote_web_unavailable`. A renderer that disconnects before it answers fails the command with `renderer_disconnected`. The command is idempotent.

## 17. Updates and migration

- The helper is part of the signed Edge release (`bin/tilecast-web-renderer-wpe`), listed in the release manifest and the SBOM, and loads the release's WPE WebKit through `current`.
- The M10 activation stops the helper before it stops the renderer and the daemon, because the helper maps files under `current`. It starts the daemon, then the helper, then the renderer. A rollback uses the same order.
- The installer creates `tilecast-web` with `sysusers.d`, and `/var/lib/tilecast-web` and `/var/cache/tilecast-web` with `tmpfiles.d`. The migrator does not import Electron website data (§14.2 of the architecture).
- Removal deletes the unit, the account and the two directories. Remote website data is not part of a support bundle.
- The migration self-test runs a deterministic local web fixture only when the candidate presentation needs remote web. A helper failure fails the migration only in that case.

## 18. Tests that hold these boundaries

| Boundary                                                                     | Test                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| No bridge in a remote page                                                   | helper security test: a page reports `typeof tilecastRuntimeHost`, `typeof webkit`   |
| Navigation, redirects, schemes, popups, downloads, permissions, dialogs, TLS | helper security test against a local fixture server                                  |
| Pure policy                                                                  | `test-policy` (C unit test)                                                          |
| Protocol bounds and closed messages                                          | `test-protocol` against the fixtures, oversized frames, huge allowlists              |
| Renderer backpressure and inbound flood budget                               | `test-rw-channel`: non-reading helper, queue bound, coalescing, stale callbacks      |
| Capability guessing and use after destroy                                    | helper security test                                                                 |
| Data profiles and clearing                                                   | helper data test: cookies and local storage per policy, `clear-data`                 |
| Unit sandbox (credential, state, sockets, devices)                           | `ci/run-migrate-e2e.sh` runs the helper unit under real systemd and probes each path |
| Crash isolation                                                              | helper crash tests in `renderer-wpe/tests/e2e_headless.py` and the real-server test  |

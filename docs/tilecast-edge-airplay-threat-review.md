# Tilecast Edge AirPlay receiver: threat-boundary review

This review covers the single-screen AirPlay receiver that [`tilecast-edge-airplay.md`](tilecast-edge-airplay.md) proposes: the `tilecast-airplay` supervisor and its units, the bundled UxPlay, the renderer `tcpresent` source, and the session code in `tilecastd`. Read it before you change `apps/edge/tilecast-airplay`, its units in `apps/edge/packaging`, the `tcpresent` element, or the AirPlay command handlers in `tilecastd`.

The receiver adds no root privilege. Review rule 1 therefore does not require this document. It exists because the receiver adds the first Edge listener for untrusted LAN peers and the first Edge process that starts a program.

## 1. Trust boundaries

```text
 AirPlay sender (untrusted LAN or Presentation Network peer)
   | TCP and UDP 37000–37002, mDNS through avahi-daemon
   v
 uxplay (tilecast-airplay account; started by the supervisor)
   | decrypted H.264 RTP and L16 RTP to 127.0.0.1:42000 and :42002
   v
 renderer-wpe main process relay (tilecast account; tilecast-renderer.service;
   |                               host network namespace)
   | ^ grant: opaque capability to the fixed ports, from tilecastd only,
   | |  over the media socket
   | unixfdsink sockets in a private 0700 directory
   v
 WebKit web process tcpresent source (bubblewrap; own network namespace)
   |
 tilecastd (tilecast account; tilecast-edge.service)
   | /run/tilecast-airplay/control.sock  root:tilecast 0660
   | peer: tilecast UID and tilecast-edge.service cgroup only
   v
 tilecast-airplay supervisor (tilecast-airplay account; socket activated)
```

## 2. Assets

| Asset                       | Where it is                                                              | Who may read it                                                     |
| --------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Device credential           | `tilecastd` identity directory                                           | `tilecastd` only. Not changed.                                      |
| Presentation Network secret | Memory of `tilecastd` during a profile install, then `tilecast-networkd` | Not changed. Never crosses the AirPlay socket.                      |
| Session PIN and device ID   | Server command, `tilecastd` state row, supervisor `-rc` file             | `tilecastd`, the supervisor, UxPlay. Deleted when the session ends. |
| Mirrored frames and audio   | UxPlay, loopback RTP, renderer relay, relay sockets, web process         | Never sent to preview, Watch Live, snapshot, or the Server.         |
| Display                     | Renderer (DRM master)                                                    | Renderer only. UxPlay never draws.                                  |

## 3. The new account and unit

`tilecast-airplay` is a system account with no login shell and no home directory content. It is not a member of `tilecast`, `tilecast-display`, `tilecast-network`, `tilecast-web`, `video`, `render`, `input`, or `audio`. It therefore cannot reach the daemon state, the display, the CEC or I2C devices, the Presentation Network helper, the web helper, or an audio device.

The unit must have:

- `User=tilecast-airplay`, `NoNewPrivileges=yes`, an empty `CapabilityBoundingSet=`.
- `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`.
- `InaccessiblePaths=` for `/var/lib/tilecast-edge`, `/run/tilecast-edge`, `/run/tilecast-edge-update`, `/run/tilecast`, and `/run/tilecast-web`.
- `RuntimeDirectory=tilecast-airplay-session` with mode 0700 for the `-rc` file.
- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`. `AF_UNIX` is for the control socket and the system D-Bus.
- `ProtectKernelTunables=yes`, `ProtectKernelLogs=yes`, `ProtectKernelModules=yes`, `ProtectControlGroups=yes`, `RestrictSUIDSGID=yes`, `RestrictNamespaces=yes`, `LockPersonality=yes`, `MemoryDenyWriteExecute=yes`, `SystemCallFilter=@system-service`, `SystemCallArchitectures=native`. WebKit does not run in this unit, so the bubblewrap exceptions of the renderer unit do not apply. Stage 2 ran the unit with a fake UxPlay, so it cannot show how GStreamer in UxPlay behaves with `MemoryDenyWriteExecute=yes` and `SystemCallFilter=@system-service`. Stage 3 confirmed both with the packaged UxPlay 1.73.7 (`release/run-airplay-sandbox-check.sh`, Debian 13 with real systemd): UxPlay starts under this unit, builds its RTP pipelines (a pipeline that does not parse stops UxPlay at start), registers with avahi-daemon (UxPlay exits when registration fails), and opens TCP 37001. No seccomp or audit message names UxPlay. Stage 3 also confirms that UxPlay needs no `AF_NETLINK`. From the source: UxPlay calls `getifaddrs` (which uses netlink) only to find a MAC address when `-m` is not given, and the supervisor always gives `m` in the `-rc` file. `release/run-airplay-sandbox-check.sh` runs the packaged UxPlay under this unit with avahi-daemon.
- `KillMode=control-group`, so no `uxplay` process lives longer than the unit.
- `ProtectProc=invisible` and `ProcSubset=pid`. Because of this, the supervisor cannot read the peer's `/proc` entry, and the peer check reads the daemon unit's `cgroup.procs` instead (§4).

In the Stage 2 systemd test, `systemd-analyze security` gives the unit an exposure of 1.5.

The supervisor writes nothing outside its runtime directory. The release check (`run-sandbox-check.sh`) must start the unit with these options.

## 4. The control socket

The socket follows `tilecast-edge-update.socket`: `root:tilecast`, mode 0660. The supervisor checks the peer with `SO_PEERCRED` and refuses a peer whose UID is not `tilecast` or whose process is not listed in `/sys/fs/cgroup/system.slice/tilecast-edge.service/cgroup.procs`. The renderer and the session bridge use the `tilecast` UID, so the cgroup check is what refuses them. `ci/run-airplay-e2e.sh` tests the refusal of a `tilecast` process in `tilecast-renderer.service` and of root in `tilecast-edge.service`. A PID can be reused between `SO_PEERCRED` and the read; the update helper has the same window, and a process that wins it must already run as `tilecast` in the daemon's unit.

The supervisor serves one connection. It refuses other connections while it serves one.

Every message is bounded and strictly parsed. The supervisor refuses an unknown field. It takes no path, no program name, no port outside the fixed range, and no option string from a message.

## 5. The spawn boundary

The supervisor is the only Edge process that starts a program. Review rule 2 applies in full:

- It starts one program, at the fixed release path `bin/uxplay`.
- It builds the argument vector from typed values only. It never uses a shell.
- The `-vrtp` and `-artp` pipeline strings come from a fixed template. The only values in them are the two fixed port numbers.
- UxPlay gets a cleared environment with a fixed list of variables.
- The `-rc` file contains only the PIN and locally administered device ID. Both have fixed grammars. The receiver name stays one bounded, validated `execve` argument, so UxPlay's free-form startup-file parser never has to encode it.
- The video template uses `-vrtp` without `-vs 0`. UxPlay 1.73.7 already bypasses rendering for `-vrtp`; `-vs 0` would also advertise a 1 fps display limit to the sender. Edge does not enable `-h265`.

## 6. Untrusted senders

UxPlay parses network input from any peer that can reach TCP and UDP 37000–37002. This is the main new attack surface.

- UxPlay listens only during a session. The supervisor starts it after `start` and stops it at `stop`, expiry, or disconnect of `tilecastd`.
- The four-digit PIN (`-pin`) controls who can mirror. The Server generates a new PIN for each session.
- **What UxPlay 1.73.7 does after a wrong PIN** (`lib/raop_handlers.h`, `raop_handler_pairsetup_pin`): it logs `Client Authentication Failure (client proof not validated)` and answers RTSP 470. The PIN does not change, and the sender can try again at once. There is no attempt limit and no delay in `-pin` mode. The `MAX_PW_ATTEMPTS` limit applies only to `-pw` mode. A sender could therefore try all 10,000 PINs during a session. The supervisor counts the failure lines and ends the session after 10 (`pin_attempts_exceeded`, `MAX_PIN_FAILURES`), which gives a guessing sender a 0.1 % chance per session.
- A compromise of UxPlay gives the attacker the `tilecast-airplay` account inside the unit sandbox (§3). It does not give the device credential, the state database, the display, or a Presentation Network secret.
- The release pins UxPlay by version, tag commit, and SHA-256. A security fix in UxPlay arrives through an ordinary signed Edge release.

## 7. Loopback RTP injection

The renderer receives RTP on `127.0.0.1:42000` and `:42002`. Any local process can send UDP to those ports. A local process can therefore inject frames or audio into an active session. It cannot read the stream.

This risk is accepted for these reasons:

- A process that can send on loopback already runs on the signage host.
- The ports are open only during a session. The renderer's main process binds them only while `tilecastd` holds the present grant, and it stops within one second after the grant ends.
- The relay binds with `reuse=false`. A local process that binds a port first makes the relay fail. It cannot share the stream with the relay.
- The worst result is wrong video or audio on the screen during a session. Emergency Takeover still has priority.

A Unix-socket transport would remove the risk, but it needs a custom GStreamer source and sink on both sides. Revisit the decision if a deployment runs untrusted local accounts on the signage host.

## 8. The renderer

The renderer gets one new URI scheme, `tcpresent`. The page supplies only an opaque present capability (`tcpresent://cap/<token>`, 32 random bytes minted per grant and bound to the current renderer instance; it is not an AirPlay session ID). The renderer never takes an address, a port, or a path from the page or from the presentation document. The renderer unit does not change. WebKit's bubblewrap sandbox stays on, and no forbidden directive is added ([`tilecast-edge-sandbox-review.md`](tilecast-edge-sandbox-review.md) §4).

WebKit starts the web process with `--unshare-net`, so the web process cannot receive UDP from the host loopback (amendment §5.1). The relay keeps that boundary:

- The renderer's main process receives the RTP and copies each packet to a Unix socket in its private 0700 directory under the unit's private `/tmp`. The web process gets only that directory in its sandbox. Other units cannot see the directory, because `PrivateTmp=yes` gives the renderer unit its own `/tmp`.
- The main process starts the relay only for the `sourceId` of a `tilecastd` activation, and only after `tilecastd` answers the media-socket `present` request for that ID. It asks again each second and stops the relay when the answer is a denial.
- The media channel answers `present` only for a peer that is the current renderer or its child, with the same rule as media reads. A media or frame capability does not resolve as a present grant, and a present grant does not resolve as a media read.
- The web process never gets a network socket. A UDP socket from the host network namespace, passed with `SCM_RIGHTS`, would remove the copy. It would also let a compromised web process send UDP to any address on the network, which its own network namespace prevents now. That design was rejected.

Preview, snapshot, and Watch Live must not capture the external-presentation surface. Two layers enforce this (amendment §5.4):

- `tilecastd` treats the `external-presentation` state as protected (`CaptureState::ExternalPresentation`). It refuses a capture before it asks the renderer, and it discards a frame when the state changed during the capture.
- The renderer refuses a preview with `external_presentation` while the relay runs or waits for its grant. Watch Live gets black frames, and the renderer does not read the presented pixels. The renderer drops its last presented buffer when the relay stops, so a later capture cannot copy a mirrored frame.

Stage 4 tests the daemon state with unit tests and the relay with real sockets. The Stage 5 end-to-end scenario tests the complete path with a running renderer.

## 9. Discovery and D-Bus

UxPlay 1.73.7 uses the DNS-SD compatibility API. On Debian, `libavahi-compat-libdnssd` supplies that API and reaches the host `avahi-daemon`. The unit gets only the Unix socket or system-bus access that this packaged path proves it needs in the Stage 2 sandbox test. Do not grant a general desktop session bus, and do not enable UxPlay's `-scrsv` option.

The existing root `tilecast-networkd` boundary does not change. A fresh Edge installation receives that same helper and unit from the signed Edge release instead of running the Legacy Server install script. NetworkManager stays optional and outside the Edge updater's authority.

## 10. Secrets

- The PIN and the device ID never appear in a process argument, a log line, a heartbeat, audit metadata, or a fixture with a real value.
- The supervisor deletes the `-rc` file when UxPlay has opened its server sockets (it has read the file then), when the session ends, and when it starts. The file is created with `O_EXCL` and mode 0600, so a planted link is not followed.
- UxPlay prints the PIN on its output when a sender starts pairing (`raop_handlers.h`). The supervisor never logs or forwards a line of UxPlay output. `ci/run-airplay-e2e.sh` checks that a test PIN and device ID are in no `/proc/*/cmdline` and nowhere in the journal, with a fake UxPlay that prints the PIN on both outputs.
- `tilecastd` deletes the PIN and the device ID from SQLite when the session ends. The Server already clears them from the command row.
- The Presentation Network credential never crosses the AirPlay socket.

## 11. Edge review rules

| Rule                                                        | How the receiver meets it                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1. No new root privilege without a review                   | No root privilege. This review exists anyway (introduction).                                                       |
| 2. No shell with interpolated values                        | §5. `tilecastd` still starts no processes.                                                                         |
| 3. No arbitrary path from server, renderer, or legacy input | The supervisor takes no path. The relay and `tcpresent` build socket paths only from a validated opaque capability (§8).   |
| 4. Bound every read, body, frame, list, and string          | `edge-protocol` bounded types on the control socket (§4). UxPlay output is parsed with a fixed, bounded grammar.   |
| 5. Content bytes are verified                               | Not applicable. The stream is live and never enters the content store.                                             |
| 6. Crash-point tests for durable transitions                | Required for every session transition (amendment §6).                                                              |
| 7. No secret in logs, tests, fixtures, or screenshots       | §10.                                                                                                               |
| 8. IPC change has fixtures and tests on both sides          | Stage 2: the control protocol. Stage 4: the media `present` request and the `external-presentation` document.      |
| 9. Health from playback evidence                            | `client_connected` comes from UxPlay. Video health comes from renderer evidence, not from the process being alive. |
| 10. Test release I/O in the packaged sandbox                | Stage 2 and Stage 3 run the real units in the Linux image.                                                         |
| 11. The previous helper runs an update                      | The supervisor is not part of the update path. An update stops an active session as an ordinary restart does.      |

## 12. Residual risks

- UxPlay is a large C program that parses untrusted network input. The unit sandbox limits the effect of a compromise. It does not remove the risk.
- Loopback injection during a session (§7).
- A four-digit PIN can be guessed. UxPlay has no limit in `-pin` mode (§6). The supervisor's limit of 10 failures for each session leaves a 0.1 % chance for each session. The limit depends on UxPlay's log text; `tilecast-airplay/src/uxplay.rs` names the lines, and a new UxPlay pin must check them again.
- avahi-daemon is a host service that Tilecast does not update.
- iOS sends a key frame only when mirroring starts, and the relay cannot ask the sender for another one. If the web process restarts during a connected session, the screen stays black until the sender sends a key frame or connects again. The Runtime mounts the video before a sender connects to prevent this at session start (amendment §5.2).
- The relay copies mirrored packets in the renderer's main process. That process already shows untrusted web content through WebKit. It does not parse the packets.

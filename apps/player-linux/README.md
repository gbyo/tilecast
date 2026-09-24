# Tilecast Player for Linux

Tilecast Player for Linux kiosk devices (Intel NUCs, thin clients, Raspberry
Pi-class boxes running a minimal desktop or a Wayland kiosk compositor). It
implements the same device protocol and content model as the Android player:
pairing with a six-character code, per-device credentials, the authenticated
WebSocket, manifest playback through v13 (images, videos, websites, YouTube,
multi-zone Layouts, native and declarative Widgets, data-source-driven
content, weekly and one-time schedules, emergency takeover), the player
configuration channel, the persistent command protocol, batched activity-event
telemetry, on-demand live screen previews, and LAN (mDNS) server discovery.

Hardware-specific Android features are intentionally excluded: Android
device-owner/lock-task kiosk, the accessibility return service, boot receivers,
APK self-update, and the `power_assist_*` / `restart_activity` /
`install_player_update` commands. On Linux the equivalent reliability comes
from a kiosk compositor plus the systemd unit below.

Linux Display Control is an optional host integration. It uses `cec-ctl` for
HDMI-CEC and `ddcutil` for DDC/CI when those tools and device permissions are
available; it is capability-gated and never required for playback.

## Design goal: configure once, never touch again

Everything after the initial pairing is remote or automatic:

- **Cached-first startup.** The persisted manifest, media, and configuration
  activate at boot with zero network. A power cut during the night never
  results in a blank morning screen.
- **Self-detecting connections.** The player runs its own socket liveness
  watchdog (three missed 30-second server pings kills the connection), so a
  half-open TCP connection cannot silently strand content updates.
  Reconnection uses jittered exponential backoff that resets after the link
  has stayed healthy, and every reconnect immediately reconciles manifest,
  configuration, and commands.
- **Push with a polling floor.** `manifest.changed`, `config.changed`, and
  `commands.available` are the fast path; the manifest also reconciles every
  five minutes and commands are polled every seven seconds regardless of
  socket state. A lost notification delays a change by minutes, never
  strands it.
- **Safe content swaps.** A new manifest is downloaded, hash-verified,
  and only then activated — at the next item boundary, so the screen never
  flashes or shows a half-prepared playlist. Failed preparation leaves the
  current content untouched and retries. Emergencies interrupt immediately
  once prepared.
- **Exactly-once commands.** Commands are acknowledged, executed under a
  mutex with persisted idempotency keys, and their results reported — a
  command that restarts the process is not re-executed when the process
  returns.
- **Playback-progress health.** The supervisor judges health by what the
  renderer actually reports (item transitions, advancing video, re-shown
  images), not by object liveness. A stall walks a persisted escalation
  ladder — re-activate content, recreate renderer, recreate window, restart
  process — and repeated exhaustion enters safe mode, which keeps
  networking and Studio commands alive instead of looping. The ladder state
  survives restarts, so a relaunched process will not restart-loop.
- **systemd as the last rung.** A systemd user unit restarts the process on any
  exit, forever, and starts it with the graphical session. The player installs
  and enables that unit itself on an `install_autostart` command
  (`src/core/autostart.ts`), reading its own AppImage path, display variables,
  and data directory out of the live session rather than having an operator
  guess them; the server publishes the same unit at
  `/install/tilecast-player.service` as the by-hand template.
  It never starts the unit it just enabled — that process is already running —
  and never overwrites or deletes a unit file it did not generate.
- **Legacy handoff is controlled.** If an AppImage was started manually and
  has no `~/.config/systemd/user/tilecast-player.service`, use **Set up
  autostart** in Studio. The player captures its actual AppImage path,
  `DISPLAY`/`WAYLAND_DISPLAY`, data directory, and server URL, then writes and
  enables the generated unit without starting a second process. The current
  process remains in place until the next controlled restart, session restart,
  or reboot; after that, systemd owns the player. Generated units explicitly
  include `/usr/local/bin:/usr/bin:/bin` so provisioned UxPlay is visible to
  display-manager, kiosk, SSH, and systemd launches.
- **AirPlay provisioning is optional.** The server installer downloads the
  UxPlay 1.73.6 source archive from Tilecast Server and uses Debian package
  mirrors for build dependencies. Use `--without-airplay` to skip this setup.
  A failed AirPlay setup does not stop Player installation or pairing.
- **Rests overnight on its own.** Active-hours configuration darks the screen
  (true black, media torn down, no decoding) outside operating hours and
  wakes it at the next window with no operator action. An emergency always
  overrides off-hours sleep.

Player configuration is authoritative on Linux and Android. Cache
limits and free-space reserve, download concurrency and thresholds, sync
intervals, website timeout/cookie/reload policy, the website first-render and
playback stall thresholds, reliability and safe-mode limits, playback
defaults, branding, power/display policy, and location reporting are applied
from the validated revision. Timers and supervisor behavior are reconciled
when a revision changes; `clearOnRestart` clears website partitions only during
actual process startup. Linux reports Display-control capabilities explicitly,
and supports display-control schedules only when the host providers are
available.

Every cached manifest, configuration, download, and playback checkpoint is
bound to the installation ID, screen ID, and normalized server URL. Files are
accepted only after SHA-256 and size verification; same-size corruption is
rejected. The player applies exact layout variant references and the same
server-corrected clock to availability, schedules, takeovers, overrides,
transitions, plugins, and offline playback. A known empty assignment renders
the configured branded fallback; a transient sync failure keeps the last
valid assigned presentation active. If an assignment exists but every item is
outside its availability window or fails readiness, the Player shows an
explicit “Content unavailable” branded surface; “No content assigned” is
reserved for a confirmed empty assignment.

## Display: the shared Player Runtime

The window shows the shared Tilecast Player Runtime
(`packages/player-runtime`, [`docs/player-runtime.md`](../../docs/player-runtime.md)),
the same display document Tilecast Edge's WPE renderer hosts. The main process
serves it at `tilecast://runtime/index.html` (`src/main/runtime-protocol.ts`:
only files listed in the runtime's manifest, no traversal, no CSP bypass) and
keeps `tcmedia://` separate. The renderer runs with `sandbox: true`,
`contextIsolation: true` and `nodeIntegration: false`; `src/preload.ts` is a
thin `TilecastRuntimeHostV1` adapter that requires only `electron`. The
shared-timeline anchor for synchronized groups is built in the main process
(`src/main/runtime-messages.ts`).

## Content rendering

All widget, Layout, and declarative-presentation logic — data binding, typed
formatting (number/currency/percent/date/duration), and offline timezone-aware
date selection — runs in the main process (the Player Runtime's projection
compatibility code, `@tilecast/player-runtime/projection`) and is handed to the
display as a small, fully-resolved render tree. The display interprets it with
plain DOM, which keeps its memory footprint small on 4 GiB hardware. Clocks and countdowns
update in the display locally instead of re-sending the tree every second. QR
codes are encoded to inline SVG. Charts use lightweight inline SVG with no
animation.

## Low-end hardware tuning

The reference target is a ~2012 mini PC (Ivy Bridge, Intel HD 4000, 4 GiB RAM).
`src/main/hardware.ts` enables Intel VA-API hardware H.264 decode, caps V8 and
GPU memory, limits the frame rate, and disables background throttling — all
overridable by env var (`TILECAST_DISABLE_VAAPI`, `TILECAST_DISABLE_GPU`,
`TILECAST_MAX_FPS`) so a troublesome GPU can fall back to software in the field
without a rebuild. At most one video decodes at a time and large images are
never held at full resolution.

Credentials are stored with owner-only permissions and are cleared only when
the server confirms them invalid or revoked — never on network errors. A
configured player verifies the server's installation ID before sending its
stored credential anywhere.

## Setup

```bash
npm install
npm start                       # build and run
TILECAST_SERVER_URL=... npm start   # skip the on-screen setup
npm test                        # unit tests
npm run dist                    # AppImage + deb via electron-builder
```

Release AppImages use electron-builder's static AppImage runtime, so direct
launches do not need the legacy `libfuse.so.2` compatibility library. The
managed systemd unit also removes stale legacy AppImage FUSE mounts before each
retry and uses `--appimage-extract-and-run` as a startup safety net for older
artifacts and hosts where mounting is unavailable. That supported runtime mode
still sets `$APPIMAGE` to the installed artifact, so Studio-driven updates
continue replacing the signed AppImage atomically.

On first launch the player asks for the server address (or takes
`TILECAST_SERVER_URL` / `--server-url`), then shows the pairing code. Approve
it in Tilecast Studio; playback starts on approval and the device needs no
further local interaction.

Environment:

| Variable               | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `TILECAST_SERVER_URL`  | Server address; persisted after first use                        |
| `TILECAST_DATA_DIR`    | State/cache directory (default `~/.local/share/tilecast-player`) |
| `TILECAST_LOG_LEVEL`   | `debug` for verbose JSON logs on stderr                          |
| `TILECAST_WINDOWED`    | `1` disables kiosk fullscreen (development)                      |
| `TILECAST_HW_DECODE`   | `0` disables Intel VA-API hardware video decode                  |
| `TILECAST_DISABLE_GPU` | `1` forces full software rendering                               |
| `TILECAST_MAX_FPS`     | Frame-rate cap (default 30)                                      |

Studio's **Reliability and kiosk** settings include a Linux subsection for
remotely controlling kiosk fullscreen and the desktop display-sleep blocker.
The `TILECAST_WINDOWED=1` environment variable always wins over the fullscreen
policy so a development session cannot be forced into kiosk mode.

On first launch the player also browses the LAN for `_tilecast._tcp` servers
and offers them as one-tap choices on the setup screen, so a screen on the
same network needs no typing.

## Platform differences from the Android player

- **Self-update** replaces the running AppImage rather than installing an APK.
  On an `install_player_update` deployment the player downloads and verifies the
  signed AppImage (SHA-256 + size), marks the staged file executable, atomically
  swaps it over `$APPIMAGE`, and exits so the systemd unit starts the new
  version; progress is reported to the update-deployment status endpoint. The
  AppImage and its parent directory must be writable by the kiosk user. When the
  player is not running as a managed AppImage (e.g. a dev run), the deployment
  is reported as failed instead. `power_assist_sleep/wake` still report
  `unsupported_command`. `restart_activity` maps onto a process relaunch (the
  same rung as `restart_player_process`).
- **Kiosk lockdown** is provided by the desktop/Wayland kiosk compositor and the
  systemd unit rather than Android device-owner/lock-task.
- **Boot launch** is a systemd user unit rather than a boot receiver, installed
  remotely with `install_autostart` / `remove_autostart`. The Android-only
  `reliability.launch_after_boot` policy is ignored here. The player reports
  `autostartState`, `autostartTarget`, `autostartSupervised`,
  `autostartLingerEnabled`, and — when systemd started it within
  `COLD_BOOT_WINDOW_SECONDS` of system boot — the same `bootLaunchVerified` and
  `lastSuccessfulColdBootAt` the Android player reports. A graphical session at
  boot (auto-login or a kiosk compositor) is root-owned OS setup and stays out
  of scope; the player says so rather than reporting a success it cannot see.
- **Secure web sandboxing** for `web`-kind declarative presentations (remote
  bundles) is not yet implemented; `native`-kind presentations render fully.

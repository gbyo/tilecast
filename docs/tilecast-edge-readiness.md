# Tilecast Edge: production readiness record

This record compares the legacy Electron Linux Player (`apps/player-linux`)
with Tilecast Edge (`apps/edge`, `crates/player-*`, shared
`packages/player-runtime`). It drives the production readiness work. It
records code evidence, not documentation claims. Each row uses one status:

- Implemented and verified: the code exists and tests prove it.
- Needs physical qualification: the code exists and software tests pass.
  Physical hardware must still confirm it.
- Partially implemented: the code covers part of the area.
- Known defect: the code has a concrete fault. The record names the fix.
- Intentionally unsupported: an accepted decision excludes it from Edge 1.
- Missing and necessary: Edge needs it before legacy retirement.

## 1. Pairing, identity and credential lifecycle

| Item | Status | Evidence and action |
|---|---|---|
| Server URL policy | Implemented and verified | `player-client/src/url_policy.rs` with shared fixtures. Edge rejects IPv6-literal HTTP. Legacy accepts it. The difference has negligible fleet impact. No action. |
| Identity check before credential use | Implemented and verified | `player-client/src/client.rs` `verify_installation`. Edge re-verifies on every pass. No action. |
| Pairing create, poll and enroll | Implemented and verified | `player-core/src/pairing.rs`. Edge persists the enrollment token across a crash. Legacy loses it. No action. |
| Credential storage and deletion | Implemented and verified | `edge-server/src/credential.rs`. Deletion occurs only on confirmed rejection. No action. |
| Installation mismatch | Partially implemented | Edge stops the link but keeps caches and shows no dedicated surface. Action: quarantine caches and add a mismatch surface. |
| Unpair a paired screen | Partially implemented | `tilecastctl` has no unpair command. Action: add an explicit unpair operation. |
| LAN discovery | Needs physical qualification | `tilecastd/src/discovery.rs` browses Avahi over D-Bus. Action: qualify on a real LAN. |

## 2. Server connection and reconnect

| Item | Status | Evidence and action |
|---|---|---|
| Socket auth, push set, liveness | Implemented and verified | `player-client/src/client.rs`, `player-core/src/server_driver.rs`. No action. |
| Backoff and reconcile on open | Implemented and verified | Same backoff formula as legacy. Reconciliation runs on every socket open. No action. |
| Heartbeat fallback | Implemented and verified | Socket-first status with HTTP fallback and identical clamps. No action. |
| Fast path on socket close | Partially implemented | Edge maps every close to undifferentiated `Closed`. Legacy probes revoked against disabled. Action: add a close-code fast path or ratify the slower HTTP round-trip. |

## 3. Manifest synchronization and activation

| Item | Status | Evidence and action |
|---|---|---|
| Conditional fetch, push and timer reconcile | Implemented and verified | `player-core/src/manifests.rs`, `server_driver.rs`. No action. |
| Verify before activate, boundary swap, grace | Implemented and verified | `offline_activation.rs`, `offline_driver.rs`. Same grace clamp as legacy. No action. |
| Takeover and Quick Present cut-in | Implemented and verified | `overrides_activation_gate`. No action. |
| Schema range enforcement | Intentionally unsupported | Edge rejects schemas outside 11-19. Legacy only logs the version. The stricter rule is deliberate. No action. |
| Whole-manifest rejection | Intentionally unsupported | Edge rejects the full manifest on incompatibility. Legacy skips bad items. The strict rule is deliberate, except for retired plugin kinds (see section 6). |

## 4. Offline content caching and recovery

| Item | Status | Evidence and action |
|---|---|---|
| Boot playback without network | Implemented and verified | `offline_activation.rs` loads SQLite state at boot. No action. |
| Cache identity binding | Implemented and verified | Binding gate covers installation, screen and URL. No action. |
| Resumable verified download | Implemented and verified | `player-cas` fetch with resume and hash-verify on commit. No action. |
| Corruption repair | Implemented and verified | Store reconciliation re-hashes orphans and drops dead rows. No action. |
| Pins, eviction and cache policy | Implemented and verified | Same 8 GiB and 1 GiB defaults as legacy. No action. |
| Stream delivery without full cache | Partially implemented | Legacy proxies Range streams with device auth. Edge downloads every item into CAS. Oversize items fail preparation. Action: add a streaming fallback or publish validated store sizing. |
| Resume mid-playlist after restart | Missing and necessary | Legacy restores `playback-checkpoint.json`. Edge restarts plain playlists at item 0. Synchronized groups use the anchor and need no checkpoint. Action: persist and restore the playlist position. |

## 5. Images, video, audio, websites and YouTube

| Item | Status | Evidence and action |
|---|---|---|
| Images | Needs physical qualification | Shared runtime surface, `tcmedia://cap` grants. Action: qualify on DRM hardware. |
| Video | Needs physical qualification | Shared runtime surface, GStreamer source. Edge has no VA-API equivalent of legacy low-end tuning. Action: qualify codecs and decode load on reference hardware. |
| Audio files | Intentionally unsupported | Neither Player has an audio item kind. No action. |
| Video soundtrack output | Needs physical qualification | The `audio` group is now on `tilecast-renderer.service`, matching the web helper. Action: qualify audible output on hardware. |
| Websites and YouTube | Needs physical qualification | Isolated remote-web helper with policy, frames and wrapper. Action: qualify GPU frames, audio routing and real-site playback on hardware. |

## 6. Layouts, Widgets V2 and bundled plugins

| Item | Status | Evidence and action |
|---|---|---|
| Multi-zone layouts and Span viewport | Implemented and verified | Same shared runtime projection as legacy. No action. |
| Declarative widgets and first-class components | Implemented and verified | Same shared widget code, daemon capability checks. No action. |
| External widget frames and bundles | Implemented and verified | Edge supports what legacy omits (verified fetch, pinned frames). No action. |
| Countdown bar and alert ticker | Implemented and verified | Same JSON reaches the same runtime. No action. |
| Retired plugin kinds in manifests | Implemented and verified | Edge ignores `noise_meter` entries with a warning, like legacy. Unknown kinds still reject the manifest. No action. |
| Non-remote web widgets | Intentionally unsupported | Edge rejects the full manifest. Legacy skips the item. The strict rule is deliberate. No action. |

## 7. Schedules, takeovers and synchronized groups

| Item | Status | Evidence and action |
|---|---|---|
| Schedule resolution and display policy | Implemented and verified | `schedule.rs` ports the legacy rules with DST tests. No action. |
| Takeover, emergency alias and Quick Present | Implemented and verified | Same half-open windows and branches. No action. |
| Availability windows | Implemented and verified | Same transition scheduling. No action. |
| Sync-group anchor and duration math | Implemented and verified | Mirror of the reference math with unit tests. No action. |
| Multi-device group playback | Needs physical qualification | Same shared timeline. Action: qualify with two or more physical players. |
| Rotated Span panels | Needs physical qualification | Players disagree on rotation. Action: settle against a rotated physical panel. |

## 8. Player commands and command results

| Item | Status | Evidence and action |
|---|---|---|
| Poll cadence, push wake, serialization | Implemented and verified | `player-core/src/commands.rs`. No action. |
| Durable non-replay | Implemented and verified | Idempotency-keyed records with `command_interrupted` recovery. Stronger than legacy across crashes. No action. |
| Disruptive pre-report | Implemented and verified | Bounded report before restart. No action. |
| Core handler parity | Implemented and verified | Same reference result codes. No action. |
| `clear_website_data` | Implemented and verified | The type is now in `plan()` with a routing-table regression test. No action. |
| `restart_activity` | Partially implemented | Legacy relaunches the process. Edge restarts the renderer only and reports `activity_restarted`. Action: ratify the renderer-only semantic or match legacy. |
| AirPlay commands | Intentionally unsupported | Edge answers `unsupported_command`. AirPlay stays out of Edge 1. Retirement must exclude AirPlay-dependent screens. |
| Autostart commands | Intentionally unsupported | The installer owns the system service. No action. |

## 9. Screenshots, previews and Watch Live

| Item | Status | Evidence and action |
|---|---|---|
| Snapshot primitive | Needs physical qualification | Bounded serialized capture with protected-state refusal. Headless path is proven end to end. Action: qualify WPE snapshot fidelity on DRM hardware. |
| Periodic preview and upload | Needs physical qualification | Same cadence and multipart contract as legacy. PR #1376 adds event-driven wake, bounded recovery and last-good frames. Action: finish PR #1376 and qualify fidelity. |
| Watch Live | Needs physical qualification | Same cadence and TCLS encoding with stricter privacy rechecks. PR #1378 adds stall detection and recovery. Action: finish PR #1378 and qualify encoder load at 8 fps. |

## 10. Renderer crashes, safe mode and recovery

| Item | Status | Evidence and action |
|---|---|---|
| Stall detection and recovery ladder | Implemented and verified | Evidence-based ladder with identical defaults. No action. |
| Reactivate, reload and renderer restart | Needs physical qualification | Rungs map to WPE reload and systemd restart. Action: qualify reload and restart efficacy on DRM hardware. |
| Daemon-restart rung | Partially implemented | Edge has no daemon-restart rung by design. The daemon stays stable while the renderer restarts. No action unless field evidence demands it. |
| Ladder and safe-mode persistence | Implemented and verified | The record carries safe mode and restart counts across restarts. Restored safe mode holds until `exit_safe_mode`. No action. |
| Safe-mode entry, exit and commands | Implemented and verified | Entry, exit and both commands exist with persistence. No action. |
| Web-process crash | Needs physical qualification | WPE termination handler reloads and degrades health. Action: qualify on hardware. |
| Crash-loop latching | Implemented and verified | The daemon, renderer and web-helper units set `StartLimitIntervalSec=0`, with packaged-unit regression tests. No action. |
| Watchdog and clean-shutdown attestation | Implemented and verified | `Type=notify`, DB-gated watchdog, running marker. Exceeds legacy. No action. |

## 11. Display controls, active hours and display sleep

| Item | Status | Evidence and action |
|---|---|---|
| Command validation and scheduled policy | Implemented and verified | Same rules as legacy with stricter input resolution. No action. |
| CEC power and input | Needs physical qualification | Native kernel ioctls replace the `cec-ctl` subprocess. Action: qualify against reference displays. |
| Power readback | Needs physical qualification | Confirmed and mismatch outcomes with refresh. Exceeds legacy. Action: qualify readback accuracy. |
| DDC brightness, volume and mute | Needs physical qualification | Native i2c-dev with read-back confirm. Fixes the legacy mute probe defect. Action: qualify against reference displays. |
| Probe and heartbeat vocabulary | Implemented and verified | Same vocabulary with capability projection. No action. |
| Active hours and rest surfaces | Implemented and verified | Same rules, same precedence, identical surfaces. No action. |
| Display-sleep inhibition | Needs physical qualification | logind idle lock replaces the Chromium blocker. Action: qualify logind-idle effect on a VT and DRM kiosk. |
| Window kiosk mode | Intentionally unsupported | WPE owns the VT fullscreen. No action. |

## 12. Systemd startup, shutdown and reboot

| Item | Status | Evidence and action |
|---|---|---|
| Boot supervision without desktop | Needs physical qualification | System units with `check-config` pre-start. Action: qualify cold boot on reference hardware. |
| `restart_player_process` | Implemented and verified | Renderer holds its last frame across the daemon restart. No action. |
| OS reboot and shutdown commands | Intentionally unsupported | Neither Player implements them. The server catalog has no such commands. No action. |
| Graceful shutdown | Implemented and verified | Task drain, CAS flush, clean-shutdown record, WAL checkpoint. Exceeds legacy. No action. |

## 13. Signed releases, updates and rollback

| Item | Status | Evidence and action |
|---|---|---|
| Release signing and envelope | Implemented and verified | On-device Ed25519 verification of envelope, archive and tree. Exceeds legacy. No action. |
| Staging atomicity and downgrade protection | Implemented and verified | Side-by-side staging, `rename(2)` switch, newer-only rules. No action. |
| Provisional window and guard rollback | Implemented and verified | 120 s evidence confirmation, previous-release guard, crash matrix with power loss. No action. |
| Rollback after a schema-advancing update | Implemented and verified | The coordinator checkpoints `state.db` before a schema-advancing activation. After a rollback the previous daemon restores the verified checkpoint and replays post-checkpoint commands, outbox rows, the sequence watermark and supervision. Failures fail closed with explicit reasons. Tests: `tilecastd` `update_checkpoint` unit tests and the `tests/updates.rs` checkpoint and guard scenarios. |
| Reverse migrations | Intentionally unsupported | No reverse SQL exists by design. The checkpoint is the recovery path. No action. |

## 14. Legacy migration and import

| Item | Status | Evidence and action |
|---|---|---|
| Cutover state machine and rollback | Implemented and verified | 29 crash points, exactly-one-player recovery, legacy files untouched. No action. |
| Compatibility pre-check | Implemented and verified | Offline read-only check against the installed profile. No action. |
| Identity, credential and command import | Implemented and verified | Identity gate precedes credential storage. Executed keys union safely. No action. |
| Manifest and media import | Implemented and verified | Cache-identity match, verified file import, migration pins. No action. |
| Deliberately unmigrated state | Intentionally unsupported | Pairing sessions, updater stage, AirPlay, radio state and website storage stay behind. No action. |
| Physical kiosk migration | Needs physical qualification | DRM probe gate and boot recovery are proven in fakes and systemd tests only. Action: qualify migrate and rollback on kiosk hardware. |

## 15. Linux hardware and display integration

| Item | Status | Evidence and action |
|---|---|---|
| DRM and KMS output | Needs physical qualification | DRM is the default platform. Action: qualify output, hotplug and rotation on reference hardware. |
| GPU and video decode | Needs physical qualification | WPE with GStreamer, pinned WebKit per release. Action: qualify codecs and decode performance. |
| Audio routing | Partially implemented | DDC volume control exists. ALSA access for the main renderer is the section 5 defect. No PipeWire code exists in `tilecastd`. Action: fix the group, then qualify routing. |
| Presentation Network and Wi-Fi | Implemented and verified | Same root helper and protocol as legacy, tested with a fake `nmcli`. Wi-Fi hardware still needs M11 qualification. |
| System telemetry | Implemented and verified | Platform providers feed the same gauges. No action. |
| Content store integrity | Implemented and verified | Verified CAS with pins exceeds the legacy flat cache. No action. |

## Ranked implementation actions

1. Phase 2 checkpoint: done (see section 13).
2. Supervisor persistence: done (Core `restore_safe_mode`, Edge
   `restore_supervision` and `persist_supervision`, startup restore).
3. Start-limit latch: done (`StartLimitIntervalSec=0` on the daemon,
   renderer and web-helper units, with packaged-unit regression tests).
4. `clear_website_data`: done (added to `plan()` with a routing-table test).
5. Renderer audio group: done (`audio` on `tilecast-renderer.service`).
   Hardware must still confirm audible output.
6. Retired plugins: done (`noise_meter` ignored with a warning;
   unknown kinds still reject).
7. Playlist resume: persist and restore the playlist position.
8. Mismatch surface and cache quarantine for installation mismatch.
9. Streaming fallback or validated store sizing for large video.
10. Unpair command for `tilecastctl`.
11. Socket close-code fast path, or ratify the HTTP round-trip delay.
12. Ratify the renderer-only `restart_activity` semantic.

## Physical qualification backlog

No physical qualification has run yet. The backlog needs reference hardware
for: DRM output and hotplug, video codecs and decode load, WPE snapshot
fidelity, remote-web GPU frames and real-site playback, real YouTube
playback, CEC and DDC against reference displays, logind idle inhibition on
a VT kiosk, Presentation Network on supported Wi-Fi adapters, multi-device
sync groups, rotated Span panels, cold boot without a display manager,
kiosk migration and rollback, and signed update with power loss and
rollback on a real disk.

## Notes

- PR #1376 (preview transport), PR #1377 (command delivery) and PR #1378
  (Watch Live stall recovery) remain draft. PR #1377 is green. PR #1376 has
  one dashboard shard failure. PR #1378 has server, lint and dashboard
  failures. Phase 3 finishes all three without competing implementations.
- AirPlay remains unsupported by Edge. It is out of scope and must not be
  presented as implemented.
- The readiness plan references `docs/tilecast-edge-sandbox-review.md`.
  That file does not exist. Sandbox material lives in
  `docs/tilecast-edge-remote-web-threat-review.md` and
  `docs/widget-sandbox-threat-model.md`.

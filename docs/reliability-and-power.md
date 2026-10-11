# Player reliability, kiosk, accessibility, and power

The watchdog, recovery, safe-mode, and [meaningful render progress](#meaningful-render-progress) behavior applies to Android and Linux. Platform-specific controls are identified below.

## Linux kiosk and reliability

Tilecast Studio exposes Linux kiosk fullscreen and display-sleep prevention alongside the shared watchdog and recovery policy. These settings apply immediately when the Linux player receives configuration. `TILECAST_WINDOWED=1` remains a local development override that prevents remote policy from forcing kiosk fullscreen.

Linux boot startup, restart after process exit, and desktop lockdown are operating-system responsibilities provided by the installed systemd unit and kiosk compositor. Studio does not claim those external safeguards are active merely because a policy value is enabled. Android device-owner, lock-task, Accessibility Control Assist, and Power Assist settings do not apply to Linux.

Release AppImages use a static runtime that does not dynamically load the
legacy `libfuse.so.2` compatibility library. The supplied and in-product
systemd units also start the AppImage with `--appimage-extract-and-run` as a
safety net for older artifacts and hosts where mounting is unavailable. This
supported runtime path preserves `$APPIMAGE` as the installed artifact path
used by signed, atomic Studio updates.

The managed systemd unit also runs a best-effort pre-start cleanup. It unmounts
only FUSE filesystems under `/tmp/.mount_*` and removes only empty mount
directories, so a failed legacy launcher can recover on the next systemd retry.
The cleanup is not a substitute for `--appimage-extract-and-run`; it is a
bounded recovery step for stale mounts left by older artifacts.

Tilecast Player has two reliability modes. **Standard Reliability** works with a normally installed APK and provides cached startup, boot recovery, immersive fullscreen, keep-awake behavior, bounded playback recovery, safe mode, and locally approved Accessibility Control Assist. Android can still let a user leave the app. **Managed Kiosk** is effective only when Android confirms device-owner/device-policy provisioning and active lock task. Requesting it in policy is not proof that it is active.

## First-run commissioning

Every newly paired player completes a local wizard before normal playback. It sets the hashed maintenance PIN, opens and verifies Accessibility Settings and unknown-app installation permission, verifies a healthy boot return, confirms immersive and keep-awake state, confirms a downloadable cached fallback, runs a self-test, and reports the final readiness state. Protected Android settings are never automated or marked complete based only on policy. **Run setup again** is available from the bounded local maintenance menu.

New effective defaults request launch after boot, keep-awake, immersive presentation, accessibility return control, cached offline playback, recovery escalation, safe mode, and the stable update channel. Accessibility and unknown-app installation remain one-time local commissioning permissions. Eligible self-updates on Android 12 and newer can proceed unattended after commissioning. Sleep outside active hours remains off until configured.

## Active hours

Active hours use explicit IANA timezones, ISO weekdays (Monday 1 through Sunday 7), and half-open `[start,end)` windows. An end at or before the start is overnight and belongs to the selected start day. Calendar calculations use timezone rules rather than fixed durations. In a DST gap, a boundary advances to the first valid local time; in an overlap, starts choose the earlier occurrence and ends the later occurrence. Takeover overrides off-hours sleep and black-screen behavior. APK installation and required verification are never interrupted.

Outside active hours the player saves state, stops media decoding, releases keep-screen-on, pauses ordinary presentation, and uses a true-black fallback when Android sleep is unavailable. Cached configuration and manifests are used immediately after boot without waiting for the network.

## Power Assist and Display Control

Android Power Assist uses the Android device’s sleep and wake behavior. Compatible devices may relay HDMI-CEC standby or One Touch Play commands to the connected TV, but Tilecast does **not** send raw HDMI-CEC commands from Android and cannot infer that the physical TV changed power or input merely because the Android process resumed.

Linux Players have a separate optional [Display Control](display-control.md)
provider system. When Linux detects `cec-ctl` or `ddcutil` and the Player has
the required device permissions, Studio can expose only the capabilities that
were detected. Provider calls are fixed, shell-free, and time-bounded. Linux
reports a command as sent separately from a display state confirmed by a later
heartbeat; unsupported hardware is not an outage.

Sleep strategy is capability ordered: authorized device policy, optional Accessibility global lock, then black screen. Wake is best effort through supported activity/alarm behavior. Studio’s per-screen wizard stores administrator-confirmed device sleep, TV standby, device wake, TV wake, input selection, and Tilecast startup separately. Results are device-specific, not universal compatibility claims.

## Accessibility Control Assist

Control Assist is requested by the hardened default but remains disabled at the Android platform until it is enabled locally in Android Accessibility Settings. The service observes only foreground window/package changes. It can wait, return to Tilecast, and request Android’s global lock action for Power Assist. It cannot read window text, passwords, click controls, perform gestures, approve an installer, navigate Settings, or change network configuration.

Tilecast, Android Settings, package installers, permission controllers, captive portals, setup/system components, and configured maintenance apps are excluded. Automatic returns pause during player updates and maintenance. Attempts are bounded in a time window; exhausting the bound stops the loop until the window clears.

## Meaningful render progress

Three things get routinely confused, and conflating them is what lets a player report itself healthy over a blank screen:

1. **the process is alive** — it answers heartbeats;
2. **the renderer object is alive** — a view exists and responds to probes;
3. **playback is actually progressing** — something is happening on the display.

Only the third is health. The supervisor is fed from the third, never the first two.

Progress is recognised from real signals: video position advancing, an item transition, an image successfully displayed, a website's first meaningful render, a layout zone rendering, and a frame fingerprint changing _where change was expected_. Renderer liveness probes are recorded separately and are **not** progress, with one exception: indefinite content, where a probe is the only evidence available.

### Content-aware expectations

Silence means different things depending on what is on screen, so each kind of content is judged on its own terms. Getting this wrong in either direction is costly: too strict calls a valid still image frozen, too loose lets a genuinely frozen video pass.

| Content           | Progress is                                              | Silence is                                        | Tolerance                                            |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| Still image       | Displayed successfully                                   | Correct, until it outstays its duration           | Its own duration + 60s, or 30 minutes when unbounded |
| Video             | The position advancing                                   | A stall                                           | 20 seconds                                           |
| Website or widget | A first meaningful render                                | Correct once rendered; frame changes are optional | 90 seconds to first render                           |
| Layout            | Every zone rendering, then every rotating zone advancing | A blank zone, or a rotation that stopped          | 5 minutes per zone                                   |
| Indefinite        | A periodic renderer health confirmation                  | A stall                                           | 10 minutes                                           |

**A valid long-lived still image is never called frozen for having identical pixels.** That is the case this design exists to protect. For the same reason a fingerprint change _under_ a still image is treated as noise rather than evidence — accepting it would let compression artefacts mask a real overrun.

Layouts are judged per zone, because a whole-layout signal hides the case that matters: one zone dying while its neighbours keep the presentation looking alive. Every zone owes a first render; only a rotating playlist zone owes continuing evidence, since a static widget or image zone renders once and legitimately holds. A single-item zone loops in place rather than advancing, so it is not held to a cadence either.

### What the player reports

Every heartbeat carries `lastMeaningfulProgressAt`, `stallStartedAt`, `stallDurationMs`, `stallReason`, `expectedMotion` and `rendererResponding`. The stall is measured from when progress was last _seen_, not from when it was noticed, so the duration reflects how long the screen has actually been wrong rather than the poll interval.

Native Players apply the same table. Tilecast Edge, Windows, and Android decide health in Player Core ([Playback health](player-core.md#playback-health)). A liveness report resets the recovery supervisor only while the content owes nothing else, so a static Layout, Widget, or Website that renders once is not recovered, and a frozen zone, a page that never rendered, or a stopped video is.

`stallReason` names the content failure where the content is the evidence — a frozen video reports `video_position_frozen`, not `renderer_not_responding`, because the player has no evidence the renderer died. Blaming the renderer is reserved for indefinite content, where the probe genuinely is the only signal.

## Recovery and safe mode

The local supervisor persists failure and healthy-playback history across activity and process restarts. It executes retry, item skip, renderer recreation, playback-session recreation, activity restart, and a bounded number of process recoveries. Failure history clears only after a meaningful healthy-playback period. Repeated failure enters safe mode instead of looping. Safe mode keeps pairing, networking, health reporting, commands, local maintenance, cache validation, and manual retry available; it does not delete content or credentials. Owners and Administrators can issue typed commands for each recovery rung, resynchronize manifest and configuration, run a self-test, retry recovery, or exit safe mode.

Boot recovery registers both normal and locked boot completion. It requests an immediate foreground launch and retries after bounded 15, 60, and 180 second delays, stopping after a healthy foreground is confirmed. Firmware may block background activity launch; that limitation is reported to Studio rather than hidden.

Network, heartbeat, command, manifest, and configuration failures do not clear cached playback. Reconnection uses bounded exponential backoff with jitter while the active manifest and local schedules continue; the backoff resets once a connection has stayed healthy long enough, so a brief blip after a stable session reconnects quickly instead of resuming near the cap. A prolonged loss of server contact escalates only when the screen is also no longer rendering. Health is judged by real playback progress (see [meaningful render progress](#meaningful-render-progress)), not by whether a playback session object exists, because a session can remain while the screen is blank or frozen. While offline and stalled, the Player first re-activates cached content locally (no server contact), and only if progress still does not resume does it restart the activity and, as a last resort, the process. Because disruptive restarts require several minutes with no progress, a valid long-lived still image is not mistaken for a freeze, and a screen that is offline but still advancing is never disrupted. The escalation state is persisted, so a relaunched process knows it already restarted during this outage and will not restart-loop; it clears as soon as progress resumes or the server is reachable again. Self-heal actions are reported as attempts; confirmed recovery is a separate event emitted when the connection actually reopens. Connection loss, recovery, and self-heal attempts are reliability activity events (connectivity and reliability categories) so Studio can see them per screen. Complete hardware failure, power that is not restored, changed Wi-Fi credentials, and Android prompts that require approval remain outside zero-touch recovery.

## Local maintenance and Managed Kiosk

The default hidden sequence is Back, Back, Up, Down, Select. The first use creates a 4–12 digit local PIN; only a salted PBKDF2-SHA256 hash is stored. Incorrect attempts are rate-limited and temporarily locked. A maintenance session is time bounded and exposes only fixed actions: Android network/settings pages, Accessibility Settings, unknown-app permission, safe-mode recovery, Tilecast restart, and return to playback. There is no shell or arbitrary app launcher.

Device-owner provisioning can require a factory reset plus ADB, QR, or firmware-specific enrollment during initial setup. Tilecast never attempts to silently convert an existing consumer TV. Installer and Settings access remain allowed only during deliberate update or maintenance flows, and kiosk state is restored afterward when the platform supports it.

## Telemetry

Players report bounded telemetry alongside heartbeats: latest gauge values and counter deltas since the previous sample, on a fixed cadence. Raw high-frequency samples are never uploaded.

Players report **measurements, not conclusions**. A player says its round-trip time was 2400 milliseconds; the server decides whether that is an incident. Thresholds, hysteresis and cooldowns live server-side so a restarted player cannot re-announce every condition it was already in, and so the policy can be corrected without shipping a player release.

A measurement a Player cannot take is omitted rather than sent as zero. A
Player with no luminance sensor reports no luminance. The black-output
condition does not run for that Player. The absence of the event does not prove
that the screen is operating correctly.

Telemetry samples are dropped rather than buffered when the server is unreachable. Activity events and proof of play _are_ buffered and retried; telemetry is not, because buffering it would trade a minute of lost detail for unbounded memory on a player that has been offline for hours. See [`activity.md`](activity.md#player-telemetry).

## Verification limitations

Emulator tests validate policy, boot receiver registration, lock-task capability reporting, active hours, DST handling, watchdog bounds, exclusions, and UI state. They cannot validate TV standby, TV wake, HDMI input selection, or firmware-specific boot launch. Those results require per-model physical Fire TV and Google TV testing and administrator confirmation.

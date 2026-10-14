# Android player development

Tilecast Player uses JDK 17 and the checked-in Gradle wrapper. Install the SDK, build tools, NDK and Rust toolchain required by `apps/player-android/app/build.gradle.kts` and `rust-toolchain.toml`; the Gradle file is authoritative for `minSdk`, `targetSdk`, and `compileSdk`. Compiling with a newer SDK does not raise the minimum installable Android API level. The Player has no Google Play Services dependency.

## Native Player Core host

The APK embeds a Rust host for shared Player Core. The host crate is
`tilecast-player-android-native` below `apps/player-android/native`.
It owns one process-level host, a narrow JNI bridge, Android storage
locations, and Android platform TLS trust. Kotlin owns the host lifetime
through the application-scoped `PlayerCoreHost`. Production runs Core.
Kotlin keeps setup discovery, server-address entry, OS effects, the
trusted WebView renderer, capture, and self-update installation.

Kotlin calls `PlayerCoreHost.startDrivers` to open the host and start the
Core drivers. Core keeps the pairing session and enrollment. The Keystore
keeps the device credential. The file `player-core/pairing.json` keeps the
pairing session. Neither value enters Player State, Room, logs, or status
payloads. A JNI handler on Kotlin supplies the private stores and device
facts to Core through upcalls. `beginPairing` starts a session.
`resetPairing` clears only the session. It preserves an enrolled
credential, because Core reserves removal for revocation. Core reports
`Paired` immediately on enrollment. `resetServer` clears the credential
and parks the link unbound. The binding keeps the server URL, so the next
launch re-pairs without retyping the address.

The host qualifies the content store on Android storage. The native
`cas_qualify` checklist proves verified commits, size and digest
enforcement, symlink refusal, partial resume, crash reconciliation,
pin-aware eviction, and free-space reserve behavior on real
app-private storage. The instrumented `CasQualifyDeviceTest` runs it.
It uses a scratch directory and never touches live host state.

Core owns configuration acceptance. The Android host projects the
accepted document into Runtime values for the shared Player Runtime
and platform values Kotlin applies: reliability, power, managed
kiosk, accessibility, updates, and downloads. Structure is strict
and values fall back to defaults, the way the reference player
reads them. Install persists `installed-config.json`, narrows the
content-store policy, and publishes the accepted revision to
status. A restart applies the accepted document before any network
access. The one-shot `syncConfig` reconciles against the bound
server; the server-link driver reuses the same coordinator.

Core owns manifest identity, validation, and verified preparation.
The Android host contributes its packaged renderer profile: the
declarative presentation capabilities from the shared contracts
generator, the widget capabilities from `widgetctl`, presentation
schemas 1 and 2, and the packaged feature set. Components with
schema 3 or unknown capabilities, bundled web widgets, the brand
bug plugin, and malformed sync or span geometry are incompatible.
The one-shot `syncManifest` reconciles the target, prepares its
verified content, and pins the pending manifest; the instrumented
`ManifestSyncDeviceTest` proves prepare-once, conditional refetch,
and restart persistence against a stub server.

Core drives the server link: the identity gate, the player
WebSocket with fallback heartbeats, configuration and manifest
reconciliation, and publication of the verified server. The
Android host supplies the relationship credential, the renderer
profile for preparation, the heartbeat projection, and the
activity sink. Enrollment wakes the link at once. The heartbeat
reports device facts, uptime, the packaged profile, manifest
versions, configuration state, and store usage; renderer,
website, widget, command, update, reliability, and
commissioning fields arrive with the drivers that own them.
Status publishes the link token, the reason, and the last
server contact. The instrumented `ServerLinkDeviceTest` proves
unbound idle, enrollment wake, fallback heartbeat content,
same-pass reconciliation, and connected status.

Core owns command delivery: polling, idempotency, crash
recovery, and result reporting. Pure-state commands run in the
Android host; renderer, OS, and update-installer effects cross
JNI as one `ExecutePlatformCommand` message to the Kotlin
platform executor. The last executed command is projected into
the heartbeat. The instrumented `CommandsDeviceTest` proves
acknowledge, run, and report for a state and a platform
command, JNI routing with type and payload, and execution-once
across a restart while redeliveries re-send stored results.

Before you build an APK, install the Rust toolchain from
`rust-toolchain.toml` and the Android targets from the CI workflow. Install
`cargo-ndk`:

```sh
cargo install cargo-ndk --version 4.1.2 --locked
```

The Gradle task `buildNativeCore` compiles the host crate for `arm64-v8a`,
`armeabi-v7a`, and `x86_64` and packages the libraries into the APK. It
resolves the pinned NDK from `tilecastNdkVersion` in
`app/build.gradle.kts`. If the NDK is missing, install it:

```sh
sdkmanager "ndk;29.0.14206865"
```

Unit tests do not need the native library. The host crate has its own Rust
tests:

```sh
bash scripts/ci/cargo-player-android.sh test
```

The device test `PlayerCoreHostDeviceTest` starts the host on an emulator
and checks the status snapshot. Extended validation runs it in the Core host
boot job every night. PR validation does not run it, so run it yourself before
you merge a change to the Core host:

```sh
cd apps/player-android
./gradlew :app:connectedDebugAndroidTest "-Pandroid.testInstrumentationRunnerArguments.class=org.tilecast.player.core.PlayerCoreHostDeviceTest"
```

Every bundled native library must keep 16 KB page-size compatibility. CI
checks the assembled APK. You can run the same check locally:

```sh
python3 apps/player-android/ci/check-native-alignment.py apps/player-android/app/build/outputs/apk/debug/app-debug.apk
```

If the check reports a 4 KB alignment, do not ship the APK. Fix the
toolchain flags first.

## Production cutover

Core owns pairing, configuration, manifest preparation, the server link,
presence, commands, activity, renderer recovery, and capture policy.
Kotlin owns server discovery, manual address entry, window, kiosk, and
power effects, renderer hosting, frame capture, commissioning, and
self-update installation. `PlayerViewModel` projects Core state onto the
setup and status screens. It makes no content decisions.

The cutover deleted the legacy Kotlin brains: the player state machine,
the pairing coordinator, the manifest and configuration managers, the
schedule engine, the playback screens, the preview and live-stream
coordinators, the activity queue, the plugin bars, the fallback policy,
and the Kotlin supervision ladder. The Kotlin HTTP client keeps only
self-update metadata, status reports, and verified downloads.

Production code has no Room dependency. The legacy Room schema lives in
the `androidTest` source set. Only the legacy-import device test uses it,
to seed a pre-migration database for the native importer. The native
importer reads the legacy database file directly.

`MainActivity` shows the process-owned `WebViewCoreRenderer` view for
paired playback. A native status surface covers the view until the
runtime owns the screen. [Renderer ownership](#renderer-ownership-and-the-core-handshake)
defines when that is. Idle, disabled, unavailable, safe-mode, and off-hours
states render inside the runtime page. Capture refuses admin, maintenance,
commissioning, update, and pairing screens with a named reason. Each
capture request carries its own byte budget. The background worker proves
liveness through Core. A revoked credential drops at once, so the next
launch re-pairs against the retained server URL.

## Renderer ownership and the Core handshake

Core drives a renderer through renderer reports. A renderer that Core did
not register shows nothing, and Core reports `Renderer disconnected` for
it. Follow these rules so a live WebView is always a registered renderer.

### Who owns what

```text
Player Core (Rust, process-level host)
    -> Android renderer adapter (WebViewCoreRenderer, process-level)
    -> trusted shared Player Runtime WebView
    -> image, video, Layout, Widget, and website surfaces

Compose (MainActivity)
    -> setup, pairing, maintenance, commissioning, update, recovery,
       and the status surface over the WebView
```

- `ProcessRenderer` owns one `WebViewCoreRenderer` for the process. The
  WebView uses the application context, so it does not need an Activity.
- `PlayerCoreHost` owns the Core connection. `MainActivity` never creates,
  numbers, connects, or closes a renderer.
- An Activity only attaches. `onCreate` attaches the capture hooks with
  `ProcessRenderer.attachPresentation`, and `AndroidView` adopts the view.
  `onDestroy` detaches the hooks and releases the view only while it is
  still parented to that Activity's window. A replacement Activity keeps
  its view.
- Activity recreation, a task restart, and a warm launch reuse the same
  renderer. They do not reload the runtime.
- A renderer-process death (`onRenderProcessGone`) creates a replacement
  WebView with a new generation. This is the only reason a renderer is
  replaced, apart from the operator action **Restart display**.

Do not move renderer creation, numbering, or closing into an Activity.
`onDestroy` cannot finish asynchronous work: the coroutine scope of the
Activity is cancelled with the Activity, so a close started there can stop
before it reports `disconnected` and before it destroys the WebView.

### Generations

A generation names one WebView instance. `RendererGenerations.allocate`
gives out generations from one process-wide counter, and `RuntimeCrashPolicy`
takes every generation from it. A generation is never reused in a process.

Core keeps one live renderer link. A `disconnected` report only removes the
link when its generation equals the live one. Core refuses a `connected`
report with a generation lower than the live one and ignores a repeated
`connected` for the live generation. A late disconnect from an old renderer
therefore cannot disconnect a newer renderer.

### Registration

`RendererHandshake` makes the `connected` report durable:

1. The renderer creates the WebView and calls `begin(generation)`.
2. The handshake waits for Core. `PlayerCoreHost.awaitReady` returns when
   the native host is open. It uses no polling and no delay.
3. The handshake sends `connected(generation)`.
4. Answer `APPLIED` registers the generation. Answer `BAD_HANDLE` (Core
   not ready) retries with a bounded backoff of 50, 100, 250, 500, 1000,
   2000, and 5000 ms, then fails with `registration_core_unavailable`. Any
   other answer is a permanent protocol error: the handshake stops and fails
   with `registration_rejected_<code>`.
5. Every wait stops when the generation is no longer current.

When the runtime page reports `ready` before registration, the handshake
keeps it and sends it after registration. When Core ignores a `ready` (it
has no live link for that generation), the handshake registers again and
resends `ready`. After three attempts it fails with `ready_not_applied`.

Core replays the current committed presentation when it accepts a `ready`
report. This applies to a first renderer, a replacement renderer, and a
renderer that reconnects after Core received new content while no renderer
was connected.

### What the screen shows

`RendererHandshake.lifecycle` holds a `RendererLifecycle` with a phase and a
stable reason code. The state comes from the handshake, never from pixels:

| Phase         | Meaning                                                        |
| ------------- | -------------------------------------------------------------- |
| `STOPPED`     | No WebView exists.                                             |
| `CONNECTING`  | A WebView exists. Core has not accepted its connection.        |
| `LOADING`     | Core accepted the connection. The page has not reported ready. |
| `READY`       | The runtime reported ready and Core accepted it.               |
| `FAILED`      | Registration or the runtime document failed. See `reason`.     |
| `UNSUPPORTED` | The installed WebView cannot host the secure runtime bridge.   |

`MainActivity` keeps the WebView attached so its page can load. It covers
the view with a native status surface until the phase is `READY`. After 15
seconds in any other phase, or at once in `FAILED`, the surface names the
reason code and offers **Restart display**. The surface appears on state, not
on pixel color, so authored black content is never mistaken for a failure.

### Diagnostics

The renderer writes structured events to logcat under the tag
`TilecastRenderer`. Each event is `event=<name>` followed by `key=value`
fields. Fields hold generations, attempt counts, activation IDs, and stable
codes. They never hold credentials, URLs, headers, or page data.

| Event                                        | Meaning                                                   |
| -------------------------------------------- | --------------------------------------------------------- |
| `renderer_owner_created`                     | The process created its one renderer.                     |
| `renderer_generation_allocated`              | A handshake began for a generation.                       |
| `webview_creating`, `webview_created`        | The trusted WebView is being created or exists.           |
| `runtime_document_started`, `_finished`      | The runtime entry page loaded.                            |
| `runtime_document_failed`                    | The entry page failed. `code` is `net_<n>` or `http_<n>`. |
| `runtime_asset_failed`                       | A packaged runtime file failed to load.                   |
| `connected_sent`, `connected_result`         | `connected(N)` and the Core answer code.                  |
| `connected_retry_scheduled`                  | Core answered `BAD_HANDLE`. A retry follows.              |
| `connected_accepted`                         | Core registered the generation.                           |
| `runtime_ready_received`                     | The page reported ready.                                  |
| `ready_sent`, `ready_result`                 | `ready(N)` and the Core answer code.                      |
| `reregister_scheduled`                       | Core ignored `ready`. The handshake registers again.      |
| `activation_queued`                          | Core pushed an activation to the runtime.                 |
| `activation_accepted`, `activation_rejected` | The runtime accepted or refused the activation.           |
| `first_playback_evidence`                    | The first evidence report for an activation.              |
| `renderer_replaced`                          | A new WebView replaced a previous one.                    |
| `disconnected_sent`, `disconnected_result`   | `disconnected(N)` and the Core answer code.               |
| `disconnect_stale_ignored`                   | A disconnect for a generation that is not current.        |
| `render_process_gone`                        | The WebView render process ended.                         |
| `renderer_failed`                            | The handshake failed. `reason` is the stable code.        |

Answer codes are `0` applied, `1` ignored, `2` malformed, and `3` bad handle.

A handshake failure also reaches the server. The handshake sends a `fault`
report, Core keeps its code, and the heartbeat carries it as
`lastRendererFailure`. Tilecast Studio shows it as **Last renderer failure**
in Player health.

## Capability definitions

External plugin frames use independent grants inside the current presentation
generation. The host verifies their files before a plugin update. A refused
update retains the previous grants. A successful update replaces only plugin
grants and keeps media and Widget grants. Plugin responses deny all passive
loads. The native message listener accepts only the main Runtime frame, and
the host bootstrap runs only in the entry document. Child navigation cannot
enter the trusted Runtime tree. Android does not report
`plugin.external-runtime@1` and does not set `externalPluginFrames` in its
Runtime host. Qualification on a physical device must pass first. See
[external Player plugins](external-player-plugins.md) for the shared contract,
the support matrix, and the qualification gates.

`apps/player-android/renderer-profile.json` is the one definition of what the
Android renderer host provides: renderer features, presentation schemas, and
the `web.remote` and `widget.external-runtime` capabilities. The player
contracts generator turns it into `native/src/renderer_profile.rs` and
`RendererProfile.gen.kt`. Declarative presentation capabilities and Widget
components keep their existing generated sources.

The native crate prepares manifests against `profile::packaged()`. The live
renderer advertises `RendererReadyReport` after its WebView proves support.
Both are built from the definitions above, so a manifest that preparation
accepts is a manifest the live renderer advertises. Two tests enforce this:
`packaged_profile_equals_the_live_report_contract` in `manifest_host.rs` and
`RendererReadyReportTest`. Both rebuild the expected report from
`renderer-profile.json`. Change a capability in the definitions, then run
`npm run player-contracts:generate`. Never edit a list in `WebViewCoreRenderer`
or `manifest_host.rs`.

## Typography

Tilecast-owned native text uses Geist. `TilecastFontFamily` and
`SignalTypography` in `ui/theme/Type.kt` are the only place a font family is
chosen. The Gradle task `syncGeistFont` copies the vendored official Geist
variable font from `apps/ios/Tilecast/Resources/Fonts/Geist-Variable.ttf` into
a generated font resource, and copies its SIL Open Font License into the APK
assets. The Android build keeps no second font binary. The app never fetches a
font, so an offline display keeps its typeface. Android 8.0 and later draw
each weight as a variation of the file. Earlier releases draw the default
weight. Glyphs that Geist does not contain fall back to the system font.

The shared Player Runtime bundles its own Geist as WOFF2 from
`@fontsource-variable/geist`, and the WebView loads it from
`https://appassets.androidplatform.net/assets/shared-runtime/fonts/`.
`TilecastTypographyTest` fails when a native style leaves Geist, when
a source file selects a platform font family, and when the packaged runtime
loses its fonts.

## Hardware qualification

Run this procedure on a physical Google TV, Android TV, or Fire TV device
after any change to the renderer, `MainActivity`, `ProcessRenderer`, or the
Core renderer protocol. Emulators do not show every WebView behavior. Use a
test organization and a screen you can change in Tilecast Studio. Keep
`adb logcat` open in a second terminal:

```sh
adb logcat -c
adb logcat -v time TilecastRenderer:I '*:S'
```

Do not skip a step that fails. Stop and record the log.

1. **Clean install.** Run `adb uninstall org.tilecast.player`, then
   `adb install -r app-debug.apk`.
2. **Launch.** Run
   `adb shell am start -W -n org.tilecast.player/.MainActivity`.
   Expect the native setup screens.
3. **Pair.** Enter the server address and approve the pairing code in Studio.
   Expect `Connecting <screen name>…`, then playback or `No content assigned`.
4. **Connected and ready.** Expect this order in the log, with the same
   generation `N`: `webview_created`, `runtime_document_finished`,
   `connected_sent`, `connected_accepted`, `runtime_ready_received`,
   `ready_sent`, `ready_result code=0`. In Studio, **Player health** shows the
   renderer as Healthy or Waiting for playback, never Disconnected.
5. **Image.** Assign an image as default content. Expect `activation_queued`,
   `activation_accepted`, and `first_playback_evidence`. The image shows.
6. **Video.** Assign a video. Expect the same events and moving video.
7. **Layout.** Assign a Layout directly. Expect the Layout on screen.
8. **Playlist zone.** Assign a Layout with a Playlist zone that holds only
   images and videos. Expect the zone to play.
9. **Hot update.** Leave the Player running. Do not touch the device. In
   Studio, change the default content from the item in step 5 to a different
   item, and change it between a Playlist, a Layout, and back.
10. **New content appears** within one server push interval (seconds). The log
    shows a new `activation_queued` with a different `activation` value and
    **no** `renderer_replaced`, `webview_creating`, or `connected_sent`.
11. **Warm start.** Run the `am start` command from step 2 again, without
    force-stop. Expect the content to stay or return at once. The log shows no
    new `webview_created`.
12. **Content remains.** Confirm the content and **Player health** are
    unchanged.
13. **Background and foreground.** Press Home, wait 30 seconds, then reopen
    Tilecast from the launcher. The content returns. No `connected_sent`
    appears.
14. **Restart the task.** Run `adb shell am force-stop org.tilecast.player`,
    then `am start`. A new process starts the generation counter again.
    Expect `Connecting…`, then the step 4 events with a small generation
    number, then content.
15. **Renderer-process recreation.** Find the WebView process
    (`adb shell ps -A | grep -i webview` or `sandboxed_process`) and run
    `adb shell kill <pid>`. Expect `render_process_gone`, then
    `renderer_replaced` with a **higher** generation, `connected_accepted`,
    `ready_result code=0`, and the content again. The app process stays alive.
16. **Network loss.** Disable the network for 60 seconds, then enable it.
    Content keeps playing from the cache. After the network returns, Studio
    shows the Player online again without a restart.
17. **No indefinite black screen.** At every step above, the screen shows
    content, the Tilecast starting surface, or the **Display unavailable**
    surface with a reason code and **Restart display**. A pure black screen
    that persists for more than 15 seconds with the Activity in the
    foreground is a failure. Record `adb logcat -d`, `adb shell dumpsys
activity top`, and the **Player health** panel.
18. **Studio matches the device.** After each step, compare **Player health**
    with the screen. A Disconnected renderer on a screen that shows content,
    or a Healthy renderer on a black screen, is a failure.

Expected status transitions in Studio for a clean launch: Awaiting player,
Online with renderer Starting, then Waiting for playback, then Healthy once
the first evidence arrives. A renderer fault shows the code from the log as
**Last renderer failure**.

## Launcher branding

The launcher artwork comes from two authoritative SVG files in
`apps/player-android/branding/source/`:

| File                    | Use                                           |
| ----------------------- | --------------------------------------------- |
| `tilecast-mark.svg`     | Standalone mark. Launcher icon and Play icon. |
| `tilecast-wordmark.svg` | Full wordmark. Android TV banner.             |

The generator reads path data from these files. It does not redraw the logo.
It only moves and scales it. To change the artwork, replace the source SVG and
run:

```sh
npm run android:branding:generate
npm run android:branding:check   # fails when generated files are out of date
```

The generator writes these files. Do not edit them by hand.

- `res/drawable/ic_launcher_foreground.xml`: the mark as a VectorDrawable.
- `res/mipmap-*dpi/ic_launcher.png`: the fallback icon for Android 6.0 to 7.1.
- `res/drawable-xhdpi/tilecast_banner.png` (320×180) and
  `res/drawable-xxhdpi/tilecast_banner.png` (480×270): the TV banner.
- `branding/play-store/tilecast-play-icon-512.png`: the Google Play icon. It is
  not part of the APK.

`res/mipmap-anydpi-v26/ic_launcher.xml` is the adaptive icon. It has a
background layer (`tilecast_signal_background`) and a foreground layer. The
same single-color foreground is also the `<monochrome>` layer. Android and OEM
launchers apply the mask and any parallax. Tilecast does not change the logo
for a launcher. Android TV does not use phone-style themed icons, so the
monochrome layer has no effect on TV today.

The mark stays inside a 52 dp circle at the center of the 108 dp layer. The
Android safe zone is a 66 dp circle, so no launcher mask can crop the mark. The
legacy icon and the Play icon show the central 72 dp of the same layers, so all
three look the same.

The default treatment is a white mark on the Tilecast dark background
(`#0E141B`, the Player background in the design system). The banner is the
white wordmark on the same background, with no tagline. The wordmark is a
product name and is not translated, so there is one banner for all locales.

To inspect the artwork under circle, squircle, and rounded-square masks, run
`node apps/player-android/branding/generate-launcher-assets.mjs --preview <dir>`.
`LauncherBrandingContractTest` fails if the manifest stops using the adaptive
`@mipmap/ic_launcher` icon or if a required resource is missing.

## Commissioning and unattended-recovery checks

Pairing a fresh installation enters the required commissioning wizard before playback. Emulator tests can exercise PIN storage, permission-state verification, unattended self-update policy selection, boot receiver registration, immersive/keep-awake reporting, cached-manifest checks, recovery escalation, and safe mode. They cannot prove firmware foreground-launch behavior, physical-TV wake/standby, or whether a vendor installer honors Android's unattended-update request.

Do not bypass commissioning in debug builds. For repeat testing, use **Run setup again** from the local maintenance menu. `BOOT_COMPLETED` and `LOCKED_BOOT_COMPLETED` recovery state is stored in device-protected preferences. Watchdog crash history is stored independently of the activity so process recreation does not reset escalation.

```sh
cd apps/player-android
./gradlew testDebugUnitTest lintDebug assembleDebug
```

The debug APK is `app/build/outputs/apk/debug/app-debug.apk`. Build an unsigned, optimized release artifact with `./gradlew assembleRelease`. For distribution, configure a release keystore through local Gradle properties or CI secrets. Never commit a keystore, alias password, or store password.

The single `org.tilecast.player` application ID is suitable for Play Store and direct APK distribution. Do not introduce Fire TV or Google TV variants unless a future store requirement cannot be handled through resources or manifest metadata.

The shared Player Runtime is the only presentation implementation. Playlists, Widgets (including V2 components), Layouts, websites, and YouTube play in the trusted Player Runtime WebView through generic references plus a projection context. The player keeps no Compose renderer and no Media3 dependency. The player skips unsupported entries in ordinary playlists. It keeps the other entries playing and reports the unsupported content. It does not start reliability recovery. A synchronized group stops if any entry cannot render. It must keep one shared timeline for all screens. Tickers and countdown bars project inside the runtime page. Core drives website data clearing through the renderer command channel. The website navigation policy stays host-owned.

Calendar Sources project inside the shared runtime from sanitized manifest data. The Player does not fetch ICS, receive feed URLs, or use WebView for calendar content. Manifest validation bounds event counts and text before activation. Cached manifest startup preserves last-known-good prepared events.

RSS, Atom, JSON, and CSV Sources use manifest v8 and project inside the shared runtime. The Player validates provider, presentation, record count, and text/value bounds before activation. It never fetches feed/data URLs, executes expressions, or routes structured Sources through WebView. Prepared records live in the verified cached manifest, so offline startup uses the same last-known-good data.

Manifest v9 adds Clock, Date, QR Code, and Ticker Apps, which project inside the shared runtime. Structured date selection runs locally against the configured IANA timezone and uses calendar arithmetic rather than 24-hour durations. The Player reevaluates while running and after process restart. `empty`, `hide`, `fallback_text`, and `next_available` do not silently reuse an old record. `last_known_good` is an explicit administrator choice.

Layout schema v1 is validated at the shared contract and Player Core boundary before activation. Layouts travel to the shared runtime as references. Groups are structural and never inject markup. Canvas coordinates scale uniformly into landscape or portrait display bounds.

Unit tests cover URL policy, Core-to-UI state mapping, player-generated identity, secure-storage abstractions, and reconnect backoff. Core owns pairing enrollment, revocation, and scheduling, and the Rust tests cover them. Instrumented tests require an emulator or device:

The old Room database and Kotlin schedule engine are migration inputs, not current playback authorities. The native importer accepts the legacy database using the documented binding and integrity checks. Player Core owns offline manifest and scheduling policy; shared fixtures keep Server selection and Player behavior compatible.

Offline recovery verification should activate a Download-policy playlist, stop Tilecast or disconnect the network, force-stop and reopen the application, and confirm playback resumes. Stream-policy items are intentionally skipped while unavailable.

```sh
adb devices
./gradlew connectedDebugAndroidTest
```

Websites render through the trusted shared Player Runtime WebView and its host-owned navigation and isolation rules. Validate exact-host policy, TLS failure, D-pad focus, process termination, and installed WebView versions on supported devices. Player Core accepts effective configuration revisions independently from manifests; platform adapters apply OS effects.

The effective configuration is authoritative for every setting the Android
Player advertises. Cache limits, free-space reserve, download concurrency and
thresholds, manifest/status intervals, website timeout/cookie/reload policy,
reliability limits, safe mode, playback defaults, branding, power/display
policy, and screen-location reporting are validated before application. A
configuration revision reschedules affected timers and updates supervisors;
`clearOnRestart` is evaluated only at process startup. Display-control-only
schedules are not assignable to Android screens until Android reports the
required display capability.

Cached manifests, configuration, downloads, and playback checkpoints carry
the installation ID, screen ID, and normalized server URL. A replacement
installation or screen assignment quarantines incompatible state. Cached
assets are accepted only after their expected SHA-256 and size verify, and an
APK installer selects the exact persisted release/artifact/path rather than
the newest staged file.

Production Player release signing is free and independent of app stores. Preserve one permanent Android keystore and a separate Ed25519 manifest key. Gradle reads signing values only from local environment variables, and `scripts/build-player-release.sh` fails closed when any secret is missing. See [player-updates.md](player-updates.md). Emulator/debug builds do not validate production-key replacement.

Manifest v12 adds the common typed Data Source contract and native Countdown, Metric, Cards, and Weather renderers. This Player accepts both v11 and v12. Release version code 22 or later before assigning v12 presentations. Studio blocks assignments when any target screen in the assignment reports an older or unknown Player version.

Manifest v13 adds the provider-neutral data document, declarative native interpreter, and constrained web descriptor host. The Player reports presentation schema 1, versioned native capabilities, web runtime version 1, and its bundle limit in heartbeat metadata. Validation enforces dataset, nesting, node, repeat, animation, URL, and capability bounds before activation. V11/v12 remain readable for cached startup and staged rollout.

Player 0.14.9 (version code 33) accepts manifest v14 and adds opt-in visual crossfades. Only playlist entries adjacent to a `crossfade` transition use a compositable video texture. `none` and `fade` retain the existing video surface path. Layout items aggregate first-frame readiness from their visible playlist, Widget, website, and media placements before releasing the outgoing item. Crossfade is visual only, so outgoing audio is muted at the item boundary.

Capability revision 2 adds actual line/bar/donut drawing, downloaded asset images, built-in status icons, target progress, repeat indexes, numeric/date conditions, and multi-series time data. Chart and image content must remain within manifest verification and offline cache policy.

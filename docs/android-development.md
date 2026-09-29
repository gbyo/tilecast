# Android player development

Tilecast Player requires JDK 17 and Android SDK 35. It uses the checked-in Gradle wrapper and has no Google Play Services dependency.

## Commissioning and unattended-recovery checks

Pairing a fresh installation enters the required commissioning wizard before playback. Emulator tests can exercise PIN storage, permission-state verification, unattended self-update policy selection, boot receiver registration, immersive/keep-awake reporting, cached-manifest checks, recovery escalation, and safe mode. They cannot prove firmware foreground-launch behavior, physical-TV wake/standby, or whether a vendor installer honors Android's unattended-update request.

Do not bypass commissioning in debug builds. For repeat testing, use **Run setup again** from the local maintenance menu. `BOOT_COMPLETED` and `LOCKED_BOOT_COMPLETED` recovery state is stored in device-protected preferences. Watchdog crash history is stored independently of the activity so process recreation does not reset escalation.

```sh
cd apps/player-android
./gradlew testDebugUnitTest lintDebug assembleDebug
```

The debug APK is `app/build/outputs/apk/debug/app-debug.apk`. Build an unsigned, optimized release artifact with `./gradlew assembleRelease`. For distribution, configure a release keystore through local Gradle properties or CI secrets. Never commit a keystore, alias password, or store password.

The single `org.tilecast.player` application ID is suitable for Play Store and direct APK distribution. Do not introduce Fire TV or Google TV variants unless a future store requirement cannot be handled through resources or manifest metadata.

The shared Player Runtime is the only presentation implementation. Playlists, Widgets (including V2 components), Layouts, websites, and YouTube play in the trusted Player Runtime WebView through generic references plus a projection context. The player keeps no Compose renderer and no Media3 dependency. The player skips unsupported entries in ordinary playlists. It keeps the other entries playing and reports the unsupported content. It does not start reliability recovery. A synchronized group stops if any entry cannot render. It must keep one shared timeline for all screens. Plugin overlay bars (emergency tickers, countdown bars) stay native overlays above playback; website data clearing and the website navigation policy stay host-owned.

Calendar Sources project inside the shared runtime from sanitized manifest data. The Player does not fetch ICS, receive feed URLs, or use WebView for calendar content. Manifest validation bounds event counts and text before activation. Cached manifest startup preserves last-known-good prepared events.

RSS, Atom, JSON, and CSV Sources use manifest v8 and project inside the shared runtime. The Player validates provider, presentation, record count, and text/value bounds before activation. It never fetches feed/data URLs, executes expressions, or routes structured Sources through WebView. Prepared records live in the verified cached manifest, so offline startup uses the same last-known-good data.

Manifest v9 adds Clock, Date, QR Code, and Ticker Apps, which project inside the shared runtime. Structured date selection runs locally against the configured IANA timezone and uses calendar arithmetic rather than 24-hour durations. The Player reevaluates while running and after process restart. `empty`, `hide`, `fallback_text`, and `next_available` do not silently reuse an old record. `last_known_good` is an explicit administrator choice.

Layout schema v1 is decoded into typed Kotlin models and validated before activation. Layouts travel to the shared runtime as references. Groups are structural and never inject markup. Canvas coordinates scale uniformly into landscape or portrait display bounds.

Unit tests cover URL policy, state transitions, player-generated identity, secure-storage abstractions, pairing enrollment, revocation, and reconnect backoff. Instrumented tests require an emulator or device:

Milestone 4 uses Room schema version 2. `MIGRATION_1_2` preserves pairing configuration while adding manifest and cache metadata. Media bytes live under the application-controlled `files/media-cache` directory. Startup loads verified active content before network reconciliation.

Milestone 5 keeps Room schema version 2 because schedule definitions live in the atomically stored manifest JSON. `ScheduleEngine` is isolated from Compose and evaluates with `java.time` timezone rules. Startup, manifest activation, foregrounding, clock/timezone broadcasts, and calculated transitions trigger reevaluation. Shared fixtures under `packages/manifest-schema` verify Go/Kotlin precedence parity.

Offline recovery verification should activate a Download-policy playlist, stop Tilecast or disconnect the network, force-stop and reopen the application, and confirm playback resumes. Stream-policy items are intentionally skipped while unavailable.

```sh
adb devices
./gradlew connectedDebugAndroidTest
```

Milestone 6 uses the system Android WebView through a dedicated website playback component. Test exact-host policy and safe configuration on the JVM. Validate renderer behavior, D-pad focus, installed WebView versions, TLS failures, and process termination on the target emulator/device. Tilecast does not require Google Play Services or a Chrome-specific API.

Milestone 8 adds `PlayerConfigManager`, the validated source for effective branding, playback defaults, cache/download policy, and reporting intervals. Room schema 3 preserves current and previous valid configuration revisions independently of content manifests.

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

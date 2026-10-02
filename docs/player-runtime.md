# Tilecast Player Runtime

**Package:** `packages/player-runtime` (`@tilecast/player-runtime`)
**Hosts:** the Electron Linux player (`apps/player-linux`), the WPE renderer (`apps/edge/renderer-wpe`), and the Android trusted local WebView as Android convergence lands (`apps/player-android`)
**Host contract:** `TilecastRuntimeHostV1` (contract version 1)

The Player Runtime is the one trusted playback document and engine for Tilecast screens. Electron and WPE host the same built artifact from the same runtime sources, and Android's convergence loads that same runtime behind its trusted local WebView boundary, so presentation behavior does not acquire a host-specific Widget renderer.

Studio is deliberately **not** another host of this complete runtime. Studio shares the **Widget renderer** only: the Widget runtime module plus `WidgetMount` from `@tilecast/widget-sdk`. Authoring preview provides its own preview `WidgetContext`, resources, locally edited configuration, and geometry; it does not run the XState playback engine, occurrence staging, evidence, synchronization, or playback host bridge.

```text
host process (Electron, tilecastd/WPE, or Android trusted WebView host)
        │  TilecastRuntimeHostV1 (typed members only)
        ▼
@tilecast/player-runtime  ── Lit views ── Stage + item surfaces ── DOM / <video> / <img>
        │
  XState playback engine ── scheduler (monotonic clock) ── synchronized timeline
```

## 1. Ownership

The runtime owns:

- the trusted display DOM and its stylesheet;
- the setup, pairing, status, error, safe-mode, outside-hours and AirPlay surfaces;
- playback presentation: item surfaces, the two-layer stage and transitions;
- render-tree interpretation, Layout display and the built-in plugin surfaces (compatibility code, §6);
- mounting first-class Widgets V2 components and turning their state into evidence (§6);
- browser-side playback evidence.

The runtime does not own server credentials, server reconciliation, Edge SQLite state, the Edge CAS, the Electron IPC implementation, WPE or GLib APIs, filesystem access, or the host's kiosk and process lifecycle.

The cross-process contract owners, generated capability registry, and shared Server URL fixture corpus are inventoried in [player-contracts.md](player-contracts.md). Widget component capabilities remain owned by `widgetctl`.

## 2. Host contract

A host publishes one object, `globalThis.tilecastRuntimeHost`, that implements `TilecastRuntimeHostV1` (`src/host/contract.ts`). The contract has no generic message or native-invocation member. Every function is named and typed:

| Direction      | Members                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Host → runtime | `subscribe(listener)` delivers `presentation`, `plugins`, `identify`, `command` and `discovered-server` messages. |
| Runtime → host | `ready`, `presentationResult`, `reportEvidence`, `reportPlaybackError`.                                           |
| Optional       | `setup.submitServerUrl`, `discovery.list`, `remoteWeb.reportRecovered`, `conformance`.                            |

Behavior depends on `capabilities`, never on `info.host`:

| Capability             | Electron           | WPE (Edge)                   |
| ---------------------- | ------------------ | ---------------------------- |
| `remoteWeb`            | `electron-webview` | `host-view`                  |
| `synchronizedPlayback` | `true`             | `true` (`tilecastd` anchors) |
| `setup`                | `true`             | `true`                       |
| `discovery`            | `true`             | `true` (Avahi, `tilecastd`)  |

`info` (host name and version, engine name and version) is for diagnostics only.

The runtime validates the host object at start (`hostContractProblem`). A missing bridge or a different contract version shows the "Display bridge unavailable" surface instead of a black screen.

Everything that crosses the contract is data. The runtime receives no credential, no path, no server response and no executable. Media is addressed only by URIs the host already authorized (`tcmedia:`).

The `conformance` member exists only for the conformance suite (§8). It switches the runtime to a manual clock and instant transitions. No production host sets it.

## 3. Playback engine

The playback lifecycle is explicit XState 5 state machines (`src/engine`). They never touch the DOM.

- **Player** (`player-machine.ts`): which surface owns the screen (`status`, `sleep`, `playing`). Every presentation re-enters `playing`, which stops the invoked presentation actor and starts a new one. This is how a takeover, a manifest change, a synchronized boundary or a re-projection interrupts playback.
- **Presentation** (`presentation-machine.ts`): one actor per presentation generation. The occurrence states are `routing` (mount), `preparing` (staged on the hidden layer), `showing`, `advancing` (the one-task hand-off), `failed` (isolation and back-off) and `skipping` (empty widgets). One completion arbiter per occurrence decides between restart in place, advance and ignore.
- **Zone** (`zone-machine.ts`): one actor per Layout playlist zone, stopped with its Layout.

The machines do not use XState `after` delays or browser timers. `src/clock/scheduler.ts` is the only user of browser timers. The machines ask it for monotonic deadlines and receive typed events (`DURATION_DUE`, `ADVANCE_DUE`, `BACKOFF_DUE`). Deadlines are owned by a timer group per occurrence. Mounting the next occurrence cancels the group, so nothing scheduled for a replaced item can act on its successor.

### 3.1 Durations and the dwell floor

A duration is a positive number of milliseconds or it is absent. `clock/duration.ts` is the only place that decides which, and every timer in the runtime reads durations through it. Zero, a negative number, `NaN`, and a missing value all mean "no duration". An image with no duration runs for `IMAGE_DEFAULT_MS`. A website runs for `WEBSITE_DEFAULT_MS`. A widget or layout with no duration stays until something replaces it.

No occurrence completes before `MIN_ITEM_DWELL_MS` (1000 ms) has passed since it mounted. A completion that arrives earlier, from a one-millisecond duration or from a surface that reports `ended` as it mounts, is delivered again when the floor passes. It is not dropped, so exactly one completion path still wins the occurrence. A Layout playlist zone reads a zero image duration as unset, and the synchronized timeline applies the floor to every slot.

Before this floor, a host that sent a synchronized slot of zero or one millisecond put the screen on a cycle that rolled over every millisecond. The runtime tore down and remounted the item as fast as the renderer could paint. Each remount was recorded as a separate one-millisecond play. Studio does not accept an item duration under one second, so the floor removes only values that are already faults.

The playback rules are the Electron player's, unchanged: `engine/playback-policy.ts` (playback authority, the completion arbiter, stale-callback identity, drift correction bands, the crossfade decision and outgoing-layer cleanup) moved into the runtime with its tests.

## 4. Synchronized playback

`engine/timeline.ts` drives a group's shared timeline. At activation it reads the wall clock once, corrected by the host's `clockOffsetMs`, to place the screen in the cycle. From then on the position comes from the monotonic clock, so an NTP step or a manual clock change never jumps what is on screen. At each boundary the timeline reports the outgoing item's transition and re-presents the playlist rotated to the expected item. The presentation machine has no local authority under a shared timeline. Four times a second the timeline publishes the expected position, and the visible video surface applies the existing drift-correction bands.

The timeline math (`clock/synchronized.ts`) is shared with the Electron main process, which builds the anchor from the active manifest (`apps/player-linux/src/main/runtime-messages.ts`). On Edge, `tilecastd` builds the same anchor and effective durations from the manifest (`manifest.rs`, `group_timing`) and sends them as `timing` with the activation. The anchor is fixed for that activation; the offset is the daemon's current one each time the timing is sent, so a restarted renderer rejoins with the best estimate. Neither host re-activates for a later offset sample.

## 5. Views, surfaces and transitions

- **Views** are Lit 3 components in light DOM (`src/views`): `<tc-player>`, `<tc-status-surface>` and `<tc-outside-hours>`. They render the engine's view state and decide nothing about playback. Style bindings use `cssProps` (CSSOM only), because Lit's `styleMap` writes a `style` attribute, which `style-src 'self'` refuses.
- **Surfaces** implement `MediaSurface` (`prepare`, `activate`, `pause`, `seek`, `dispose`): `ImageSurface`, `HtmlVideoSurface`, `WidgetSurface`, `LayoutSurface`, the legacy Electron `WebviewWebsiteSurface`, and `HostRemoteWebSurface` for host-owned remote web. Edge supplies that host view through the isolated WPE helper. The engine depends on the interface only, so another native media pipeline, if hardware testing ever justifies one, needs no change to the engine.
- **The stage** (`surfaces/stage.ts`) is the only code that creates or destroys media elements. The playback layers carry no Lit bindings, so no reactive update can replace an active `<video>`. An incoming occurrence is prepared on the hidden layer. The outgoing surface is paused and released when the transition finishes, so two full-screen decoders overlap for the transition and no longer.
- **Transitions** use the Web Animations API (`transitions/crossfade.ts`). A transition has one clock and one `finished` signal. A takeover or a newer swap cancels it, which puts both layers in their resting state at once.
- **Video evidence**: `HtmlVideoSurface` reports `video-progress` only while decoded frames are presented, when `requestVideoFrameCallback` is available and has fired. Otherwise it falls back to advancing media time. The API makes evidence stronger; playback never requires it.
- **Plugin surfaces** come from the runtime surface host (`src/plugins`). The host finds each runtime plugin when the runtime is built, gives it one container for each surface that it declares, arbitrates each slot by the declared tier and the claimed priority, and sets the content-stage insets and the corner lift. A plugin draws only inside its containers. [plugin-api.md](plugin-api.md#player-runtime) is the contract.

## 6. Compatibility code and the widget seam

The current widget system is preserved as compatibility code and labelled as such:

- `src/compat/projection`: the server-compiled Widget and Layout projection into the RenderNode tree. The Electron main process imports it through `@tilecast/player-runtime/projection`. The runtime runs it itself when a host sends references and a projection context (`compat/projector.ts`). The context may carry the accepted player configuration's `playback` section; the projector then applies its regional formatting and layout playlist-zone defaults exactly as the Electron main process does. The member is optional and additive, so `TilecastRuntimeHostV1` stays at contract version 1.
- `src/compat/render-tree-dom.ts`: the RenderNode interpreter.

RenderNode is not the Player Runtime's permanent widget API. Widgets V2 ([widgets-v2.md](widgets-v2.md)) replace it for migrated Widgets:

- A Widgets V2 Widget is one custom element (Lit 3) in `widgets/<name>/runtime/`. The runtime finds every Widget module when it is built (`src/widgets/host.ts`, `import.meta.glob`). There is no Widget switch in the runtime.
- A manifest v16 `kind: "component"` presentation projects to a `RuntimeWidgetComponentPayload` (`src/widgets/projection.ts`): the component reference, the Data Documents and media variants it declares, and the regional formatting. The payload has no time-dependent value, so re-projection does not restart the Widget.
- `ComponentWidgetSurface` mounts a fullscreen Widget, and `LayoutSurface` mounts a Widget in a zone, through the same `WidgetMount` from `@tilecast/widget-sdk`. `prepare()` settles when the Widget reports `ready` or `empty`. The runtime, not the Widget, reports `widget-shown`, `widget-alive` and `layout-zone-rendered`.
- A Widget keeps time with the corrected clock: the local wall clock plus the host's latest `clockOffsetMs` (from `plugins`, `projection` or `timing`), scheduled on the runtime scheduler. A conformance run's manual clock drives Widgets like everything else.
- The runtime refuses to mount a Widget when the engine cannot adopt constructed stylesheets (`widget_styles_unsupported`). The CSP refuses the `<style>` fallback, so the Widget would otherwise render unstyled.
- `src/widgets/capabilities.gen.ts` (generated by `npm run widgets:generate`) lists `widget.<type>` for each bundled Widget. The Electron main process reports it in the heartbeat with presentation schema 2. The Edge daemon reports the generated `widget_capabilities.rs`. A test proves that the list equals what discovery finds.

## 7. Security and appearance

- The document's CSP is `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' tcmedia: data:; media-src tcmedia:; frame-src https: http:`. It has no `unsafe-inline` and no CSP bypass privileges.
- `tilecast://runtime/` serves only files listed in the artifact's `runtime-manifest.json` (Electron) or allowed by `tc_runtime_path_is_allowed` (WPE). The names are top-level files and `fonts/<name>`, and anything a URL parser would rewrite is refused.
- The Electron renderer runs with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`. The preload is a thin adapter that requires only `electron`. The synchronized-timeline enrichment that forced `sandbox: false` moved to the main process.
- Tilecast-owned surfaces use the bundled Tilecast UI face (Geist, SIL Open Font License 1.1, `static/fonts/OFL.txt`) rather than the distribution's `system-ui`. The display ignores host dark-mode and forced-colour preferences.

## 8. Conformance suite

`packages/player-runtime/conformance` runs one fixture host and a set of deterministic fixtures under every engine:

- `conformance/host/conformance-host.ts` is a `TilecastRuntimeHostV1` that plays a fixture script (host messages, clock steps, evidence waits, checkpoints) into the runtime on a manual clock with instant transitions.
- The Electron runner (`apps/player-linux/conformance/runner.cjs`) loads the runtime through the player's own `tilecast://runtime/` protocol module.
- The WPE runner (`apps/edge/renderer-wpe/tests/conformance.c`) loads it through the renderer's own path validation and `tcmediasrc` media source on WPEPlatform headless.
- The Android runner (`apps/player-android/app/src/androidTest/.../PlayerRuntimeConformanceTest.kt`, driven by `apps/player-android/conformance/run-android.sh`) loads the exact packaged runtime asset through the same app-owned origin production uses, injects the same fixture host, serves `tcmedia:` bytes from the pushed fixture store, and captures per-checkpoint screenshots with UiAutomation. Its `@JavascriptInterface` bridge is test-only surface that never ships. Remote web fixtures run with the default null `remoteWeb` capability, exactly as on WPE: host-owned Android WebViews get Android-specific host tests instead of pixel comparison.
- `compare.mjs` requires identical semantic state, evidence, errors and presentation results at every checkpoint. It compares screenshots perceptually, with a 1.5 % mismatch budget. Active video and remote web content are never pixel-compared. On a failure the report keeps both screenshots, the diff, the fixture and the engine versions.

The fixtures cover setup and discovery, pairing, idle, offline, disabled and safe-mode surfaces, image contain, cover and fill, playlist transitions, the video lifecycle, a synchronized join and boundary with a wall-clock step, Layout zones with a rotating zone, the stable widget compatibility fixture, the Widgets V2 gate (`widget-component`), outside active hours, takeover and resume, plugin strip priority, identify, and projection rejection.

Run it locally:

```sh
npm run build --workspace @gibsonmb71/tilecast-player-linux
docker run --rm -v "$PWD:/src" -v "$RESULTS:/results" tilecast-edge-dev \
  /src/apps/edge/renderer-wpe/ci/run-conformance.sh
docker run --rm -v "$PWD:/src" -v "$RESULTS:/results" tilecast-conformance-electron \
  node /src/packages/player-runtime/conformance/run.mjs --engine electron --out /results
node packages/player-runtime/conformance/compare.mjs --a "$RESULTS/electron" --b "$RESULTS/wpe" --report "$RESULTS/report"
```

Android needs one attached device (or a running emulator, API 34+, UTC timezone, mdpi 1280x720 display for scale-1 screenshots). The wrapper never boots or manages the emulator itself:

```sh
node packages/player-runtime/conformance/run.mjs --engine android --out "$RESULTS"
node packages/player-runtime/conformance/compare.mjs --a "$RESULTS/electron" --b "$RESULTS/android" --report "$RESULTS/report-android"
```

Compare Chromium screenshots from Linux. On macOS, Electron captures the window in the display's colour space, so pixel results there are not meaningful.

### 8.1 Recorded results

On 2026-09-24, Linux Electron 39.8.5 (Chromium 142) and WPE WebKit 2.54.0 (GStreamer 1.28.7), headless on arm64:

- All 15 fixtures pass. Every checkpoint is semantically identical on both engines.
- Visual mismatch is 0.00 % for 21 of the 26 visual checkpoints. The others are the frozen alert ticker (1.08 %), the setup screen with its text field (0.66 %), and the pairing screen and two plugin checkpoints (at most 0.05 %).

Parity with the pre-migration Electron renderer (the global scripts this runtime replaced, built from the Edge foundation commit): the 11 fixtures that the old `window.tilecast` bridge can express show identical DOM state and identical evidence. Screenshots differ only where text is drawn, because the runtime bundles its own UI face where the old renderer used `system-ui`, and where the old renderer animates in real time. Media and Layout imagery match at 0.00 %.

## 9. Performance

`conformance/perf.mjs` runs the same real-time scenarios under the pre-migration renderer and under the runtime, on the same Electron build and machine. On 2026-09-24, Linux Electron 39.8.5, arm64 container, software GL, 90-second rotation:

| Measurement                                 | Before (legacy renderer) | After (Player Runtime)        |
| ------------------------------------------- | ------------------------ | ----------------------------- |
| Process start to first image evidence       | 170 ms                   | 171 ms                        |
| Presentation to image shown                 | 25 ms                    | 6 ms                          |
| Presentation to first video progress        | 284 ms                   | 50 ms (first presented frame) |
| Renderer CPU, one still image               | 0.1 %                    | 0.0 %                         |
| Renderer CPU, one looping video             | 0.7 %                    | 1.1 %                         |
| Renderer CPU, rotation                      | 0.5 %                    | 0.6 %                         |
| Renderer working set over the rotation      | 156 → 183 MB             | 158 → 169 MB                  |
| Media elements left after the rotation      | 0 videos, 1 image        | 0 videos, 1 image             |
| Synchronized boundary error (10 boundaries) | not measurable           | mean 6.0 ms, max 8.5 ms       |

The video start difference is partly a change in what is measured. The runtime reports the first presented frame, and the legacy renderer reported its first `timeupdate`. The boundary error includes the timeline's fixed 5 ms evaluation slack. Physical signage hardware, hardware decode and long soak runs are M11 qualification items. The WPE crash and restart recovery path is covered by `renderer-wpe/tests/e2e_headless.py`.

## 10. Build and test

```sh
npm run typecheck --workspace @tilecast/player-runtime
npm test --workspace @tilecast/player-runtime
npm run build --workspace @tilecast/player-runtime   # dist/runtime, dist/node, dist/conformance
```

`dist/runtime` is the artifact every host serves: `index.html`, `runtime.js` (one classic script with Lit and XState bundled), `runtime.css`, the logo, the font subsets and `runtime-manifest.json` (every file with its size and SHA-256). The Linux release check (`scripts/verify-linux-player-release.mjs`) and `apps/edge/renderer-wpe/assemble-runtime.sh` verify the packaged files against that manifest.

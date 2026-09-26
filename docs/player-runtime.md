# Tilecast Player Runtime

**Package:** `packages/player-runtime` (`@tilecast/player-runtime`)
**Hosts:** the Electron Linux player (`apps/player-linux`) and the WPE renderer (`apps/edge/renderer-wpe`)
**Host contract:** `TilecastRuntimeHostV1` (contract version 1)

The Player Runtime is the one trusted display document for Tilecast screens. Electron and WPE host the same built artifact from the same origin, `tilecast://runtime/index.html`, so a presentation looks and behaves the same whichever engine draws it.

```text
host process (Electron main + preload, or tilecastd + tilecast-renderer-wpe)
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
- browser-side playback evidence.

The runtime does not own server credentials, server reconciliation, Edge SQLite state, the Edge CAS, the Electron IPC implementation, WPE or GLib APIs, filesystem access, or the host's kiosk and process lifecycle.

## 2. Host contract

A host publishes one object, `globalThis.tilecastRuntimeHost`, that implements `TilecastRuntimeHostV1` (`src/host/contract.ts`). The contract has no generic message or native-invocation member. Every function is named and typed:

| Direction      | Members                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Host → runtime | `subscribe(listener)` delivers `presentation`, `plugins`, `identify`, `command`, `discovered-server` and `noise-level` messages.        |
| Runtime → host | `ready`, `presentationResult`, `reportEvidence`, `reportPlaybackError`.                                                                 |
| Optional       | `setup.submitServerUrl`, `discovery.list`, `noiseMeter.report` and `noiseMeter.diagnostic`, `remoteWeb.reportRecovered`, `conformance`. |

Behavior depends on `capabilities`, never on `info.host`:

| Capability             | Electron              | WPE (Edge)                     |
| ---------------------- | --------------------- | ------------------------------ |
| `remoteWeb`            | `electron-webview`    | `null` until M11 isolation     |
| `synchronizedPlayback` | `true`                | `true` (`tilecastd` anchors)   |
| `setup`                | `true`                | `true`                         |
| `discovery`            | `true`                | `true` (Avahi, `tilecastd`)    |
| `noiseMeter`           | `renderer-microphone` | `host-levels` (session bridge) |

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

The playback rules are the Electron player's, unchanged: `engine/playback-policy.ts` (playback authority, the completion arbiter, stale-callback identity, drift correction bands, the crossfade decision and outgoing-layer cleanup) moved into the runtime with its tests.

## 4. Synchronized playback

`engine/timeline.ts` drives a group's shared timeline. At activation it reads the wall clock once, corrected by the host's `clockOffsetMs`, to place the screen in the cycle. From then on the position comes from the monotonic clock, so an NTP step or a manual clock change never jumps what is on screen. At each boundary the timeline reports the outgoing item's transition and re-presents the playlist rotated to the expected item. The presentation machine has no local authority under a shared timeline. Four times a second the timeline publishes the expected position, and the visible video surface applies the existing drift-correction bands.

The timeline math (`clock/synchronized.ts`) is shared with the Electron main process, which builds the anchor from the active manifest (`apps/player-linux/src/main/runtime-messages.ts`). On Edge, `tilecastd` builds the same anchor and effective durations from the manifest (`manifest.rs`, `group_timing`) and sends them as `timing` with the activation. The anchor is fixed for that activation; the offset is the daemon's current one each time the timing is sent, so a restarted renderer rejoins with the best estimate. Neither host re-activates for a later offset sample.

## 5. Views, surfaces and transitions

- **Views** are Lit 3 components in light DOM (`src/views`): `<tc-player>`, `<tc-status-surface>`, `<tc-plugin-surfaces>` and `<tc-outside-hours>`. They render the engine's view state and decide nothing about playback. Style bindings use `cssProps` (CSSOM only), because Lit's `styleMap` writes a `style` attribute, which `style-src 'self'` refuses.
- **Surfaces** implement `MediaSurface` (`prepare`, `activate`, `pause`, `seek`, `dispose`): `ImageSurface`, `HtmlVideoSurface`, `WidgetSurface`, `LayoutSurface` and `WebviewWebsiteSurface`. The engine depends on the interface only, so a future surface (a host-owned web view in M11, or a native media pipeline if hardware testing ever justifies one) needs no change to the engine.
- **The stage** (`surfaces/stage.ts`) is the only code that creates or destroys media elements. The playback layers carry no Lit bindings, so no reactive update can replace an active `<video>`. An incoming occurrence is prepared on the hidden layer. The outgoing surface is paused and released when the transition finishes, so two full-screen decoders overlap for the transition and no longer.
- **Transitions** use the Web Animations API (`transitions/crossfade.ts`). A transition has one clock and one `finished` signal. A takeover or a newer swap cancels it, which puts both layers in their resting state at once.
- **Video evidence**: `HtmlVideoSurface` reports `video-progress` only while decoded frames are presented, when `requestVideoFrameCallback` is available and has fired. Otherwise it falls back to advancing media time. The API makes evidence stronger; playback never requires it.
- **Media progress is never rendered.** The Noise Meter marker moves at its sampling rate through a direct style write, outside Lit.

## 6. Compatibility code and the widget seam

The current widget system is preserved as compatibility code and labelled as such:

- `src/compat/projection`: the server-compiled Widget and Layout projection into the RenderNode tree. The Electron main process imports it through `@tilecast/player-runtime/projection`. The runtime runs it itself when a host sends references and a projection context (`compat/projector.ts`). The context may carry the accepted player configuration's `playback` section; the projector then applies its regional formatting and layout playlist-zone defaults exactly as the Electron main process does. The member is optional and additive, so `TilecastRuntimeHostV1` stays at contract version 1.
- `src/compat/render-tree-dom.ts`: the RenderNode interpreter.
- `src/compat/plugins`: the Countdown Bar, Emergency Alerts ticker, Noise Meter and Brand Bug resolvers, plus the overlay controller.

RenderNode is not the Player Runtime's permanent widget API. `src/widgets/contract.ts` defines the seam for first-class widgets. A first-class widget is a custom element, normally a Lit component, that receives typed `config`, `data` and `context` (a corrected clock, locale, time zone and size, and `playback` or `preview` mode). It renders with HTML, CSS, SVG or Canvas. It must stay engine-agnostic, so it runs unchanged under Electron, WPE and the Studio preview. The registry is empty in Edge 1: the widget redesign is not part of Edge 1.

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
- `compare.mjs` requires identical semantic state, evidence, errors and presentation results at every checkpoint. It compares screenshots perceptually, with a 1.5 % mismatch budget. Active video and remote web content are never pixel-compared. On a failure the report keeps both screenshots, the diff, the fixture and the engine versions.

The fixtures cover setup and discovery, pairing, idle, offline, disabled and safe-mode surfaces, image contain, cover and fill, playlist transitions, the video lifecycle, a synchronized join and boundary with a wall-clock step, Layout zones with a rotating zone, the stable widget compatibility fixture, outside active hours, takeover and resume, plugin strip priority, host-measured Noise Meter levels, identify, and projection rejection.

Run it locally:

```sh
npm run build --workspace @gibsonmb71/tilecast-player-linux
docker run --rm -v "$PWD:/src" -v "$RESULTS:/results" tilecast-edge-dev \
  /src/apps/edge/renderer-wpe/ci/run-conformance.sh
docker run --rm -v "$PWD:/src" -v "$RESULTS:/results" tilecast-conformance-electron \
  node /src/packages/player-runtime/conformance/run.mjs --engine electron --out /results
node packages/player-runtime/conformance/compare.mjs --a "$RESULTS/electron" --b "$RESULTS/wpe" --report "$RESULTS/report"
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

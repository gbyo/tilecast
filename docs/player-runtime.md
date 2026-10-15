# Tilecast Player Runtime

**Package:** `packages/player-runtime` (`@tilecast/player-runtime`)
**Hosts:** the WPE renderer (`apps/edge/renderer-wpe`), the WebView2 renderer host (`apps/player-windows`), the legacy Electron Linux player (`apps/player-linux`), and the Android trusted local WebView as Android convergence lands (`apps/player-android`)
**Host contract:** `TilecastRuntimeHostV1` (contract version 1)

The Player Runtime is the one trusted playback document and engine for Tilecast screens. WPE and WebView2 host the same built artifact from the same runtime sources, and Android's convergence loads that same runtime behind its trusted local WebView boundary, so presentation behavior does not acquire a host-specific Widget renderer. The Electron Linux player is legacy and migration-oriented: it keeps existing Linux screens running and remains the conformance reference engine, but new Linux investment goes to Tilecast Edge.

Studio is deliberately **not** another host of this complete runtime. Studio shares the **Widget renderer** only: the Widget runtime module plus `WidgetMount` from `@tilecast/widget-sdk`. Authoring preview provides its own preview `WidgetContext`, resources, locally edited configuration, and geometry; it does not run the XState playback engine, occurrence staging, evidence, synchronization, or playback host bridge.

```text
host process (tilecastd/WPE, Windows/WebView2, legacy Electron, or Android trusted WebView host)
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

| Direction      | Members                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Host → runtime | `subscribe(listener)` delivers `presentation`, `plugins`, `identify`, `command`, `discovered-server` and `remote-web` messages. |
| Runtime → host | `ready`, `presentationResult`, `reportEvidence`, `reportPlaybackError`.                                                         |
| Optional       | `setup.submitServerUrl`, `discovery.list`, `remoteWeb.reportRecovered`, `conformance`.                                          |

Behavior depends on `capabilities`, never on `info.host`:

| Capability             | Electron           | WPE (Edge)                   | WebView2 (Windows) |
| ---------------------- | ------------------ | ---------------------------- | ------------------ |
| `remoteWeb`            | `electron-webview` | `host-view`                  | `host-view`        |
| `synchronizedPlayback` | `true`             | `true` (`tilecastd` anchors) | `true`             |
| `setup`                | `true`             | `true`                       | `true`             |
| `discovery`            | `true`             | `true` (Avahi, `tilecastd`)  | `false`            |
| `outsideHoursLogo`     | absent (`cast`)    | `pulse`                      | absent (`cast`)    |

`pluginState` is optional. A host sets it when it forwards Plugin API v2 `plugin_state` entries in `plugins` messages, with grants for their declared media, and replays them to a reloaded document. Only then does the support report include `plugin.host@2` and the live Player service versions. The Edge WPE bridge, the Browser Player host, the Windows host script table, and the Android install script set it.

`variantMedia` is optional. A host sets it when it serves `tcmedia://variant/<asset>/<variant>` and authorizes each load against the current plugin state or activation grants. The Runtime then builds that address for `player.media@1`. A host that sends explicit `media` bindings, such as the Browser Player, leaves it unset. Edge, Windows, and Android set it.

`pluginEvents` is optional. A host sets it only when it sends `plugin-event` messages to the Runtime and provides `host.pluginEvents.emit`. Only then does the Runtime offer `player.events@1`. No host sets it yet. See [Plugin API v2](plugin-api-v2.md#plugin-events).

A presentation provider is a Runtime service, so it needs no host capability. The host still owns the container, visibility, evidence, and recovery of its session. See [Plugin API v2](plugin-api-v2.md#presentation-providers).

`outsideHoursLogo` is optional. It selects the animated logo for the "Bouncing logo" display outside active hours: `cast` or `pulse`. If a host does not set it, or sets a value that the runtime does not know, the runtime shows `cast`. The runtime ships both logo files.

`info` (host name and version, engine name and version) is for diagnostics only.

`RuntimeReadyV1` has optional `support` metadata with separate
`presentationSchemas`, `declarativeCapabilities`, and `widgetComponents` fields.
Each namespace has at most 256 entries. Versions are positive uint32 values;
capability names are contract tokens of at most 64 ASCII characters.
The Runtime uses its generated schema and declarative constants and its live
Widget discovery registry. Remote web support requires the running host port.
WPE validates and forwards this report in `renderer.ready.support` with its live
host features. Edge checks this connected profile independently of the generated
installed-release profile. Missing support is empty. Contract version 1 and the
existing readiness messages without this optional member remain valid.

The runtime validates the host object at start (`hostContractProblem`). A missing bridge or a different contract version shows the "Display bridge unavailable" surface instead of a black screen.

Everything that crosses the contract is data. The runtime receives no credential, no path, no server response and no executable. Media is addressed only by URIs the host already authorized (`tcmedia:`).

The `conformance` member exists only for the conformance suite (§8). It switches the runtime to a manual clock and instant transitions. No production host sets it.

### 2.1 Remote web (`host-view`)

When `capabilities.remoteWeb` is `host-view`, the host shows remote pages and YouTube players in its own views outside the runtime document. The runtime drives those views through `host.remoteWeb` (`src/remote-web/port.ts`):

- `create(spec)` is the only call with an answer. The answer is `{ok: true, target: "host-layer"}` or `{ok: false, code}`.
- `updateViewport`, `setVisible`, `setMuted`, `reload` and `destroy` are one-way notifications.
- `reportRecovered` tells the host that the runtime proved content after the host's remote process ended.

The host reports surface events as `remote-web` messages: `stream-ready`, `loaded`, `navigation-blocked`, `failed`, `media-ended`, and the host-wide `process-terminated` and `recovered`. Events for unknown surfaces are dropped on both sides.

The runtime owns the load timers and the reload policy. The host owns the allowlist, the failure codes, and the browsing data. The host never navigates a main frame outside the approved hosts. When the remote process is not ready, the host must answer `{ok: false}`. The host must not queue the create.

## 3. Playback engine

The playback lifecycle is explicit XState 5 state machines (`src/engine`). They never touch the DOM.

- **Player** (`player-machine.ts`): which surface owns the screen (`status`, `sleep`, `playing`). Every host presentation re-enters `playing`, which stops the invoked presentation actor and starts a new one. This is how a takeover, a manifest change or a re-projection interrupts playback. A synchronized occurrence boundary is not a host presentation. It reaches the running actor as `OCCURRENCE` (section 4.1).
- **Presentation** (`presentation-machine.ts`): one actor per host presentation. The occurrence states are `routing` (mount), `preparing` (staged on the hidden layer), `showing`, `advancing` (the one-task hand-off), `failed` (isolation and back-off) and `skipping` (empty widgets). One completion arbiter per occurrence decides between restart in place, advance and ignore.
- **Zone** (`zone-machine.ts`): one actor per Layout playlist zone, stopped with its Layout. Selection increments the epoch. Only `MEDIA_READY` for that epoch starts the image or Widget duration and reports child readiness. Pause preserves the remaining duration. Stale media events cannot affect a newer epoch.

The machines do not use XState `after` delays or browser timers. `src/clock/scheduler.ts` is the only user of browser timers. The machines ask it for monotonic deadlines and receive typed events (`DURATION_DUE`, `ADVANCE_DUE`, `BACKOFF_DUE`). Deadlines are owned by a timer group per occurrence. Mounting the next occurrence cancels the group, so nothing scheduled for a replaced item can act on its successor.

### 3.1 Durations and the dwell floor

A duration is a positive number of milliseconds or it is absent. `clock/duration.ts` is the only place that decides which, and every timer in the runtime reads durations through it. Zero, a negative number, `NaN`, and a missing value all mean "no duration". An image with no duration runs for `IMAGE_DEFAULT_MS`. A website runs for `WEBSITE_DEFAULT_MS`. A widget or layout with no duration stays until something replaces it.

No duration timer completes an occurrence before `MIN_ITEM_DWELL_MS` (1000 ms) has passed since it mounted. A timer that fires earlier, from a one-millisecond duration, is delivered again when the floor passes. It is not dropped, so exactly one completion path still wins the occurrence. A Layout playlist zone reads a zero image duration as unset, and the synchronized timeline applies the floor to every slot.

Before this floor, a host that sent a synchronized slot of zero or one millisecond put the screen on a cycle that rolled over every millisecond. The runtime tore down and remounted the item as fast as the renderer could paint. Each remount was recorded as a separate one-millisecond play. Studio does not accept an item duration under one second, so the floor removes only values that are already faults.

The playback rules are the Electron player's, unchanged: `engine/playback-policy.ts` (playback authority, the completion arbiter, stale-callback identity, drift correction bands, the crossfade decision and outgoing-layer cleanup) moved into the runtime with its tests.

## 4. Synchronized playback

`engine/timeline.ts` drives a group's shared timeline. At activation it reads the wall clock once, corrected by the host's `clockOffsetMs`, to place the screen in the cycle. From then on the position comes from the monotonic clock, so an NTP step or a manual clock change never jumps what is on screen. At each boundary the timeline reports the outgoing item's transition and hands over the playlist rotated to the expected item. The presentation machine has no local authority under a shared timeline. Four times a second the timeline publishes the expected position, and the visible video surface corrects its drift (section 4.2). The timeline publishes the position of a new occurrence after it mounts that occurrence. A correction for the new occurrence cannot reach the video that the previous occurrence left on screen.

The timeline math (`clock/synchronized.ts`) is shared with the Electron main process, which builds the anchor from the active manifest (`apps/player-linux/src/main/runtime-messages.ts`). On Edge, `tilecastd` builds the same anchor and effective durations from the manifest (`manifest.rs`, `group_timing`) and sends them as `timing` with the activation. The anchor is fixed for that activation; the offset is the daemon's current one each time the timing is sent, so a restarted renderer rejoins with the best estimate. Neither host re-activates for a later offset sample.

### 4.1 Shared occurrence boundaries

The timeline marks each hand-over as one of two kinds:

- `activation`: a new presentation. It replaces the running presentation. The first hand-over after `activate()` is always an activation, and so is every projection refresh and manifest change.
- `boundary`: the same presentation reached its next shared occurrence.

A boundary does not replace the presentation actor. The controller sends `OCCURRENCE` to the player machine. The player machine checks that the generation is newer, stores the rotated presentation, and forwards the event. The presentation machine accepts it only under shared authority, only for a newer generation, and only with items. It then mounts the first item of the rotated list. The occurrence starts with the state that a new actor has: index 0, no failures, and a new completion arbiter. The mount numbering continues.

The evidence order does not change. The timeline reports `item-transition` for the outgoing item. The machine reports `item-started` when the new occurrence mounts. A single-item loop therefore still ends each lap with an `item-transition` and starts the next with an `item-started`. Local completion stays suppressed. A `RETRY` command still mounts the occurrence again from the start. A host `PRESENT` still replaces the actor.

Before this change a single video that looped on a Mirror screen replaced the actor, took a new mount and created and released a decoder on every lap. Five laps took 6 actors, 6 mounts and 6 `HTMLVideoElement` instances. They now take 1 actor, 6 mounts and 1 element.

#### Video surface reuse

A stage entry that is a shared boundary carries `sharedBoundary`. The stage then asks `videoReuseVerdict` (`engine/playback-policy.ts`) whether the video on screen can carry the new occurrence. This is the only place that decides. The item id alone never decides. The surface can be reused only if all of these are true:

- The boundary is a shared boundary, and the incoming item is a video.
- The surface is on the visible layer, is not disposed, has not failed, has shown a first frame, and has `readyState` of `HAVE_CURRENT_DATA` or more.
- The item id, `src`, fit mode, audio setting, volume and end offset are the same.
- The start offset of the new occurrence is not negative and is before the end offset.

If the verdict is yes, the stage calls `HtmlVideoSurface.rebind()`. The element and its decoder stay. These things move to the new occurrence: the item, the sink and mount that route its reports, the offsets, the evidence counters and the drift corrector. The element seeks to the start of the occurrence. The aim is later by the last measured seek latency. The occurrence becomes ready when the seek is complete and a frame is available.

Events for the previous occurrence can still arrive. Until the seek is complete, the surface ignores `ended`, `timeupdate` and presented frames. Report routing uses the new sink, so no report reaches the old mount. If the seek does not complete in `VIDEO_REBIND_TIMEOUT_MS` (5 s), or `play()` is refused, the occurrence fails. The surface is then not reused again, and the next boundary creates a new decoder.

If the verdict is no, the stage creates a new surface on the hidden layer. This is the path for all other cases. A different item or file is the ordinary case. Any other reason is an unexpected remount, and the diagnostics count it with the reason.

The runtime does not set `loop` on the element, and it does not remove crossfades between different items.

### Layout playlist item contract

`RuntimeLayoutZonePlaylistItem` is a discriminated union. Image and video
entries retain their existing fields. A `widget` entry carries the same
prepared compatibility tree or component payload as a fullscreen Widget.
A `remote-web` entry carries the same remote web descriptor as a direct
Widget placement. Nested Layout entries are unsupported.

The Runtime reports `layout.playlist_widgets@1`. The legacy capability profile
does not report this capability. Server eligibility must require it before
it sends a mixed zone to a Player. Runtime support alone does not enable
mixed Playlist authoring.

Direct placements and timed Widgets use one projection helper. Component
Data Documents, media grants, regional values, and sandbox execution grants
keep the fullscreen contract. The zone actor owns progression. Component
ready or expected-empty state permits activation. Compatibility Widgets
report readiness after their first visible frame. Empty state never advances
the containing Layout. A complete cycle of failed items waits two seconds
before retry. Disposal cancels the zone actor and releases all
owned surfaces. YouTube surfaces are released before the next zone occurrence;
they do not overlap in transitions or remain as a previous-item fallback.

### 4.2 Drift correction

`engine/video-sync.ts` decides how a video returns to the shared position. The thresholds are the existing ones: ignore below 80 ms, nudge the playback rate between 80 ms and 250 ms, seek above 250 ms. The corrector adds the rules that make a correction safe to repeat:

- A seek is a state. The corrector measures nothing until the element has finished seeking and its media time has advanced on two evaluations, at least 500 ms after `seeked`.
- A `currentTime` that has not changed is stale. The corrector does not read it as drift. After 3 s it is a stall. A presented frame no older than 400 ms stands in for a stale `currentTime`. A frame callback is never required.
- A `currentTime` that changes in coarse steps is corrected by half a step, and half a step is not read as drift.
- A correction needs two readings that agree on the direction. The smaller of the two is the drift.
- The rate nudge starts above 80 ms and ends below 40 ms. It changes at most once a second. A rate change can flush a GStreamer pipeline, so a reading that is near an edge must not change it on every evaluation.
- A seek is not repeated for 1 s after the previous one settled. The wait doubles for each seek that does not converge, up to 8 s, and a spell of 3 s inside the seek band clears it.
- A seek aims ahead of the shared position by the seek latency that the corrector measured, up to 2 s. The estimate is the last time the media was known not to have moved, so the aim cannot be too far ahead.

The thresholds are not relaxed. The simulation in `engine/test-support/sim-video.ts` models three behaviors reported from GStreamer pipelines: slow seeks, a frozen `currentTime` after a seek, and a coarse `currentTime`. It is a model, not hardware. For one minute of playback, it gives these results:

| Modeled pipeline                       | Previous corrector               | Settle-aware corrector  |
| -------------------------------------- | -------------------------------- | ----------------------- |
| Seek 800 ms, resume 700 ms, 5 s behind | 60 seeks, picture frozen 59.75 s | 2 seeks, frozen 3 s     |
| In sync, `currentTime` in 400 ms steps | 30 seeks, 180 rate changes       | 0 seeks, 2 rate changes |
| Decoder at 0.85 of real time           | 59 seeks, frozen 35 s            | 9 seeks, frozen 5.4 s   |

In the third case the video is far from the shared position for more of the minute (46.9 s, against 43.6 s). The decoder cannot keep up. The corrector trades a small amount of precision for much less freezing.

### 4.3 Diagnostics

`engine/diagnostics.ts` keeps fixed-size counters, a ring of the last 32 notes, drift totals and rate-limited log lines. Nothing grows with uptime and nothing runs for each frame. The counters are `presentation-actors`, `occurrence-boundaries`, `decoders-created`, `decoders-reused`, `unexpected-remounts`, `seeks-correction`, `seeks-occurrence`, `seeks-settled`, `seek-timeouts`, `settle-timeouts`, `rate-changes`, `stale-readings`, `stalls` and `reuse-failures`. The snapshot also holds the reasons for rejected reuse and the drift totals (samples, maximum, and counts above 80 ms and 250 ms).

A log line has a limit of one for each kind in 5 s and 12 in a minute in total. A conformance run logs nothing. Read the snapshot with `__tilecastRuntime.diagnostics()`. `describe()` does not include it, because the conformance suite compares `describe()` between engines.

### 4.4 Hardware qualification

The tests prove the counts of actors, mounts and decoders, the evidence order, the seek and rebind behavior, and the corrector against a model. They do not prove smooth playback. A headless WPE run does not decode video to a display. Before a release that relies on this change, run a Mirror group with a single looping video on an older Linux PC and read `diagnostics()` after several minutes. `decoders-created` must stay at 1 for each presentation, and `unexpected-remounts` must stay at 0. A rise in `seeks-correction` or `stalls` shows a pipeline that cannot hold the shared position.

## 5. Views, surfaces and transitions

- **Views** are Lit 3 components in light DOM (`src/views`): `<tc-player>`, `<tc-status-surface>` and `<tc-outside-hours>`. They render the engine's view state and decide nothing about playback. Style bindings use `cssProps` (CSSOM only), because Lit's `styleMap` writes a `style` attribute, which `style-src 'self'` refuses.
- **Surfaces** implement `MediaSurface` (`prepare`, `activate`, `pause`, `seek`, `dispose`): `ImageSurface`, `HtmlVideoSurface`, `WidgetSurface`, `LayoutSurface`, the legacy Electron `WebviewWebsiteSurface`, and `HostRemoteWebSurface` for host-owned remote web. Edge supplies that host view through the isolated WPE helper. The engine depends on the interface only, so another native media pipeline, if hardware testing ever justifies one, needs no change to the engine.
- **The stage** (`surfaces/stage.ts`) owns fullscreen media surfaces. Layout playlist zones own nested instances of the same media, Widget, and host-isolated remote web surfaces. The playback layers carry no Lit bindings, so no reactive update can replace an active `<video>`. An incoming occurrence is prepared on the hidden layer. The outgoing surface is paused and released when the transition finishes, so two full-screen decoders overlap for the transition and no longer.
- **Transitions** use the Web Animations API (`transitions/crossfade.ts`). A transition has one clock and one `finished` signal. Only the incoming layer fades. It paints above the outgoing layer, which stays fully opaque until the transition ends. Each layer has a black backdrop, so fading both layers makes the picture go dark in the middle of the transition. A takeover, a newer swap, or the staging of the next occurrence cancels the transition, which puts both layers in their resting state at once.
- **Video first frame**: the stage starts a video muted on the hidden layer and treats it as ready only after a decoded frame has been presented, or after 1.5 seconds. A paused video presents nothing, and on some engines the first frame trails `play()` by longer than the 300 ms dissolve, so the layer would fade in empty and the picture would then pop in. The item's audio setting applies when the video is on screen. Layout zones do not use this wait.
- **Video evidence**: `HtmlVideoSurface` reports `video-progress` only while decoded frames are presented, when `requestVideoFrameCallback` is available and has fired. Otherwise it falls back to advancing media time. The API makes evidence stronger; playback never requires it.
- **Layout child readiness**: `layout-shown` reports the visible canvas. A playlist zone prepares media while hidden. Images become ready after successful load. Videos become ready at `canplay`. The zone activates media only when the parent Layout is active. It reports `layout-zone-rendered` after successful activation. Selection, append, and transition start do not prove child readiness. A fade or crossfade keeps outgoing good media until incoming media is ready. Video progress carries the zone ID. Load and play failures report a zone error, apply the configured fallback, and advance or retry the zone. Static image load failures also report a zone error. Other zones continue to play.
- **Zone video loops**: the zone applies the native loop policy after playback starts. It disables native looping before each play attempt. This sequence prevents a WebKit stall when a prepared, paused video starts with native looping enabled. Trimmed videos still use zone advances to restore their authored start offset.
- **Player plugins** (Plugin API v2) come from the Player Plugin Host (`src/plugins/player-host.ts`). It activates a plugin while `plugin_state` for it exists, routes each plugin only its own state, and binds the services the plugin requests from the service registry (`src/plugins/services.ts`, `src/plugins/service-providers.ts`): `player.clock@1`, `player.media@1`, `player.presentation.observe@1`, and `player.surface@1`. It has no evaluation loop. A plugin that throws is disposed alone. The host reads only `plugins` messages and a read-only presentation observation, so plugin state never reaches playback. [plugin-api-v2.md](plugin-api-v2.md) is the contract.
- **Plugin surfaces** come from the runtime surface host (`src/plugins`). It also implements `player.surface@1`: a v2 visual contribution joins the same arbitration with its own declared tier and pushes its claims. The host finds each runtime plugin when the runtime is built, gives it one container for each surface that it declares, arbitrates each slot by the declared tier and the claimed priority, and sets the content-stage insets and the corner lift. A plugin draws only inside its containers. [plugin-api.md](plugin-api.md#player-runtime) is the contract.

### 5.1 Layout promotion follow-up

Player Core currently accepts both `LayoutShown` and `LayoutZoneRendered` as
content evidence for `Expectation::Layout`. The tests in
`crates/player-core/src/supervisor.rs` preserve this rule. A background-only
Layout needs canvas evidence for promotion. The current expectation does not
identify Layouts that require child evidence. Thus canvas evidence can still
promote a Layout whose children all fail. A follow-up must supply explicit
child expectations to Core and test failed-child and background-only promotion.
This Runtime correction preserves the existing Core promotion rule.

## 6. Compatibility code and the widget seam

The current widget system is preserved as compatibility code and labelled as such:

- `src/compat/projection`: the server-compiled Widget and Layout projection into the RenderNode tree. The Electron main process imports it through `@tilecast/player-runtime/projection`. The runtime runs it itself when a host sends references and a projection context (`compat/projector.ts`). The context may carry the accepted player configuration's `playback` section; the projector then applies its regional formatting and layout playlist-zone defaults exactly as the Electron main process does. The member is optional and additive, so `TilecastRuntimeHostV1` stays at contract version 1.
- `src/compat/render-tree-dom.ts`: the RenderNode interpreter.

RenderNode is not the Player Runtime's permanent widget API. Widgets V2 ([widgets-v2.md](widgets-v2.md)) replace it for migrated Widgets:

- A Widgets V2 Widget is one custom element (Lit 3) in `widgets/<name>/runtime/`. The runtime finds every Widget module when it is built (`src/widgets/host.ts`, `import.meta.glob`). There is no Widget switch in the runtime.
- A manifest v16 or v17 `kind: "component"` presentation projects to a `RuntimeWidgetComponentPayload` (`src/widgets/projection.ts`): the component reference, the Data Documents and media variants it declares, the empty policy, and the regional formatting. The payload has no time-dependent value, so re-projection does not restart the Widget.
- `ComponentWidgetSurface` mounts a fullscreen Widget, and `LayoutSurface` mounts a Widget in a zone, through the same `WidgetMount` from `@tilecast/widget-sdk`. A local fullscreen component with the `skip-eligible` policy advances when its mount reports `empty`; synchronized playback and Layout zones keep their presentation. The runtime, not the Widget, reports `widget-shown`, `widget-alive` and `layout-zone-rendered`.
- `LayoutSurface` reports one declaration for each zone it mounts when it becomes visible: `layout-zone-declared` for a zone that owes one first `layout-zone-rendered`, and `layout-zone-rotating` for a looping image zone that also owes continuing ones (`zoneOwesContinuingEvidence`). A declaration is not progress. The host uses declarations to judge a Layout zone by zone; see [Playback health](player-core.md#playback-health).
- A Widget keeps time with the corrected clock: the local wall clock plus the host's latest `clockOffsetMs` (from `plugins`, `projection` or `timing`), scheduled on the runtime scheduler. A conformance run's manual clock drives Widgets like everything else.
- The runtime refuses to mount a Widget when the engine cannot adopt constructed stylesheets (`widget_styles_unsupported`). The CSP refuses the `<style>` fallback, so the Widget would otherwise render unstyled.
- `src/widgets/capabilities.gen.ts` (generated by `npm run widgets:generate`) lists `widget.<type>` for each bundled Widget. The Electron main process and Edge daemon report it in the heartbeat with presentation schemas 1, 2 and 3. Android continues to report schemas 1 and 2. A test proves that the list equals what discovery finds.

## 7. Security and appearance

- The document's CSP is `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' tcmedia: data:; media-src tcmedia: tcweb:; frame-src https: http: tcwidget:`. It has no `unsafe-inline` and no CSP bypass privileges. The `tcwidget:` frame source covers daemon-granted sandbox frames on native hosts; the iframe sandbox attribute and the frame's own policy still confine them.
- `tilecast://runtime/` serves only files listed in the artifact's `runtime-manifest.json` (Electron) or allowed by `tc_runtime_path_is_allowed` (WPE). The names are top-level files and `fonts/<name>`, and anything a URL parser would rewrite is refused.
- The Electron renderer runs with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`. The preload is a thin adapter that requires only `electron`. The synchronized-timeline enrichment that forced `sandbox: false` moved to the main process.
- Tilecast-owned surfaces use the bundled Tilecast UI face (Geist, SIL Open Font License 1.1, `static/fonts/OFL.txt`) rather than the distribution's `system-ui`. The display ignores host dark-mode and forced-colour preferences.

## 8. Conformance suite

`packages/player-runtime/conformance` runs one fixture host and a set of deterministic fixtures under every engine:

- `conformance/host/conformance-host.ts` is a `TilecastRuntimeHostV1` that plays a fixture script (host messages, clock steps, evidence waits, checkpoints) into the runtime on a manual clock with instant transitions.
- The Electron runner (`apps/player-linux/conformance/runner.cjs`) loads the runtime through the player's own `tilecast://runtime/` protocol module.
- The WPE runner (`apps/edge/renderer-wpe/tests/conformance.c`) loads it through the renderer's own path validation and `tcmediasrc` media source on WPEPlatform headless.
- The Android runner (`apps/player-android/app/src/androidTest/.../PlayerRuntimeConformanceTest.kt`, driven by `apps/player-android/conformance/run-android.sh`) loads the exact packaged runtime asset through the same app-owned origin production uses, injects the same fixture host, serves `tcmedia:` bytes from the pushed fixture store, and captures per-checkpoint screenshots with UiAutomation. Its `@JavascriptInterface` bridge is test-only surface that never ships. Remote web fixtures run with the default null `remoteWeb` capability, exactly as on WPE: host-owned Android WebViews get Android-specific host tests instead of pixel comparison.
- The WebView2 runner (`apps/player-windows/src/bin/tilecast-runtime-conformance.rs`) loads the exact production runtime artifact through the player's own `tilecast://runtime/` origin and scheme handlers. It imports fixture media through the verified CAS commit path, mints the same generation-scoped `tcmedia://cap/` grants production sends, and serves them with the same range semantics. It injects the same fixture host instead of the product bridge and captures per-checkpoint PNG screenshots. Its harness message channel is test-only surface that never ships. It runs only on Windows with the WebView2 Runtime installed, at 100% display scaling. Remote web fixtures run with the default null `remoteWeb` capability, exactly as on WPE and Android: host-layer WebView2 views get Windows host qualification instead of pixel comparison (see `tilecast-windows-qualification.md`).
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

WebView2 runs on a Windows host with the Evergreen runtime installed:

```sh
cargo build -p tilecast-windows --bin tilecast-runtime-conformance
node packages/player-runtime/conformance/run.mjs --engine webview2 --out "$RESULTS" --windows-runner target/debug/tilecast-runtime-conformance.exe
node packages/player-runtime/conformance/compare.mjs --a "$RESULTS/electron" --b "$RESULTS/webview2" --report "$RESULTS/report-webview2"
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

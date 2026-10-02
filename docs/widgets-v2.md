# Widgets V2

**Status:** binding. PR 1 (foundation and the Clock vertical slice) implements this document. Later PRs extend it; they do not change the contracts in §3–§7 without a new version.

**Packages:** `@tilecast/widget-sdk` (`packages/widget-sdk`), `@tilecast/widget-kit` (`packages/widget-kit`), and one module for each Widget below `widgets/`.

A Widgets V2 Widget is a first-class presentation component. One Web Component, normally a Lit 3 element, is the only renderer of that Widget. The same element runs in Tilecast Studio preview and inside the shared Player Runtime hosted by Electron/Chromium, Tilecast Edge (WPE WebKit), and the converging Android trusted local WebView.

If Weather looks wrong, there is one Weather renderer to fix.

### Shared renderer terminology

**Shared Widget renderer** means the Widget runtime module (the real Web Component) plus `WidgetMount` from `@tilecast/widget-sdk`. Studio, Storybook/fixtures, and the Player Runtime all use that boundary.

**Shared Player Runtime** means the complete trusted playback document and engine in `@tilecast/player-runtime`: presentation lifecycle, occurrence staging, transitions, evidence, host capabilities and bridges, synchronized playback, remote-web surfaces, and playback failure policy. Electron, Edge/WPE, and Android host that runtime.

Studio intentionally does **not** instantiate the complete Player Runtime for ordinary Widget authoring preview. It supplies preview-specific `WidgetContext`, `WidgetResources`, locally edited configuration, and intrinsic preview geometry directly to `WidgetMount`.

The architectural invariant is: **one Widget component renders fullscreen, Layout zones, Studio, and Storybook.**

## 1. Architecture checkpoint (2026-09-26)

| Item                     | Decision                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base                     | `main` at `c683ce28` (Plugin API v1 follow-up #703, merged after the #686–#701 stack).                                                                                               |
| #699 (Edge M11)          | Merged. It adds Edge remote-web isolation and the shared Player Runtime host-view path, plus the YouTube Layout rule. It does not change the manifest schema or content definitions. |
| Next manifest schema     | v16. v11–v15 do not change.                                                                                                                                                          |
| Presentation schema      | Component presentations use presentation schema 2. Native and web presentations stay at 1.                                                                                           |
| Capability advertisement | `presentationSchemaVersions` includes `2`, and `nativePresentationCapabilities` contains `widget.<component type>` = component version.                                              |
| Legacy fallback          | Manifest compilation for each screen. A Player that reports the exact component capability gets the component. Every other Player gets the existing presentation.                    |
| Studio host              | A generic React 19 host mounts the real custom element through the shared `WidgetMount` (PR 2).                                                                                      |
| CSP                      | The runtime CSP does not change. The conformance suite proves Shadow DOM and adopted stylesheets under it on Electron and WPE (§9).                                                  |

### 1.1 CSP and Shadow DOM result

The `widget-component` conformance fixture ran on Electron 39 (Chromium 142) and WPE WebKit 2.54 on 2026-09-26, with the unmodified runtime CSP. On both engines:

- every Widget element has a shadow root, and its styles arrive only through `adoptedStyleSheets` (no `<style>` element);
- container units resolve against the Widget's own box, and the container queries for a landscape zone, a tall sidebar and a wide strip apply;
- no CSP violation is reported, and an injected inline `<style>` is refused and reported, so the policy is still enforced;
- the checkpoints are semantically identical, and the screenshots differ by 0.07 % (fullscreen) and 0.26 % (Layout).

No nonce and no `unsafe-inline` is necessary. The Android WebView baseline is recorded when the Android convergence runs the same fixture (§12).

## 2. Ownership

A **Data Source** owns acquisition, parsing, sanitization, refresh, caching, typed Data Documents, attribution, date-selection policy and diagnostics. Nothing in this document changes that.

A **Widget** owns visual meaning, field selection, semantic display choices, the visual variant, formatting, the empty presentation and time-aware presentation logic.

The **Player Runtime** owns mounting, lifecycle, playback evidence, Layout-zone evidence, transitions and the host contract.

A Widget must not:

- fetch data, open sockets, or address a URL that is not a verified media resource from its resources;
- read browser storage, cookies or IndexedDB;
- receive a credential, the host object (`tilecastRuntimeHost`) or a host name;
- keep time with anything other than `context.clock`;
- report evidence, Activity, health, proof of play or Layout-zone state;
- use `innerHTML`, `unsafeHTML`, `unsafeCSS` with input, `eval` or dynamic script.

## 3. Repository layout

```text
packages/widget-sdk/          @tilecast/widget-sdk: contract, manifest schema, mount, testing
  src/definition.ts           defineWidget(), WidgetDefinition
  src/context.ts              WidgetContext, WidgetClock, WidgetTheme
  src/resources.ts            WidgetResources, WidgetResolution
  src/events.ts               lifecycle events
  src/manifest.ts             tilecast.widget.json schema (zod)
  src/discovery.ts            pairs manifests with runtime modules, with diagnostics
  src/mount.ts                WidgetMount: the one mount used by every host
  src/testing.ts              manual clock, fixture resources, mount helpers
  src/fixtures.ts             renders a fixture exactly as a host does
  src/stories.ts              Storybook stories built on src/fixtures.ts
  test/widgets/               the catalog suite that npm run widgets:check runs
  tools/widgetctl/            npm run widgets:check | widgets:generate | widgets:new
packages/widget-kit/          @tilecast/widget-kit: signage visual system (Lit 3)
widgets/                      one directory for each V2 Widget; also a Go module that embeds the manifests
  catalog.go                  go:embed */tilecast.widget.json
  clock/
    tilecast.widget.json      catalog, authoring, component and compatibility metadata
    runtime/index.ts          default-exports defineWidget(...)
    runtime/clock.ts          the element
    runtime/clock.test.ts
    runtime/clock.stories.ts
    fixtures/*.json
  visual/                     Playwright visual regression over every story
  .storybook/                 local Storybook (Web Components + Vite)
```

`tilecast.widget.json` is the single catalog source for a V2 Widget. The Server reads it through the `widgets` Go module. The Player Runtime and Studio discover it with `import.meta.glob`. No second registry lists V2 Widgets.

The top-level `configVersion` field identifies the saved Widget configuration schema. It is separate from the definition `version` and `component.version`. The Server stores it when it creates or updates a Widget. If a legacy definition omits `configVersion`, the Server stores version 1.

## 4. The Widget definition

```ts
export interface WidgetDefinition<Config, Data> {
  /** Qualified component type, for example "tilecast.clock". */
  readonly type: string;
  /** Component version. A change that old inputs cannot satisfy increments it. */
  readonly version: number;
  /** Custom element tag, `tc-widget-<name>` for Tilecast Widgets. */
  readonly tagName: string;
  /**
   * Validate untrusted configuration. Never throws. `version` is the
   * component version the Server compiled for; a definition at version N
   * accepts every version from 1 to N.
   */
  parseConfig(value: unknown, version: number): ConfigResult<Config>;
  /** Read prepared resources only. Pure and synchronous. */
  resolveData(
    config: Config,
    resources: WidgetResources,
  ): WidgetResolution<Data>;
  /** The element class. The mount defines it under `tagName`. */
  readonly element: WidgetElementConstructor<Config, Data>;
}

type ConfigResult<Config> =
  { ok: true; config: Config } | { ok: false; problem: string };

type WidgetResolution<Data> =
  | { state: "ready"; data: Data }
  | { state: "empty"; reason: string }
  | { state: "error"; code: string };
```

`defineWidget()` copies and freezes the definition. It does not throw and does not register anything globally, because a throw while the runtime bundle loads would stop the display. Discovery validates each definition with `definitionProblem()` and leaves out a Widget that fails, with a diagnostic; the host tests fail on any diagnostic.

The element receives four typed properties: `config`, `data` (null unless the resolution is ready), `empty` (the empty reason, or null) and `context`. The mount assigns them as object properties, never as attributes.

A Player reports the newest component version it renders. The registry therefore gives version N of a definition to any presentation compiled for a version from 1 to N.

## 5. Context and resources

```ts
interface WidgetContext {
  readonly clock: WidgetClock;
  readonly locale: string; // BCP 47
  readonly timeZone: string; // IANA
  readonly hourCycle: "locale" | "h12" | "h23"; // organization time format
  readonly theme: WidgetTheme;
  readonly motion: { readonly reduced: boolean };
  readonly mode: "playback" | "preview";
}

interface WidgetClock {
  now(): number; // corrected Unix ms
  monotonicNow(): number;
  after(delayMs: number, run: () => void): { cancel(): void };
}

interface WidgetResources {
  dataDocument(dataSourceId: string): WidgetDataDocument | null;
  dataset(dataSourceId: string, datasetId: string): WidgetDataset | null;
  media(assetId: string, variantId: string): string | null; // host-authorized URI
  attribution(dataSourceId: string): string | null;
}
```

The context has no size. The element measures its own box with CSS container queries (§9). A size change never rerenders a Widget that does not measure.

Time-sensitive Widgets use the `ClockController` from `@tilecast/widget-kit`. It schedules against `context.clock`, can wake once at a declared future boundary, then returns to its normal second or minute cadence. A Widget must not create its own timer or read wall-clock time.

`WidgetResources` answers only for Data Sources and media variants that the component presentation declares (§6). Every other lookup returns `null`. The resources object has no network, file, storage or host access.

Before the SDK returns a prepared Data Document to a Widget, it freezes the document and its nested values. A Widget must create its own objects when it needs to transform data. This keeps one Widget from changing data that another reader shares. The SDK skips objects that it already froze, so repeated lookups do not traverse the same resource graph again.

## 6. Manifest v16 component presentation

```json
{
  "schemaVersion": 2,
  "kind": "component",
  "requiredCapabilities": { "widget.tilecast.clock": 1 },
  "component": {
    "type": "tilecast.clock",
    "version": 1,
    "config": {
      "timeZone": "",
      "format": "locale",
      "showSeconds": false,
      "style": "standard",
      "showDate": false,
      "background": "#0E141B",
      "foreground": "#F5F7FA"
    },
    "dataSources": [],
    "media": []
  }
}
```

- `config` is a bounded JSON object: at most 8 KiB encoded, depth 6, 64 keys for each object, 200 items for each array and 2,000 characters for each string.
- `dataSources` lists the Data Source IDs the component may read. Their Data Documents stay in the manifest's `dataSources[]`. The presentation never copies a document.
- `media` lists the `{assetId, variantId}` pairs the component may display. Each pair is also in the manifest's `assets[]`, so the Player verifies and caches it before activation.

During manifest projection, the Server resolves every selected `media_asset` field in the Widget schema. The Server writes the selected variant beside the asset field. If the field key ends in `AssetId`, the Server replaces that suffix with `VariantId`; otherwise, the Server appends `VariantId`. A field named `logoAssetId` therefore receives `logoVariantId`, and a field named `brandMark` receives `brandMarkVariantId`. For fields inside a `repeating_group`, the Server writes the variant key into the matching item. The component media grant contains each resolved asset and variant pair. An empty optional field adds no variant key or grant. Clients cannot submit derived variant keys.

The Server compiles `config` from the persisted Widget configuration with the component's `configTemplate` in `tilecast.widget.json`. A template value is plain JSON or `{"$config": key, "default": value, "when": flag}`. No other directive exists. A `when` flag names a persisted key. A falsy flag value resolves the default instead of the mapped value. A missing flag resolves the mapped value. The Go compiler (`contentdefs.CompileComponentConfig`) and the TypeScript compiler (`compileComponentConfig`) implement the same rules, and every Widget fixture compiles in both. A persisted Widget record never changes because a release adds a V2 renderer.

A legacy key that responsive design replaces is not mapped. Clock V2 ignores `textScale` and `contentPadding`: its type and insets follow its box. The keys stay in the persisted record, and Players that render the compatibility presentation still apply them.

A Layout zone that places a V2 Widget carries the same component payload (§11).

## 7. Capabilities and fallback

A V2-capable Player reports:

```json
{
  "presentationSchemaVersions": [1, 2],
  "nativePresentationCapabilities": { "…": 1, "widget.tilecast.clock": 1 }
}
```

The capability list comes from the Widgets bundled in the runtime artifact. `widgets:generate` writes it for each host (`packages/player-runtime/src/widgets/capabilities.gen.ts` and the Edge daemon's generated profile). Nobody edits a host capability list by hand.

For each screen, the Server compiles each reachable Widget:

1. When the Widget has a component, and the Player reports presentation schema 2 and `widget.<type>` at the component version or later, the Widget gets the component presentation.
2. Otherwise, when the Widget has a compatibility presentation, it gets that presentation, exactly as before this change.
3. Otherwise, assignment validation and manifest generation refuse the content with the existing capability error.

A manifest that contains at least one component presentation is v16. Every other manifest keeps the schema that it had before. Assignment validation and manifest generation use the same rules.

The heartbeat accepts at most 128 capability entries (earlier: 64). A Player must not report more than 64 entries until the minimum supported Server accepts 128. A capability name is at most 80 characters, so the full `widget.<type>` capability must fit within that limit (the type may be at most 73 ASCII characters).

## 8. Lifecycle and evidence

A Widget element dispatches bounded, bubbling, composed events:

| Event                   | Detail                    | Runtime meaning                                 |
| ----------------------- | ------------------------- | ----------------------------------------------- |
| `tilecast-widget-ready` | none                      | Meaningful content is painted for these inputs. |
| `tilecast-widget-empty` | `{ reason }` (≤ 48 chars) | Expected empty content. It is not a failure.    |
| `tilecast-widget-error` | `{ code }` (≤ 48 chars)   | The Widget cannot render these inputs.          |

`WidgetMount` turns these events into a state: `ready`, `empty` or `error`. The Player Runtime turns that state into evidence (`widget-shown`, `widget-alive`, `widget-empty`, `layout-zone-rendered`) and playback errors. A Widget never reports evidence.

A time-sensitive Widget may change between `ready` and `empty` at a clock boundary. The base element reports that transition once, even when its `config`, `data`, `empty`, and `context` properties did not change.

The fullscreen `ComponentWidgetSurface` resolves `prepare()` when the mount is `ready` or `empty` and rejects it on `error` or after the ready timeout (10 s of clock time). So the item swaps in only after the Widget rendered. An error after the Widget is shown is a playback failure.

## 9. Styling, theming and CSP

- Elements use Shadow DOM and Lit static `styles`. Lit adopts them as constructed stylesheets (`adoptedStyleSheets`).
- The runtime CSP stays `style-src 'self'` with no `unsafe-inline`. The runtime refuses to mount a V2 Widget when the engine does not support adopted stylesheets, and reports `widget_styles_unsupported`. It does not fall back to `<style>` elements.
- Dynamic values use typed properties and CSS custom properties set through the CSSOM (`style.setProperty`). No code passes an input string to `unsafeCSS` or to a `style` attribute.
- Layout uses CSS container queries on the Widget's own box (`container-type: size`) and container units. `ResizeObserver` is only for SVG scale and text-fit measurement.
- `WidgetTheme` is a bounded set of validated colors plus a scheme (`TILECAST_DISPLAY_THEME` in `@tilecast/widget-sdk`). `@tilecast/widget-kit` derives surfaces, muted text, separators and status colors from it in code, so every engine computes the same values. A Widget may apply an author color only when its authoring schema declares that color. An author background that changes the scheme also changes the default accent.
- The display type scale, spacing, radii and motion durations are container-relative tokens in `@tilecast/widget-kit` (`--tc-type-display` to `--tc-type-caption`). Widgets use the bundled Geist face ("Tilecast UI" in the runtime).

The conformance fixture `widget-component` fails when the element has no shadow root, when its styles are not adopted, when a container query does not apply, or when the document records a CSP violation. It runs on Electron and WPE.

## 10. Studio preview and authoring

Studio renders V2 Widgets with the real element through `WidgetMount`. React
owns forms, editor chrome, source selection, resize controls, focus and
toolbars. The Widget owns only what appears on the display. The gallery keeps
its lightweight schematic thumbnails (`WidgetThumbnail.tsx`); they are
navigation, not playback previews.

Studio keeps one production `WidgetMount` adapter, `WidgetPreviewHost`, and
every V2 preview surface reuses it: the Widget editor, Layout zones
(`V2ZonePreview`), saved Widget thumbnails, Layout thumbnails, and playlist
preview. Fitting is explicit per host. The standalone editor shrinks a
surface into a narrow column but never upscales it. Layout zones fill the
displayed placement and scale both ways with Studio zoom, while the Widget
keeps its logical intrinsic geometry. Hidden capture surfaces keep
deterministic intrinsic geometry and never inherit editor zoom.

Studio projects saved typed previews into the Widget resource model. It keeps
time-series points, timezone, and units so a Widget receives the same dataset
metadata in preview and playback.

A fixed date in the Widget editor freezes the Widget's own clock and passes
the selected local calendar date to its Data Source previews. A Layout
preview date defaults to the browser's local calendar date and does the same
for each zone, so time-sensitive Widgets agree with the Layout's text
bindings. Without a selected date, the preview stays live and uses current
Data Source previews.

The binding Studio editor redesign, source-connection flow, shared preview
host, and first-wave Widget migration are defined in
[Widgets V2 authoring and first-wave migration](widgets-v2-authoring-and-first-wave.md).

## 11. Layout zones

`RuntimeLayoutZone.component` carries the same component payload as a fullscreen Widget. `LayoutSurface` mounts it with `WidgetMount`. The zone reports `layout-zone-rendered` when the mount is `ready` or `empty`. The Widget implementation does not know whether it is fullscreen or in a zone; only its container size changes.

A component zone reports first-render evidence once. A later Widget lifecycle
error reports a failure for that zone through the playback error path. The
Layout remains active, and the error does not count as another render.

## 12. Android

No V2 Widget has Kotlin or Compose code. Android Players do not report component capabilities, so they receive the compatibility presentation. The Android convergence is a separate project: it hosts the built runtime in a trusted local WebView, implements the host contract and runs the conformance suite. Widgets V2 is not complete across platforms until that convergence reaches parity.

## 13. Future extension contribution

Plugin API v1 is frozen and does not change. `defineWidget()`,
`tilecast.widget.json`, and `WidgetMount` are the Widget contribution
boundary regardless of where a Widget comes from.

The binding plan for core Widgets, plugin-bundled Widgets, declarative Data
Sources, source provenance, and future independently distributed packages is
[Tilecast content extension model](content-extension-model.md). Later Widgets
V2 work must keep the source of a Widget orthogonal to its rendering contract.

## 13.5 Plugin-bundled Widgets

A bundled plugin may own Widgets beneath `plugins/<plugin>/widgets/<name>/`.
A nested Widget is an ordinary Widget: the same manifest, SDK, WidgetMount,
Player bundle, Studio editor, and conformance. Only its source differs.

- Identity comes from the parent `tilecast.plugin.json` id, never the
  plugin directory basename. `plugins/emergency-alerts/` is owned by plugin
  `emergency_alerts`. Hosts resolve the directory through the trusted
  plugin manifests; tooling and the Server do the same. A directory without
  a readable parent manifest leaves its Widgets out with a diagnostic.
- A Widget manifest must not declare its own source. The schema rejects a
  source key, the Server rejects one at startup, and `widgets:check`
  re-resolves the parent manifest behind every discovered identity.
- Scaffold with `npm run widgets:new -- <name> --plugin <plugin>`, where
  `<plugin>` is the manifest id or the directory. The provider id stays in
  the plugin's lane (`emergency_alerts_siren`); the component type uses the
  plugin id without separators (`emergencyalerts.siren`), because qualified
  type segments allow neither underscores nor leading hyphens.
- The Server composes nested manifests from the generated
  `widgets/plugin_widgets.gen.go` ledger (Go embedding cannot reach
  `plugins/`), with the same startup validation as core modules: duplicate
  ids, reserved `tilecast.*` types from non-core sources, and repeated
  component types or tags fail the boot.
- Effective availability is static definition AND plugin installation. A
  plugin-owned provider cannot be created, assigned, or projected while its
  plugin is not installed; creation locks the installation row in the same
  transaction so removal cannot race it. The API refuses creation with
  `409 plugin_not_installed`, and assignment and manifest generation refuse
  with `409 playlist_conflict`. Persisted rows survive removal and become
  usable again on reinstall.
- Removing a plugin with remaining contributed Widgets is blocked with one
  `widget` blocker naming the row count and the `delete` resolution.
  Installing or removing a plugin with static contributions invalidates
  screen manifests, even without Plugin API runtime entries.
- Studio shows `Plugin · <name>` on a plugin-owned card and disables it
  with `Requires <name>` while the plugin is not installed.
- `plugins:check` validates each nested manifest against the portable
  Widget schema and allows nested runtime code the Widget imports only
  (Widget SDK, widget-kit, Lit, Storybook, Vitest, relative files inside
  the plugin). Deep conformance stays in `widgets:check`.

## 14. Tools and tests

- `npm run widgets:check` runs `widgetctl check` (manifests, identity, unique IDs, types and tags, entry points, stories, tests, fixtures, configuration bounds and generated files) and then the catalog suite, which mounts every Widget in jsdom and settles each fixture in its declared state.
- `npm run widgets:generate` writes `schema/tilecast-widget.schema.json`, the host capability lists, and the Server-side plugin Widget ledger. `npm run widgets:new -- <name>` creates a complete Widget module; add `--plugin <plugin>` to scaffold a plugin-owned one.
- `npm run widgets:storybook` starts the local Storybook. Stories render fixtures at fixed frames (1920×1080, 1080×1920, 960×540, a wide strip, a tall sidebar and a small zone) through the production mount. No hosted Storybook service is used.
- `npm run widgets:visual` builds the stories and compares each one with a committed Linux Chromium baseline (`widgets/visual/__screenshots__/linux`). Regenerate the baselines in the `mcr.microsoft.com/playwright` image for the installed Playwright version.

### 14.1 Recorded performance

`conformance/widget-perf.mjs` ran on 2026-09-27 on Linux Electron 39.8.5 (Chromium 142), arm64 container, software GL, 1280×720, 120 seconds for each scenario. The runner forces a garbage collection every 10 seconds and then records the JS heap, the DOM node count and the live Widget element instances.

| Scenario                                      | Renderer CPU | Heap after GC (KB) | DOM nodes | Live Widgets |
| --------------------------------------------- | ------------ | ------------------ | --------- | ------------ |
| Compatibility clock, fullscreen, seconds      | 0.25 %       | 2957 → 2959        | 108       | 0            |
| Clock V2, fullscreen, seconds                 | 0.40 %       | 2966 → 2955        | 198       | 1            |
| Layout with four Clock V2 zones               | 0.50 %       | 3163 → 3148        | 546       | 4            |
| Rotation, Clock V2 only (1 s items, 119)      | 1.37 %       | 3290 → 3390        | 236–465   | at most 2    |
| Rotation, compatibility clock and image (120) | 1.20 %       | 3092 → 3365        | 105–109   | 0            |
| Rotation, images only (control, 120)          | 1.29 %       | 3018 → 3253        | 105–106   | 0            |

- Repeated mount and unmount leaves no Widget element behind: at most the Widget on screen and the Widget on the hidden layer are alive after a collection.
- The DOM node count follows the item on screen and does not grow.
- The heap grows by about 100 KB during 119 Clock V2 rotations. This is less than the image-only control, which shows that the conformance host's own evidence log causes the growth.
- A static Widget has no timer. Clock V2 wakes once each second with seconds and once each minute without seconds.

## 15. Deferred from PR 1

- The theme is the Tilecast display theme plus Widget author colors. Player branding colors join the context in a later PR; this needs no new setting.
- Skip-when-empty for components (`empty: "skip-eligible"`) is declared but not acted on. A component that is empty shows its empty presentation.
- Widget-owned copy (for example the default empty title) is English. Clock V2 shows only Intl-formatted text.
- In the Studio gallery, a Widget module's catalog entry follows the definitions in `contentdefs/definitions`, so Clock now appears last in its category.
- PR 1 left the Studio Clock preview on its compatibility renderer. The V2
  authoring work replaced it: Studio previews every V2 Widget with the real
  element through `WidgetMount` (§10).

## 16. PR sequence

1. Foundation and the Clock vertical slice: this document, both packages,
   discovery, `widgetctl`, the CSP conformance gate, manifest v16, capability
   negotiation, `WidgetMount`, fullscreen and Layout plumbing, Storybook
   foundation and Clock V2.
2. Follow the implementation order in
   [Widgets V2 authoring and first-wave migration](widgets-v2-authoring-and-first-wave.md):
   lock source-aware discovery, land the redesigned Studio editor/shared
   preview, then migrate the first visual catalog by family.
3. Continue the remaining catalog migration only after the first wave proves
   the authoring/runtime contracts.
4. Separate project: Android shared-runtime convergence.
5. The final catalog and the fate of every legacy provider are in
   [Widgets V2 final catalog](widgets-v2-catalog.md). Clock component
   version 2 adds the date and world clocks modes. Text, Countdown, and
   the hidden Image Notice compatibility component are Widgets V2
   components. Every provider with a component validates writes through
   its manifest schema (§8 of that document).

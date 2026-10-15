# Tilecast Plugin API v2

Status: accepted. The foundation is implemented. No bundled plugin uses
Plugin API v2 yet. Countdown Bar, Emergency Alerts, and Forms stay on
[Plugin API v1](plugin-api.md). A later change can move each one.

The decision record is
[ADR: Plugin Model V2](adr/plugin-model-v2.md).

## Two definitions

- A **Widget** is presentation content. An operator places a Widget in a
  playlist or a Layout. See [Widgets V2](widgets-v2.md).
- A **Plugin** extends Tilecast. A plugin can add Server behavior, Studio
  pages, Player behavior, or any combination of the three.

A surface is one Player service that a plugin can use. A surface does not
define a plugin. A plugin that draws nothing is a complete plugin.

## Two supported generations

| Generation    | Used by                    | Player behavior                                                                        |
| ------------- | -------------------------- | -------------------------------------------------------------------------------------- |
| Plugin API v1 | Every bundled plugin today | Surface-only. The surface host polls `update` about once a second.                     |
| Plugin API v2 | New plugins                | Event-driven. A plugin asks for versioned services. A surface is one optional service. |

Both generations load from `plugins/<name>/`. Both use the same Server
contribution interfaces, the same Studio host, the same migrations, and the
same generated files. Plugin API v1 is frozen. Its manifests, runtime
contract, and wire entries do not change.

## Contributions

A v2 plugin has three independent contributions.

| Contribution | Where it is declared                          | Required                 |
| ------------ | --------------------------------------------- | ------------------------ |
| Server       | `server`, `migrations`, `api`, `capabilities` | `server.entrypoint` only |
| Studio       | `studio`                                      | No                       |
| Player       | `player`                                      | No                       |

The Server contribution keeps the v1 interfaces: `Initializer`, `Migrator`,
`StatusReporter`, `RemovalGuard`, `RouteProvider`, `WorkerProvider`,
`DataSourceProvider`, `DemoSeeder`, and `AutomationProvider`. Every bundled
plugin has `plugin.go`, because it is the plugin's identity in the Server
catalog. A plugin without Server behavior implements no interface beyond
`Manifest`.

The Studio contribution is the v1 Studio host without change. A plugin can have
a large Studio surface and no Player contribution.

The Player contribution has two optional execution parts:

- `player.runtime`: portable behavior in the Shared Player Runtime.
- `player.native`: first-party native behavior that Player builds compile in.

A plugin without Player behavior has no `player` member and no Player files.

## Manifest

The Zod schema in `packages/plugin-sdk/src/manifest.ts` is the source of truth.
`pluginctl generate` writes the portable JSON Schema. The Go SDK parses the
same file. The fixtures in `packages/plugin-sdk/testdata/manifests/` keep the
parsers in agreement:

- `valid/` and `invalid/` run through Zod, Go, and the JSON Schema.
- `invalid-semantic/` runs through Zod and Go. These are cross-field rules
  that a JSON Schema cannot state.

A v2 manifest has the v1 identity, catalog, Server, Studio, and docs members.
It has these differences:

- `apiVersion` is `2`.
- `capabilities` has `backgroundWorkers` and `network` only.
  `capabilities.playerManifest` is not permitted.
- `runtime` is not permitted. There is no plugin-wide surface list or tier.
- `player` is optional.

```json
{
  "apiVersion": 2,
  "id": "service_notices",
  "server": { "entrypoint": "./plugin.go" },
  "studio": {
    "route": "/plugins/service-notices",
    "entrypoint": "./studio/index.tsx"
  },
  "player": {
    "state": [{ "type": "service_notice", "version": 1 }],
    "runtime": {
      "entrypoint": "./runtime/index.ts",
      "services": {
        "required": ["player.clock@1", "player.surface@1"],
        "optional": ["player.presentation.observe@1"]
      },
      "surfaces": [
        { "id": "ticker", "slots": ["strip.bottom"], "tier": "emergency" }
      ]
    },
    "native": [{ "id": "receiver", "services": { "required": [] } }]
  }
}
```

The identity and catalog members are left out of this example.

| Member                      | Rule                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `player.state`              | 1 to 16 `{type, version}` pairs. A type uses the plugin ID pattern. The pair is unique. |
| `player.runtime.entrypoint` | Always `./runtime/index.ts`.                                                            |
| `player.runtime.services`   | `name@version` references. A name is requested once. Each must be a `runtime` service.  |
| `player.runtime.surfaces`   | Visual contributions: `id`, 1 to 7 unique `slots`, and one `tier`.                      |
| `player.native`             | Up to 8 contributions: `id` and `services`. Each service must be a `native` service.    |

More rules:

- A Player contribution needs `player.runtime`, `player.native`, or both.
- Surfaces need `player.surface@1`. `player.surface@1` needs surfaces.
- `plugin_state` and `external_plugin` are reserved entry types.
- v1 manifest types and v2 state types share one namespace across every
  plugin. `pluginctl check` refuses a duplicate.

The tier belongs to each visual contribution. A claim cannot name or raise a
tier. Fullscreen replacement is not a surface. A plugin uses the canonical
Takeover service (`Host.Takeovers`) for fullscreen content.

## Player state

A v2 plugin that has a Player contribution implements
`plugin.PlayerStateProjector`:

```go
ProjectPlayerState(ctx context.Context, screenID uuid.UUID) ([]plugin.PlayerState, error)
```

`plugin.CheckDeclarations` applies these rules:

- A v2 plugin with a `player` member must implement `PlayerStateProjector`.
  Without state, no Player activates the contribution.
- A v2 plugin must not implement the v1 `ManifestProjector`.
- A v1 plugin must not implement `PlayerStateProjector`.

`plugin.EncodePlayerState` validates each value and wraps it in a
`plugin_state` entry. The Server host and `plugintest` use the same function.

| Bound            | Value                                                         |
| ---------------- | ------------------------------------------------------------- |
| Entries          | 32 for each plugin. The whole `plugins` array has at most 64. |
| State            | JSON object, 16 KiB, 16 levels, 2048 values                   |
| Media references | 16 for each entry                                             |
| `validUntil`     | Optional. At most 366 days ahead.                             |

The wire entry is in the Player manifest `plugins` array:

```json
{
  "id": "0a8f6a52-3d6e-4c50-9a2e-55d7b5a7c001",
  "type": "plugin_state",
  "version": 1,
  "plugin": "sample_beacon",
  "definitionVersion": 1,
  "stateType": "sample_beacon",
  "stateVersion": 1,
  "state": { "label": "Lobby" },
  "media": [],
  "validUntil": "2030-01-01T00:00:00Z"
}
```

`packages/manifest-schema/plugin-state-entry-fixture.json` is this entry. The
Server, Player Core, Edge, Windows, Android, and the Shared Runtime tests read
it.

### Delivery

- The Server sends `plugin_state` only to a Player that reports
  `plugin.host` at version 2.
- Such a Player always receives manifest schema 21, also with no entries. The
  first state change is then a plugin-only revision, not a schema change.
- The Server omits a plugin whose Player contribution is Shared Runtime only
  when the Player does not report a required service. A plugin with native
  contributions is always sent, because the Player build decides native
  support.
- The Server keeps only media references that resolve to an available,
  Player-compatible library variant. It adds each variant to `assets`.
- A plugin revises manifests through `Host.Manifests`, as in v1.

There is no second realtime protocol. Plugin state travels in the existing
`plugins` array. Player Core treats a change that is only in `plugins` as a
plugin-only revision (`is_plugin_only_revision`). The presentation, the
playlist position, the video, and the Layout continue without a restart.

## Player Plugin Host

The Player Plugin Host (`packages/player-runtime/src/plugins/player-host.ts`)
is the generic Shared Runtime host for v2. It is not the surface host.

```text
Player Plugin Host
├── lifecycle and state routing
├── service registry
│   ├── player.clock@1                 corrected time, plugin timers
│   ├── player.media@1                 declared, host-granted media
│   ├── player.presentation.observe@1  read-only screen observation
│   └── player.surface@1               the surface host (shared with v1)
└── future services
```

### Lifecycle

The host has no evaluation loop. A plugin implements only the hooks it uses:

| Event                                     | Hook                                     |
| ----------------------------------------- | ---------------------------------------- |
| First state, required services present    | `activate(context)`, then `stateChanged` |
| The plugin's own state changed            | `stateChanged(entries)`                  |
| Sleep or wake                             | `awakeChanged(awake)`                    |
| An optional service appeared or went away | `servicesChanged()`                      |
| No state, a required service went away    | `dispose()`                              |

Rules:

- A plugin is active while the Player has current state for it and every
  required service is available.
- The host delivers only the plugin's own entries, filtered to the
  `type@version` pairs that its manifest declares.
- The host does not call `stateChanged` when the entries did not change.
- The host removes an entry when its `validUntil` passes on the corrected
  clock.
- A plugin that needs time uses `player.clock@1` timers.
- Presentation changes and other Player events arrive through services, not
  through lifecycle hooks.

### Failure isolation

A throw in `activate`, in a hook, or in a callback that a service makes
(a timer, a grant, a listener) disposes only that plugin. The host releases
its service bindings: timers, listeners, claims, and containers. The plugin
stays failed until the Runtime document reloads. Other plugins, v1 plugins,
and playback continue.

### Discovery

The Runtime build reads the same `import.meta.glob` results as v1. A v2
manifest pairs with a `definePlayerPlugin` module. The definition repeats
the plugin ID and the required and optional services. Discovery leaves out a
definition that does not agree with its manifest. The Runtime tests fail on
every discovery diagnostic.

## Services

A service is one narrow contract that the Player offers to a contribution.
`packages/plugin-sdk/player-services.json` is the canonical vocabulary. The
TypeScript SDK, the Go SDK, and Player Core mirror it. Each mirror has a test
that reads the file.

| Service                         | Execution | Contract                                                                               |
| ------------------------------- | --------- | -------------------------------------------------------------------------------------- |
| `player.clock@1`                | runtime   | `now`, `localNow`, `monotonicNow`, `after`, `every`. Timers end with the plugin.       |
| `player.media@1`                | runtime   | `url(ref)`. Only variants that the plugin's current entries declare. Otherwise `null`. |
| `player.presentation.observe@1` | runtime   | `current()` and `subscribe()`: mode, item ID, kind, occurrence, and `audible`.         |
| `player.surface@1`              | runtime   | `open(contributionId, render)`: persistent containers, claims, grants.                 |

### Versions

- Each service has its own version.
- A Player that reports version N implements every version from 1 to N.
- A change that cannot keep that promise is a new service name.
- The plugin host itself is `plugin.host` version 2. It is independent of the
  service versions.

### Required and optional services

- A missing required service makes that contribution unsupported. The host
  does not activate it. `describe()` lists the missing services.
- A missing optional service is `null` in `context.services`. The plugin runs
  with reduced function. `servicesChanged` reports a later change.

The SDK types make required services non-null and optional services nullable.

### Surface service

`player.surface@1` uses the existing surface host
(`packages/player-runtime/src/plugins/host.ts`). A v2 contribution joins the
same arbitration as v1 plugins and external surfaces:

- one persistent container for each declared slot, kept until the plugin is
  disposed;
- strip, corner, and overlay geometry, push and overlay insets, and the
  corner lift;
- arbitration by declared tier, then claimed priority, then identity;
- claim validation with the v1 rules;
- reduced motion and the conformance animation scale.

A v2 contribution pushes its claims with `claim()`. It is not polled. The
arbitration identity is `<plugin>/<contribution>`.

### Add a service

1. Add the entry to `packages/plugin-sdk/player-services.json`.
2. Update the mirrors: `src/services.ts`, `go/plugin/services.go`, and, for a
   runtime service, `SHARED_RUNTIME_PLAYER_SERVICES` in Player Core.
3. Add the typed interface to `PlayerServiceMap` in `src/player.ts`.
4. For a runtime service, add a provider in
   `packages/player-runtime/src/plugins/service-providers.ts` and register it
   in `main.ts`. For a native service, add a typed trait at its consumer and
   register the platform provider with `NativePluginHost`.
5. Add tests for binding, release at disposal, and failure isolation.

The host, the other services, and existing plugins do not change. A plugin
receives only the services that it requests.

### Next service: `player.audio-bed@1`

Background Music needs a persistent audio bed. It will request
`player.media@1`, `player.presentation.observe@1`, and `player.audio-bed@1`.
The audio bed is not implemented. The expected contract:

- The host owns one audio element outside the presentation stage, so the bed
  continues across playlist items and Layouts.
- The plugin sets a source with a `player.media@1` reference, a volume, and a
  loop flag.
- The host ducks or pauses the bed while `audible` is true for the foreground
  item. The plugin can set the duck level.
- The host stops the bed at sleep and at disposal.

Platform audio focus and autoplay rules need qualification on each Player
before a Player reports this service.

## Native contributions

Player Core owns the native boundary in `crates/player-core/src/plugin_host.rs`:

- `NativePluginContribution`: a trait with `descriptor`, and optional
  `activate`, `state_changed`, `awake_changed`, and `dispose`. Hooks return
  `Result`. Release builds abort on panic, so an error is the isolation path.
- `NativeContributionDescriptor`: plugin ID, contribution ID, accepted state
  pairs, and required and optional services.
- `NativePluginHost`: registration, service negotiation, state routing by
  declared plugin and state type, sleep and wake, and failure handling.

There is no generic invocation channel. A native service is a typed trait
that its consumer owns. Core never names a plugin. Platform code never
branches on a plugin ID or on a platform name.

A first-party native contribution is a Rust crate in
`plugins/<name>/native/<id>/`. `pluginctl check` requires:

- a crate for each `player.native` entry, and no undeclared crate;
- membership in the root Cargo workspace;
- dependencies on `player-core`, `player-types`, and plain data crates only.

Tilecast never loads a native library at run time. Third-party native code is
out of scope.

Not implemented yet: the generated registration list that links native
crates into each Player build, and the first native service. The first native
plugin adds them. The boundary, routing, and fixtures exist and are tested.

## Ownership

| Owner          | Owns                                                                                  |
| -------------- | ------------------------------------------------------------------------------------- |
| Plugin SDK     | Manifest schema, service vocabulary, SDK contracts, `pluginctl`                       |
| Server         | Projection, encoding, capability gate, media resolution                               |
| Player Core    | `plugin_state` validation and routing, capability constants, native contribution host |
| Shared Runtime | Player Plugin Host, runtime services, surface arbitration                             |
| Platforms      | Forwarding entries and media grants, reporting truthful support, native providers     |

## Capability reporting

| Player     | Routes `plugin_state` | Reports `plugin.host@2` | Notes                                                                                                                   |
| ---------- | --------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Edge (WPE) | Yes (Player Core)     | Yes                     | The WPE bridge sets `pluginState: true`. The heartbeat and packaged profile add `shared_runtime_plugin_capabilities()`. |
| Browser    | Yes (resolver)        | Yes                     | The host sets `pluginState: true`. The heartbeat repeats the live Runtime report.                                       |
| Windows    | Yes (Player Core)     | No                      | Gated until WebView2 qualification.                                                                                     |
| Android    | Yes (Player Core)     | No                      | Gated until WebView qualification on a device.                                                                          |

The Runtime reports `plugin.host` and its live service registry only when the
host sets `pluginState`. A gated host receives no schema 21 and no
`plugin_state`. A test in `packages/player-runtime/src/host/plugin-state-support.test.ts`
refuses the reporting tokens in the Windows and Android sources. Remove a host
from that test only together with its qualification evidence and this table.

`plugin.host@2` is independent of `plugin.external-runtime@1`. Neither
implies the other.

## External packages

External Plugin API 2 (`docs/external-player-plugins.md`) does not change.
Its descriptor, frame ABI, and surface bridge stay as they are.

A future external API can use the same service vocabulary:

- Installation review shows the `name@version` services that a contribution
  requests. The reviewed grant is that list.
- The host binds only granted services, through the same registry.
- A service that untrusted code can use needs its own bridge contract. The
  frame bridge would expose that service, not the in-document API.
- Native services are never granted to external packages.

## Tooling

- `npm run plugins:new -- <id>` scaffolds Plugin API v2. Options:
  - `--no-studio` for a Server-only plugin;
  - `--player` with `--services`, `--optional`, and `--surface id:slots:tier`;
  - `--plugin-api 1` for the frozen v1 shape.
- A plugin without `--player` gets no Player files.
- A scaffolded Player plugin requests only the services that it names.
- `npm run plugins:check` validates v2 manifests, the runtime entrypoint in
  both directions, native crates, the shared entry type namespace, import
  boundaries, and generated files.

## Conformance

| Case                                                | Test                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Server and Studio only, no Player                   | `valid/v2-server-studio.json`, `declarations_v2_test.go`, `pluginctl.test.ts`     |
| Player plugin without a surface                     | `player-host.test.ts`: plugin that draws nothing                                  |
| Surface service, push geometry, arbitration with v1 | `player-host.test.ts`: v2 contribution against Countdown Bar and Emergency Alerts |
| Required service missing                            | `player-host.test.ts`; Server `player_state_integration_test.go`                  |
| Optional service missing                            | `player-host.test.ts`                                                             |
| v1 plugins unchanged                                | the existing `host.test.ts`, `integration.test.ts`, `external.test.ts`            |
| Plugin-only state does not restart playback         | `plugin_refresh.rs`, `player_state_integration_test.go`, `player-host.test.ts`    |
| One failing plugin cannot break another or playback | `player-host.test.ts`; `plugin_host.rs`                                           |
| Native registration is generic                      | `plugin_host.rs` fixture contributions                                            |
| Routing on every native Player                      | Edge `manifest.rs`, Windows `projection.rs`, Android `selection.rs`               |

## Verification limits

- The Runtime, Core, Edge unit, Windows unit, Android native unit, Browser
  Player, SDK, and Server unit tests run on every change.
- The Server PostgreSQL integration tests for v2 need `TEST_DATABASE_URL`.
- The Edge heartbeat assertion in `tests/playback.rs` runs on Linux only.
- No physical Player qualification has been done for v2.

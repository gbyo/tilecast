# Tilecast Plugin API v2

Status: accepted. The foundation is implemented. Countdown Bar uses Plugin
API v2. Emergency Alerts and Forms stay on [Plugin API v1](plugin-api.md). A
later change can move each one.

The decision record is
[ADR: Plugin Model V2](adr/plugin-model-v2.md).

## Two definitions

- A **Widget** is presentation content. An operator places a Widget in a
  playlist or a Layout. See [Widgets V2](widgets-v2.md).
- A **Plugin** extends Tilecast. A plugin can add Server behavior, Studio
  pages, Player behavior, or any combination of the three.

A surface is one Player service that a plugin can use. A surface does not
define a plugin. A plugin that draws nothing is a complete plugin.

## Six concepts

Plugin API v2 keeps six ideas apart. Each one has one owner and one
mechanism. A new plugin picks the ones that it needs.

| Concept                     | What it is                                                                                      | Mechanism                                    | Durable |
| --------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------- | ------- |
| Plugin state                | Durable state that the Server projects and a Player reconciles.                                 | `plugin_state` entries in the manifest       | Yes     |
| Plugin event                | One ephemeral, typed fact between the native part and the Shared Runtime part of one plugin.    | `player.events@1` and `player.events`        | No      |
| Surface                     | An optional visual Player service: strips, corners, and overlays.                               | `player.surface@1`                           | No      |
| Presentation provider       | A controlled extension point for a plugin that can supply presentation behavior.                | `player.presentation.provide@1`              | No      |
| Native contribution         | First-party compiled platform behavior, linked into a Player build.                             | `player.native`, typed native services       | No      |
| Shared Runtime contribution | Portable Player behavior that runs in the Shared Runtime on every Player that hosts the plugin. | `player.runtime`, versioned Runtime services | No      |

State is the only concept that the Server sends. The others run inside one
Player. An event never replaces state, and state never carries an event.

## Two supported generations

| Generation    | Used by                    | Player behavior                                                                        |
| ------------- | -------------------------- | -------------------------------------------------------------------------------------- |
| Plugin API v1 | Emergency Alerts, Forms    | Surface-only. The surface host polls `update` about once a second.                     |
| Plugin API v2 | Countdown Bar, new plugins | Event-driven. A plugin asks for versioned services. A surface is one optional service. |

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

| Member                      | Rule                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `player.state`              | 1 to 16 `{type, version}` pairs. A type uses the plugin ID pattern. The pair is unique.                 |
| `player.runtime.entrypoint` | Always `./runtime/index.ts`.                                                                            |
| `player.runtime.services`   | `name@version` references. A name is requested once. Each must be a `runtime` service.                  |
| `player.runtime.surfaces`   | Visual contributions: `id`, 1 to 7 unique `slots`, and one `tier`.                                      |
| `player.native`             | Up to 8 contributions: `id` and `services`. Each service must be a `native` service.                    |
| `player.v1ManifestTypes`    | Up to 8 Plugin API v1 entry types. See [Players without Plugin API v2](#players-without-plugin-api-v2). |
| `player.events`             | Up to 16 events: `name`, `version`, and `source` (`native` or `runtime`).                               |
| `player.runtime.providers`  | Up to 4 presentation providers: `id`. Unique inside the plugin.                                         |

More rules:

- A Player contribution needs `player.runtime`, `player.native`, or both.
- Surfaces need `player.surface@1`. `player.surface@1` needs surfaces.
- `player.events` needs both `player.runtime` and `player.native`, and it needs
  `player.events@1` in the runtime services. `player.events@1` needs at least
  one event.
- An event name uses lowercase letters, digits, and underscores. A name that
  looks like a method call, such as `call.method`, is not valid. The pair
  `name@version` is unique.
- `player.runtime.providers` needs `player.presentation.provide@1`, and
  `player.presentation.provide@1` needs at least one provider.
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
- A v2 plugin implements the v1 `ManifestProjector` only when it declares
  `player.v1ManifestTypes`.
- A v1 plugin must not implement `PlayerStateProjector`.

`plugin.EncodePlayerState` validates each value and wraps it in a
`plugin_state` entry. The Server host and `plugintest` use the same function.

| Bound            | Value                                                         |
| ---------------- | ------------------------------------------------------------- |
| Entries          | 64 for each plugin. The whole `plugins` array has at most 64. |
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

### Players without Plugin API v2

A Player that does not report `plugin.host@2` receives no `plugin_state`.
This includes older Player builds and Players whose v2 reporting is gated. A
plugin that moves from v1 to v2 can keep those Players working:

- The manifest lists the v1 entry types in `player.v1ManifestTypes`.
- The plugin implements the v1 `ManifestProjector` for those types, in
  addition to `PlayerStateProjector`. `plugin.CheckDeclarations` requires
  both, and allows `ManifestProjector` on a v2 plugin only in this case.
- The Server sends the v1 entries only to a Player without `plugin.host@2`
  (`ManifestForScreen`). A Player with it receives `plugin_state` and no v1
  entries (`ManifestForPluginHost`).
- The Player Plugin Host routes a declared v1 entry to the v2 plugin as one
  state entry: the entry `config` is the state. This works on every host,
  also when the host does not set `pluginState`. The plugin has one
  implementation for every Player.

A Player that predates the plugin's move keeps its own v1 renderer for the
same entries.

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
│   ├── player.events@1                bounded native and Runtime events
│   ├── player.media@1                 declared, host-granted media
│   ├── player.presentation.observe@1  read-only screen observation
│   ├── player.presentation.provide@1  declared presentation providers
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

| Service                         | Execution | Contract                                                                                |
| ------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| `player.clock@1`                | runtime   | `now`, `localNow`, `monotonicNow`, `after`, `every`. Timers end with the plugin.        |
| `player.events@1`               | runtime   | `emit(name, version, payload)` and `on(name, version, listener)`. Declared events only. |
| `player.media@1`                | runtime   | `url(ref)`. Only variants that the plugin's current entries declare. Otherwise `null`.  |
| `player.presentation.observe@1` | runtime   | `current()` and `subscribe()`: mode, item ID, kind, occurrence, and `audible`.          |
| `player.presentation.provide@1` | runtime   | `provide(providerId, provider)`: a declared provider that the host starts and stops.    |
| `player.surface@1`              | runtime   | `open(contributionId, render)`: persistent containers, claims, grants.                  |
| `player.reference.signal@1`     | native    | `read()`. A reference service for tests. No product Player provides it.                 |

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
   runtime service, `SHARED_RUNTIME_PLAYER_SERVICES` in Player Core. A runtime
   service that needs help from its host names the host capability in
   `hostCapability`. The Runtime offers such a service only on a host that sets
   the capability, and Player Core leaves it out of
   `SHARED_RUNTIME_PLAYER_SERVICES`.
3. Add the typed interface to `PlayerServiceMap` in `src/player.ts`.
4. For a runtime service, add a provider in
   `packages/player-runtime/src/plugins/service-providers.ts` and register it
   in `main.ts`. For a native service, add a `NativeServiceKind` marker and a
   typed trait in Player Core, and give the platform implementation to
   `NativeServices::provide`. See [Native services](#native-services).
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

Player Core owns the native boundary in `crates/player-core/src/native_host.rs`:

- `NativePluginContribution`: a trait with `descriptor`, and optional
  `activate`, `state_changed`, `awake_changed`, `event`, and `dispose`. Hooks
  return `Result`. Release builds abort on panic, so an error is the isolation
  path.
- `NativeContributionDescriptor`: plugin ID, contribution ID, accepted state
  pairs, required and optional services, and declared events.
- `NativePluginHost`: registration, service negotiation, state routing by
  declared plugin and state type, event delivery, sleep and wake, and failure
  handling.
- `NativePluginFeed`: the handle that a Player host keeps beside its renderer
  port. It reads the presentation document and the runtime context that the
  host already sends to the renderer, and it routes them to the host.

A native contribution is first-party and compiled into the Player. Tilecast
never loads a native library at run time. Third-party native code is out of
scope. There is no generic invocation channel. Core never names a plugin.
Platform code never branches on a plugin ID or on a platform name.

### Contribution crates

A first-party native contribution is a Rust crate in
`plugins/<name>/native/<id>/`. The crate must export:

```rust
pub fn contribution() -> Box<dyn NativePluginContribution>
```

`pluginctl check` requires:

- a crate for each `player.native` entry, and no undeclared crate;
- the `contribution()` entry point in `src/lib.rs`;
- membership in the root Cargo workspace;
- dependencies on `player-core`, `player-types`, and plain data crates only.

### Registration

Rust has no compile-time glob. `pluginctl generate` derives the one crate that
links every contribution:

```text
plugin manifests (player.native)
        ↓  pluginctl generate
packages/plugin-native-registry   contributions() -> Vec<Box<dyn ...>>
        ↓  a Player build depends on it
NativePluginFeed::registered(services, contributions())
        ↓
NativePluginHost
```

- `packages/plugin-native-registry/Cargo.toml` and `src/lib.rs` are generated.
  Never edit them. `pluginctl check` reports drift like any generated file.
- The order is plugin ID, then contribution ID. The output is the same for the
  same manifests.
- The registry names crates. It never states a rule about a plugin, a platform,
  or a service.
- A Player build includes native contributions by depending on the registry
  crate. Edge, Windows, and Android do. The Browser Player does not.
- After the list changes, run `cargo update -w` so that `Cargo.lock` agrees.
- `scripts/ci/check-player-architecture.py` allows a host to depend on the
  registry crate at its one path. The registry may depend only on
  `player-core` and on contribution crates.

A registered contribution is only a candidate. The host decides support when
state arrives:

- A contribution with no state for it stays `Inactive`.
- A contribution that requires a native service the Player does not provide
  stays `Unsupported`. It never activates.
- A contribution that returns an error from a hook is disposed and stays
  `Failed`. Other contributions continue.

A native contribution that has no `player.runtime` part is still sent its
state, because the Player build decides native support.

### Native services

A native service is a typed trait. A marker type names the service, its
version, and the trait that a contribution receives:

```rust
pub trait NativeServiceKind: 'static {
    const NAME: &'static str;
    const VERSION: u32;
    type Api: ?Sized + Send + Sync + 'static;
}
```

- A platform builds `NativeServices` with the services it implements:
  `NativeServices::new().provide::<ReferenceSignalService>(api)`.
- `NativeServices::capabilities()` is what the Player adds to its heartbeat.
  A Player reports only the services that it provides.
- A contribution receives only the services that its descriptor names and the
  Player provides. `context.services().get::<Marker>()` returns the typed trait
  or `None`.
- A provided version N satisfies every request for a version from 1 to N.

`player.reference.signal@1` is the reference service. It reads one counter that
the platform owns. It proves the whole path: a contribution requests a typed
service, the platform provides it, `NativePluginHost` negotiates it, and the
contribution receives it. No product Player provides it. A contribution that
requires it is `Unsupported` on every shipped Player.

A future service such as `player.display-control@1`,
`player.presentation-provider@1`, or `player.sensor.audio-level@1` is a new
marker and a new trait. The host, the feed, the registry, the manifest, and the
meaning of Plugin API v2 do not change. The tests in `native_host.rs` and
`native_services.rs` show this with a second service that the host has never
seen.

Each Player host constructs one feed in its presentation engine and calls it
from three places: after a presentation reaches the renderer, after a
plugin-only update reaches the renderer, and when the renderer is cleared.
Windows, Android, and Edge provide no native services yet. Their feeds hold the
generated registry, which is empty until the first native plugin exists.

## Plugin events

`plugin_state` is durable and reconcilable. It must not become a remote
procedure call. A plugin event is the narrow companion for ephemeral behavior
that does not belong in state. Examples of the class: a button press, a skip
request, a chime, and a native input change. No bundled plugin uses events yet.

An event connects the two Player parts of one plugin. A native contribution
raises it and the Shared Runtime part receives it, or the reverse. Both parts
run in one Player.

| Property     | Rule                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------ |
| Scope        | One plugin. The host stamps the plugin ID. A part cannot name another plugin.                    |
| Declaration  | `player.events` lists each `name@version` and the side that raises it.                           |
| Type         | A name and a version. No method name, no target, and no reply.                                   |
| Payload      | A plain JSON object: at most 2 KiB, 4 levels, and 64 values.                                     |
| Delivery     | At most once. No retry and no replay.                                                            |
| Queue        | Native to Runtime: 8 undelivered events for each plugin, 64 in total. Excess events are refused. |
| Lifecycle    | A disposed or failed contribution can neither emit nor receive. Its queued events are dropped.   |
| Failure      | A handler that fails disposes only its own plugin or contribution.                               |
| Not included | Configuration, state, durable settings, and a second copy of either.                             |

The wire message is the same in both directions:

```json
{
  "type": "plugin-event",
  "plugin": "input_events",
  "event": "button_pressed",
  "version": 1,
  "payload": { "pin": 4 }
}
```

`packages/player-contracts/fixtures/plugin-events.json` pins the message shape,
the bounds, and the invalid cases. Player Core
(`crates/player-core/src/plugin_events.rs`) and the Shared Runtime
(`packages/player-runtime/src/plugins/events.ts`) replay it.

On the native side, `NativeEvents::emit` queues an event and the platform takes
it with `NativePluginHost::take_events`. `NativePluginHost::deliver_event`
gives a Runtime event to the active contributions that declare it. On the
Runtime side, `player.events@1` offers `emit` and `on`. A plugin that keeps the
service handle after disposal gets nothing from it.

### Where delivery stops

Only the local Player contract exists. Two parts are not built:

- **Transport between a Player host and its Runtime.** The Runtime offers
  `player.events@1` only on a host that sets the `pluginEvents` capability,
  sends `plugin-event` messages, and provides `pluginEvents.emit`. No host sets
  it yet. A plugin that requires `player.events@1` is therefore `unsupported`
  on every Player, and one that requests it as optional receives `null`. A host
  that adds the transport adds the capability in the same change.
- **Server to Player actions.** Remote delivery is not part of this contract. A
  future channel would produce the same `plugin-event` message and give it to
  the same host entry points. It would also need authorization, because the
  Server is then the sender. Do not add a second state channel for it.

## Presentation providers

Plugin API v2 works well for plugins that observe or decorate normal playback.
A plugin that supplies a different presentation mechanism needs a controlled
extension point. Examples of the class: an AirPlay receiver, a live video
source, a hardware decoder, and an interactive presentation. No bundled plugin
supplies one yet.

`player.presentation.provide@1` is that point. A plugin declares a provider in
`player.runtime.providers` and offers it with `provide(providerId, provider)`.
The provider is named `<plugin id>/<provider id>`.

The host decides when a provider runs. The provider never starts itself:

- A provider runs only for an `external-presentation` whose `provider` member
  names it. `external-presentation` is the existing state in the Runtime
  presentation vocabulary. A presentation that names no registered provider
  stays with the host.
- The host creates the container inside the content stage. The provider
  receives `container`, `sessionId`, bounded scalar `parameters`, `presenting()`,
  and `fail(reason)`. It receives no playback control and no host global.
- The host owns visibility. The container shows only while the provider owns the
  screen. The host surface draws nothing during that time and returns when the
  provider stops.
- The host owns lifecycle. One session runs at a time. The host stops it when the
  presentation changes, when the plugin is disposed, or when the document ends.
  The same session shown again is kept.
- The host owns evidence. It reports `surface-shown` only after `presenting()`
  and a paint.
- The host owns recovery. A provider that throws, calls `fail`, or is withdrawn
  stops. The host shows its own surface and reports a playback error for the
  activation. A throw also disposes the plugin.
- The host owns targeting and resource authorization. The presentation and its
  media grants come from the host, as for any other presentation.

The seam adds no `if plugin`, `if platform`, or `kind == ...` branch to core
code. The Runtime tests replay a fixture provider through it, and a source scan
fails if a Runtime seam names a plugin or a platform.

## Media for native hosts

`player.media@1` returns the Player address of a variant that the plugin's
current state declares. Where the address comes from depends on the host:

- A host that sends explicit `media` bindings (the Browser Player) leaves
  `variantMedia` unset, and the Runtime uses those bindings.
- A host that serves `tcmedia://variant/<asset>/<variant>` sets `variantMedia`
  (Edge, Windows, Android), and the Runtime builds that address. The host
  authorizes each load against the current plugin state or activation grants. An
  undeclared variant is refused by the Runtime and again by the host.

A plugin-only update that adds media cannot reuse the active media grants. The
host then activates the presentation again, because grants follow content.
Windows and Android also activate again when only the alias set changes.

## Ownership

| Owner          | Owns                                                                                  |
| -------------- | ------------------------------------------------------------------------------------- |
| Plugin SDK     | Manifest schema, service vocabulary, SDK contracts, `pluginctl`                       |
| Server         | Projection, encoding, capability gate, media resolution                               |
| Player Core    | `plugin_state` validation and routing, capability constants, native contribution host |
| Shared Runtime | Player Plugin Host, runtime services, surface arbitration                             |
| Platforms      | Forwarding entries and media grants, reporting truthful support, native providers     |

## Capability reporting and qualification

| Player     | Routes `plugin_state` | Reports `plugin.host@2` | `variantMedia` | Native feed | `pluginEvents` transport |
| ---------- | --------------------- | ----------------------- | -------------- | ----------- | ------------------------ |
| Edge (WPE) | Yes (Player Core)     | Yes                     | Yes            | Yes         | No                       |
| Browser    | Yes (resolver)        | Yes                     | No             | No          | No                       |
| Windows    | Yes (Player Core)     | Yes                     | Yes            | Yes         | No                       |
| Android    | Yes (Player Core)     | Yes                     | Yes            | Yes         | No                       |

The Runtime reports `plugin.host` and its live service registry only when the
host sets `pluginState`. Edge and Windows add the same report to their packaged
profile and heartbeat. Android adds it to the ready report from the generated
contract, and only while the WebView runs the trusted Runtime. A host that
reports nothing receives no schema 21 and no `plugin_state`.

`plugin.host@2` is independent of `plugin.external-runtime@1`. Neither implies
the other. `player.events` is never in the default report. No Player reports a
native service today, and `player.reference.signal` is never reported.

### What qualifies a host

A host reports `plugin.host@2` only when it carries the whole contract. The
automated evidence for each host is:

| Contract point                          | Edge                              | Browser                 | Windows                            | Android                                       |
| --------------------------------------- | --------------------------------- | ----------------------- | ---------------------------------- | --------------------------------------------- |
| `plugin_state` reaches the Runtime      | `manifest.rs`, WPE bridge         | `host.ts`, resolver     | `projection.rs`, `presentation.rs` | `selection.rs`, `renderer.rs`                 |
| Declared media is granted               | `manifest.rs`, WPE aliases        | resolver media bindings | `renderer_adapter.rs` aliases      | `selection.rs` content grants                 |
| Live service support is reported        | packaged profile, heartbeat       | live Runtime report     | packaged profile, heartbeat        | `RendererReadyReportTest`, `manifest_host.rs` |
| Required and optional services          | `player-host.test.ts` (Runtime)   | same                    | same                               | same                                          |
| Plugin-only update keeps the activation | `presentation.rs`, Core           | resolver, Runtime       | `plugin_api_2_state_media_and_...` | `plugin_api_2_state_refreshes_without_...`    |
| Replay after a Runtime reload           | bridge `lastPlugins`              | `host.ts`               | `runtime_host.js` `lastPlugins`    | `HostChannel` `lastPlugins`                   |
| Plugin and playback failure isolation   | `player-host.test.ts`, Core       | same                    | same                               | same                                          |
| Sleep and wake                          | Core feed, Runtime `awakeChanged` | Runtime `awakeChanged`  | Core feed, Runtime `awakeChanged`  | Core feed, Runtime `awakeChanged`             |
| V1 plugins are unaffected               | v1 Runtime suites                 | same                    | same                               | same                                          |

`packages/player-runtime/src/host/plugin-state-support.test.ts` reads each host
source for the contract points above. A host cannot set `pluginState` without
the replay path, and no host source may set `pluginEvents`. The shared
conformance fixture `plugin-state` runs the same sequence on Electron, WPE,
WebView2, and Android: v2 state beside a v1 plugin, a plugin-only update, and a
clear. It must restart nothing.

Sleep and wake follow the presentation. A sleep presentation carries no plugin
state, so the Runtime and the native feed both dispose their plugins. The next
presentation sends the state again.

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

| Case                                                | Test                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Server and Studio only, no Player                   | `valid/v2-server-studio.json`, `declarations_v2_test.go`, `pluginctl.test.ts`       |
| Player plugin without a surface                     | `player-host.test.ts`: plugin that draws nothing                                    |
| Surface service, push geometry, arbitration with v1 | `player-host.test.ts`: v2 contribution against Countdown Bar and Emergency Alerts   |
| Required service missing                            | `player-host.test.ts`; Server `player_state_integration_test.go`                    |
| Optional service missing                            | `player-host.test.ts`                                                               |
| v1 plugins unchanged                                | the existing `host.test.ts`, `integration.test.ts`, `external.test.ts`              |
| Plugin-only state does not restart playback         | `plugin_refresh.rs`, `player_state_integration_test.go`, `player-host.test.ts`      |
| One failing plugin cannot break another or playback | `player-host.test.ts`; `plugin_host.rs`                                             |
| Native registration is generic                      | `native_host.rs` fixture contributions; `pluginctl.test.ts` registry generation     |
| Native registry is reproducible and drift-checked   | `pluginctl.test.ts`; `plugins:check`                                                |
| A typed native service negotiates                   | `native_host.rs` and `native_services.rs`: reference service, required, optional    |
| A native contribution uses bounded events           | `native_host.rs`; `plugin-events.json`; `plugin-seams.test.ts`                      |
| A fixture presentation provider registers           | `plugin-seams.test.ts`                                                              |
| No plugin ID or platform name in shared behavior    | `native_host.rs` and `plugin-seams.test.ts` source scans                            |
| Routing on every native Player                      | Edge `manifest.rs`, Windows `projection.rs`, Android `selection.rs`                 |
| Hosts carry the whole contract                      | `plugin-state-support.test.ts`; host unit tests; conformance fixture `plugin-state` |

## Verification limits

- The Runtime, Core, Edge unit, Windows unit, Android native unit, Browser
  Player, SDK, and Server unit tests run on every change.
- The Server PostgreSQL integration tests for v2 need `TEST_DATABASE_URL`.
- The Edge heartbeat assertion in `tests/playback.rs` runs on Linux only.
- The WebView2 and Android runtime conformance engines run in CI on Windows and
  on an emulator. A developer Mac cannot run them.
- No physical Player qualification has been done for v2. Windows hardware,
  Fire TV, Google TV, and Android TV WebView builds belong to the release and
  canary process.
- No native contribution exists yet, so no Player build links one. The native
  host, the registry generator, and the typed service model are proven with
  fixture contributions. The first native plugin adds its crate and its service.
- No event transport between a Player host and its Runtime exists. See
  [Where delivery stops](#where-delivery-stops).

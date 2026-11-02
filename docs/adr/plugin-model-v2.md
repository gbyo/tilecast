# ADR: Plugin Model V2

Status: accepted. The contract is [Plugin API v2](../plugin-api-v2.md).

## Context

Plugin API v1 describes Player behavior with one plugin-wide `runtime` member:
manifest types, surface slots, and one arbitration tier. The runtime contract
is a surface lifecycle that the host polls about once a second. This model
fits Countdown Bar and the Emergency Alerts ticker.

It does not fit other plugins that Tilecast needs:

- Forms has Server and Studio behavior and no Player behavior.
- Background Music needs persistent sound across items. It draws nothing.
- AirPlay, GPIO, and sensor integrations need native platform behavior.
- A plugin with two visual parts needs a tier for each part.

Under v1, such a plugin must invent an invisible surface or a one-off field.

## Decision

- A plugin is a set of independent contributions: Server, Studio, and Player.
  Each one is optional. The Server and Studio contributions are the v1
  contracts without change.
- The Player contribution has a Shared Runtime part, a native part, or both.
  Execution location and feature type are separate concepts.
- A Player contribution asks for versioned services by `name@version`.
  Services are narrow. Each binding belongs to one plugin. There is no single
  Player plugin API object.
- The first services are `player.clock@1`, `player.media@1`,
  `player.presentation.observe@1`, and `player.surface@1`. The surface service
  is the v1 surface host. The tier belongs to each visual contribution.
- The Player Plugin Host is event-driven. A plugin activates while state for
  it exists and its required services are available.
- Plugin state travels as `plugin_state` entries in the existing `plugins`
  array. There is no second realtime protocol, and plugin-only revisions keep
  their existing behavior.
- Ephemeral behavior is a separate, narrow concept: a plugin event. An event is
  declared, typed, versioned, bounded, plugin-scoped, and bound to the life of
  its contribution. It connects the native part and the Shared Runtime part of
  one plugin. It is never state, never a method call, and never a second copy of
  configuration. The contract is local to one Player. Remote delivery is not
  built, and the document names where it would plug in.
- A plugin that supplies a different presentation mechanism uses one optional
  service, `player.presentation.provide@1`. The host starts and stops the
  provider, owns its container, visibility, evidence, and recovery, and falls
  back when it fails. A provider never takes over the Player.
- Capability negotiation is generic: `plugin.host@2` and service versions.
  The Server and the Players never branch on a plugin ID or a platform name.
- Player Core owns `plugin_state` routing and the native contribution host.
  Native contributions are first-party crates compiled into Player builds.
  `pluginctl generate` derives the one registry crate that links them, so a
  Player build reaches `NativePluginHost` without a plugin ID in core or
  platform code. A native service is a typed Rust trait named by a marker type,
  never a string-keyed call.
- Plugin API v1 stays frozen beside v2. The existing plugins do not move in
  this change.

## Consequences

- A new kind of plugin chooses contributions and services. It does not change
  the definition of a plugin.
- A new service is a provider, a vocabulary entry, and tests. The host and the
  other services do not change.
- Two plugin generations exist until the bundled plugins move to v2.
- Every full Player host reports `plugin.host@2`: Edge, Browser, Windows, and
  Android. The shared Runtime hosts it, and each host forwards state, grants
  declared media, and replays state after a reload. A host must carry that whole
  contract before it sets `pluginState`. Physical-device qualification belongs to
  the release and canary process.
- No Player provides a native service, and no Player carries events between a
  host and its Runtime. The Player reports exactly what it provides. The model,
  the registry, and the services are proven with fixtures.
- A future service, such as display control or an audio level sensor, is a new
  service name and a new provider. It does not change what a plugin is.

## Rejected alternatives

- **Make the surface host the plugin host.** It would keep a one-second loop
  for plugins that draw nothing and keep the surface as the definition of a
  plugin.
- **One `PlayerPluginAPI` object.** Every plugin would receive every function.
  Narrow, versioned services keep each grant reviewable and let a Player
  report what it implements.
- **One field for each example plugin.** Each new plugin would change the
  manifest again.
- **A generic native invoke bridge.** It would move typed contracts into
  strings and remove review. Native services are typed traits at their
  consumers.
- **A universal message bus for actions.** One bus for every Server, native, and
  Runtime message would become the remote procedure call that state avoids.
  Events are declared, bounded, and limited to the two parts of one plugin.
- **Loading native libraries at run time.** A `.so`, a DLL, or a JAR would put
  third-party code into the Player. Native contributions are compiled in.
- **Plugin IDs or platform names in the registry or the host.** A registry that
  decides support by name would again make core code know every plugin. Support
  follows services and state, which are data.
- **Migrate the bundled plugins now.** It would mix a model change with
  behavior changes in production plugins. Each plugin can move separately.

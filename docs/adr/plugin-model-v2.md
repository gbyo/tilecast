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
- Capability negotiation is generic: `plugin.host@2` and service versions.
  The Server and the Players never branch on a plugin ID or a platform name.
- Player Core owns `plugin_state` routing and the native contribution host.
  Native contributions are first-party crates compiled into Player builds.
- Plugin API v1 stays frozen beside v2. The existing plugins do not move in
  this change.

## Consequences

- A new kind of plugin chooses contributions and services. It does not change
  the definition of a plugin.
- A new service is a provider, a vocabulary entry, and tests. The host and the
  other services do not change.
- Two plugin generations exist until the bundled plugins move to v2.
- Windows and Android route `plugin_state` but do not report `plugin.host@2`
  until their qualification passes.
- The native registration list and the first native service arrive with the
  first native plugin.

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
- **Migrate the bundled plugins now.** It would mix a model change with
  behavior changes in production plugins. Each plugin can move separately.

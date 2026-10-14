# External Player plugins

Installation review shows the verified surface set and priority tier for each
executable contribution. Descriptor bytes must match the authenticated OCI
layer. A scoped operator must control both previous and new target definitions
to replace configuration or disable an instance.

Android uses an independent plugin frame grant set for each presentation
generation. The adapter stages verified files before delivery and commits
grants after the narrow update succeeds. Media and Widget grants stay active.
The response policy follows the frame kind. The native message listener
accepts only the main Runtime document. Native capability reporting remains
a separate qualification gate.

External Plugin API 2 is separate from bundled Plugin API 1.
An external package contributes a local `tilecast.plugin.json` descriptor.
The Server gives the contribution a qualified identity.
The descriptor must declare `playerManifest: true`.
It declares one to seven surface slots and one tier.
It cannot name Go, React, or arbitrary executable entrypoints.
External API 1 plugin rows remain inert.

## Verified frame

The fixed Player bundle path is `runtime/index.js` inside the contribution.
The bundle assigns `window.__tilecastExternalPlugin`.
The package SDK builds the external surface bootstrap.
The Server uses the generated template in
`apps/server/internal/extensions/sandbox/plugin_frame.gen.go`.
Run `npm run packages:generate` to update it.

The Server escapes inline script closers before assembly.
It calculates the SHA-256 and exact byte size of the complete document.
The document has the same byte limit as an external Widget frame.
The manifest names these bytes, not an arbitrary URL or bundle import.

Production catalog rebuilds and frame delivery read executable bytes directly
from authenticated OCI content layers.
The read calculates the digest from the same stream that supplies the bytes.
A changed extraction cache cannot change the authenticated frame.
The reader rejects links, duplicate files, invalid paths, excess expansion,
excess file count, and an invalid content digest.
Wasm module cache misses use this reader too.

`GET` and `HEAD /api/v1/player/packages/{packageId}/plugins/{pluginId}/frame`
require a device credential.
Unknown packages, inert contributions, and missing frames return
`package_plugin_unavailable` with status 404.
The response supports ETags and byte ranges.
The host must apply the response sandbox when it serves verified bytes to
its renderer.

The authoritative response policy grants only scripts and inline styles.
It denies images, media, fonts, network, workers, objects, forms, and base URLs.
It grants no same-origin access, popups, or top navigation.
Hosts must refuse frame navigation outside the verified grant.
Untrusted frame code must never receive a native bridge or a device credential.

## State service

The package requests `plugin-runtime.state@1`.
The host derives the package ID, artifact digest, and execution epoch.
Guest JSON cannot supply or replace these values.
Every operation checks ownership of the named qualified contribution.
It requires an active external API 2 descriptor with `playerManifest: true`.
The check and mutation hold the package lifecycle fence.

| Operation   | Context            | Behavior                                        |
| ----------- | ------------------ | ----------------------------------------------- |
| `get`       | Studio, background | Read configuration and last published state.    |
| `configure` | Studio             | Save enabled state, configuration, and targets. |
| `publish`   | Studio, background | Publish expiring Player state.                  |
| `clear`     | Studio, background | Clear Player state and keep configuration.      |

`configure` takes `contributionId`, `enabled`, `configuration`, `targets`, and
`expectedConfigurationRevision`.
An unconfigured contribution has revision zero.
A changed configuration increments the host-owned revision.
The operation requires an Owner or Administrator.
The target check also enforces the account's screen scope.
The Server records an operator audit event without the configuration body.
It clears the previous Player state.
It invalidates the union of old and new targets.
An identical configuration produces no revision or audit event.

`publish` takes `contributionId`, `configurationRevision`, `state`, and
`validUntil`.
The revision must match current configuration.
The contribution must be enabled.
The state must be an object with at most 16 KiB of canonical JSON.
It may have at most sixteen nested levels and 2048 values.
Numbers must be finite and must not use exponent notation.
A stored state that is no longer valid removes only its own entry from the manifest.
The deadline must be after the Server clock and at most five minutes ahead.
Only current target screens with the reported external surface capability
receive a manifest invalidation.
Unsupported Players receive no entry or state-driven revision.
An identical state and deadline produce no revision.
Publication does not record an operator configuration event.

`clear` takes `contributionId` and `configurationRevision`.
It invalidates current targets only when state exists.
Package removal deletes configuration and state through the installation
foreign key.
An update keeps configuration.
State from a different descriptor definition version is not projected.

## Targets

`targets.resolve@2/resolve` takes the target definition directly.
It returns resolved `screenIds` in stable order.
The definition has `mode`, `screenIds`, `groupIds`, and `locationIds`.
Mode is either `all` with no IDs or `selected` with a nonempty union.
There are at most 1000 selected targets.
IDs must be valid, unique, current organization targets.
Empty selection never means all.

`targets.resolve@2/options` is Studio-only.
It takes `kind` (`screen`, `group`, or `location`), `search`, `page`, and
`pageSize`.
Search has at most 100 bytes.
The default page size is fifty; the maximum is one hundred.
The response contains only target IDs, names, kind, pagination, and
`canSelectAll`.
A scoped account cannot select all.
Its group and location options require a direct matching scope grant.
Its screen options use the canonical account scope predicate.
This prevents a selected directory target from acquiring unauthorized future
members.

The bundled screen/group target host shares the core targeting implementation.
Its version 1 empty-selection-means-none contract does not change.
Group membership mutations already invalidate affected screens.
A screen location change now invalidates that screen in the same transaction.

## Player manifest and surface ABI

The generic Player capability is `plugin.external-runtime@1`.
Only a Player that reports it receives external entries.
Such a Player receives manifest schema 20 even when the plugin array is empty.
Adding the first surface can then use the plugin-only refresh path.
Older Players keep their existing manifest contract.

An entry uses `type: external_plugin` and `version: 1`.
Its `id` equals its qualified `package.contributionId`.
It carries `definitionVersion`, verified package identity and frame claim,
declared `runtime.surfaces` and `runtime.tier`, bounded `state`, and
`validUntil`.
The frame claim has `sha256`, `fileSize`, and authenticated `downloadPath`.
It carries no configuration, targets, private storage, or operator facts.

Native projection preserves a validated external entry as Runtime data.
It does not resolve the entry through the bundled `plugin.<type>` registry.
Player Core identifies the external entry for all native hosts.
Frame verification and the independent renderer channel remain mandatory.
This routing rule does not grant or report the generic capability.

The frame bridge protocol is `tilecast.plugin.surface/1`.
The attach token is a random 128-bit URL fragment.
The parent accepts one hello from the exact opaque frame window.
It transfers one MessageChannel port with a separate random nonce.
Further messages use that port, nonce, and increasing input revision.
One bridge message may have at most 32 KiB.
The parent must bound message rate and structure.
The shared Runtime permits a burst of twenty-four messages and refills twelve
messages per second. JSON has at most sixteen nested levels and 2048 values.
The Runtime closes a frame that exceeds a message bound.
It must retire the port on navigation, removal, replacement, or disposal.

The definition supplies `update(state, context, bridge)`.
It may supply `grant(value, context, bridge)` and `dispose()`.
`bridge.now()` uses the corrected Tilecast clock.
`bridge.claim(claim)` requests one declared slot; null releases it.
The host owns tier, arbitration, geometry, z-order, visibility, expiry, motion,
and wake state.
Expiry has its own corrected-clock timer; it does not wait for a periodic tick.
The Runtime retains one frame per instance across public-state changes.
It changes its host-owned container geometry without moving the frame node.
A previously accepted claim has a maximum 500 ms handoff on an input change.
A current-revision reply renews or releases it. More inputs cannot extend an
unanswered claim. This permits a short exit animation without a stale holder.
The frame cannot claim a different tier or an undeclared surface.
Native preparation must verify and pin each frame before accepting a pending
manifest.
Plugin frame grants must not replace presentation media grants.
See [Player Core](player-core.md) for plugin-only revision proof.

## Compatibility and qualification

Package API 4 is required for realtime jobs.
The external descriptor and surface ABI have independent versions.
The package compatibility range must require the first coordinated Tilecast
release that contains all required host support.
Do not infer this version from a development build or a platform version file.
Native hosts must not report the capability before they implement the complete
verification, grant, navigation, and sandbox contract.

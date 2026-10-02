# Presentation Model

`packages/presentation-model` owns pure presentation decisions. Studio and
Player Runtime use this package. The package does not depend on either
consumer. It has no production dependencies.

## Current decisions

- `isAvailableAt()` evaluates an availability window at an explicit instant.
- `nextAvailabilityTransition()` finds the next future window boundary.
- `defaultImageDurationMsForPlayback()` reads the effective image default.
- `fallbackDurationMsFor()` selects the existing per-kind duration fallback.
- `resolvePlaybackItemSettings()` resolves duration, fit, transition, audio,
  and volume from an item and effective Player settings.
- `isPlaylistZoneMediaItem()` accepts image and video items without a nested Layout.
- `resolveMediaEligibility()` checks the item window, item kind, exact asset
  reference, asset window, and media type in that order.

Availability starts are inclusive. Expiration is exclusive. Bounds contain
instants with timezone offsets. Malformed or inverted windows are unavailable.
The model does not read the current clock. Callers supply the evaluation time.
Date conversion for authoring controls stays with the authoring surface.

Videos have no invented fallback duration. An explicit image item overrides
the Player duration unless the item selects Player defaults. The model uses
the existing Player configuration field names. Studio converts its settings
document in `src/content/playbackDefaults.ts`.

## Ownership and builds

Player Runtime compatibility modules re-export the model functions. They do
not retain separate implementations. DOM mounting, video events, timers,
storage, host bridges, and telemetry stay with the runtime and device hosts.
The Server scheduling service retains schedule precedence.

Browser consumers import the TypeScript source. Node consumers load the
compiled CommonJS entry. `player-runtime` builds that entry before its Node
entry points. The Linux package includes the compiled dependency. The Studio
container copies the model workspace for browser builds.

## Verification

`fixtures/foundation.json` contains expected availability and settings
results. Model, Studio, and runtime tests consume the same fixtures. They
cover future and expired assets and items, half-open bounds, DST offsets,
duration defaults, explicit overrides, fade and crossfade, and value limits.
The Studio tests also exercise the existing static-item preview duration.

`fixtures/media-eligibility.json` covers supported media, unsupported item
kinds, missing assets, reference mismatches, and item and asset windows.
Studio tests exercise its zone filter. Runtime tests exercise Layout projection.
An unsupported Widget remains valid as a direct Widget placement. The zone
policy does not change the direct Widget renderer.

The source compiler has no DOM library. A purity test rejects host imports,
browser globals, ambient clock reads, randomness, and runtime dependencies.
The affected-area graph selects Studio and production runtime consumers for
model changes.

```sh
npm run typecheck --workspace @tilecast/presentation-model
npm test --workspace @tilecast/presentation-model
npm test --workspace @tilecast/player-runtime
npm test -- --run src/content/presentationModelConformance.test.ts
```

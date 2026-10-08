# Player contracts

This directory contains only cross-player fixtures that do not already have a natural package owner.

- `fixtures/server-url-policy.json` is the shared normalization and security corpus for Linux, Android, and Edge server-address entry.
- `fixtures/widget-frames.json` is the shared v19 sandbox-frame contract: the `tcwidget://cap/` URI shape (exact on the authorization table, handshake-fragment-tolerant at the serving layer), the served sandbox headers, the range-refusal rule, and the `widget.external-runtime` execution-ABI version every frame-capable host advertises.

Runners assert the frame fixture directly: `player-types` pins the constants, `edge-protocol` runs the table-URI corpus, `tilecast-windows` runs the request-URI corpus and the served headers, and `player-runtime` pins the execution-ABI constants. Hosts whose serving layer cannot read the fixture mirror the corpus in their own tests instead: Android's `FrameAuthorizationTest`/`TcWidgetBridgeTest` and the WPE `test-validate`/`test-media-client` suites. When the fixture changes, update the mirrors in the same commit.

`player-capabilities.json` is the versioned cross-player capability
registry: data-only definitions of the Player capabilities hosts may
report and packages may invoke. Each capability carries an `id`, a
`version`, human-readable metadata, the closed provider vocabulary,
and its operations. Each operation carries an input schema (a small
JSON-Schema subset: `type: object`, typed `properties` with `enum`,
`minimum`, `maximum`, or `pattern`, `required`, and
`additionalProperties: false`) plus the command table that maps
validated inputs to persistent Player commands. A `when` clause lists
the discriminator fields and values that select its command; an empty
`when` matches every valid input. The queued command payload is the
operation input with the matched discriminator fields removed, and it
must validate under the command's own rules. The server package
`internal/playercaps` mirrors this registry in typed Go and pins it
with a drift test that replays the canonical file, so the JSON stays
the single source of truth without a runtime file dependency.

Do not turn this directory into a generic conformance package. Manifest and declarative-presentation contracts belong to `packages/manifest-schema`; Layout contracts belong to `packages/layout-schema`; Widget component capability generation belongs to `widgetctl`; runtime playback behavior belongs to `packages/player-runtime`; Edge IPC belongs to `packages/edge-protocol`.

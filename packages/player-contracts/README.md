# Player contracts

This directory contains only cross-player fixtures that do not already have a natural package owner.

- `fixtures/server-url-policy.json` is the shared normalization and security corpus for Linux, Android, and Edge server-address entry.
- `fixtures/widget-frames.json` is the shared v19 sandbox-frame contract: the `tcwidget://cap/` URI shape (exact on the authorization table, handshake-fragment-tolerant at the serving layer), the served sandbox headers, the range-refusal rule, and the `widget.external-runtime` execution-ABI version every frame-capable host advertises.

Runners assert the frame fixture directly: `player-types` pins the constants, `edge-protocol` runs the table-URI corpus, `tilecast-windows` runs the request-URI corpus and the served headers, and `player-runtime` pins the execution-ABI constants. Hosts whose serving layer cannot read the fixture mirror the corpus in their own tests instead: Android's `FrameAuthorizationTest`/`TcWidgetBridgeTest` and the WPE `test-validate`/`test-media-client` suites. When the fixture changes, update the mirrors in the same commit.

Do not turn this directory into a generic conformance package. Manifest and declarative-presentation contracts belong to `packages/manifest-schema`; Layout contracts belong to `packages/layout-schema`; Widget component capability generation belongs to `widgetctl`; runtime playback behavior belongs to `packages/player-runtime`; Edge IPC belongs to `packages/edge-protocol`.

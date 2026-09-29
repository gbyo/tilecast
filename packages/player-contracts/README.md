# Player contracts

This directory contains only cross-player fixtures that do not already have a natural package owner.

- `fixtures/server-url-policy.json` is the shared normalization and security corpus for Linux, Android, and Edge server-address entry.

Do not turn this directory into a generic conformance package. Manifest and declarative-presentation contracts belong to `packages/manifest-schema`; Layout contracts belong to `packages/layout-schema`; Widget component capability generation belongs to `widgetctl`; runtime playback behavior belongs to `packages/player-runtime`; Edge IPC belongs to `packages/edge-protocol`.

# tilecast-renderer-wpe

The Tilecast Linux display engine: a small C11/GLib embedder of WPE WebKit 2.54+ that uses the WPEPlatform API only. It does not use Cog, libwpe or WPEBackend-fdo. See `docs/tilecast-edge.md` §10.

`tilecastd` decides what to show. This process hosts the shared Tilecast Player Runtime ([`docs/player-runtime.md`](../../../docs/player-runtime.md)), which shows it and reports what happened. It holds no credentials, does no scheduling or downloading, and never receives a path from the page.

## Platforms

| `--platform`    | Use                                                             |
| --------------- | --------------------------------------------------------------- |
| `drm` (default) | Dedicated signage, no compositor (`tilecast-renderer.service`). |
| `wayland`       | Development machines and existing kiosk compositors.            |
| `headless`      | CI and integration tests.                                       |

## Motion preference

WebKit 2.54 inverts `WPE_SETTING_REDUCED_MOTION`: with the default (`FALSE`) pages see `prefers-reduced-motion: reduce`. A signage display has no viewer preference, and the Player Runtime's artwork (the Cast logo) stops animating under `reduce`. `main.c` sets the setting to `TRUE`, which gives `no-preference`. Recheck this when the pinned WPE version in `release/build-wpe.sh` changes.

## What it serves

- `tilecast://runtime/<name>` and `tilecast://runtime/fonts/<name>`: the shared Player Runtime artifact (`packages/player-runtime/dist/runtime`), the same files the Electron player serves. `assemble-runtime.sh` copies it and verifies every file against the artifact's `runtime-manifest.json`. Names are validated against a fixed grammar (`src/validate.c`).
- `tcmedia://cap/<opaque>`: a daemon-issued capability scoped to the current renderer and presentation generation. Reads use the bounded media socket; the renderer has no CAS path or direct CAS permission.

## Bridge

`web/tilecast-bridge.js` implements the runtime's host contract, `TilecastRuntimeHostV1`, on two script message handlers. It only translates: projection, timing, transitions and evidence belong to the runtime. It advertises capabilities (no remote web, no synchronized timing, no discovery and no microphone yet), and the runtime decides from them.

- `tilecast` carries events: `runtime.ready`, `presentation.accepted`, `presentation.rejected`, `renderer.progress`, `renderer.item_error`.
- `tilecastRequest` carries `setup.submit_server_url`.

Layout and Widget items arrive as references (`{"layoutId"}`, `{"widgetAssetId"}`) with a projection context: the needed manifest subset, the corrected clock offset and a media alias table. The adapter passes the context to the Player Runtime, which projects the items with its projection compatibility code (the same code the Electron player runs) before it accepts the activation, and re-projects them every 30 seconds. `tcmedia://variant/<asset>/<variant>` addresses in a projected tree, and the Brand Bug plugin's logo, resolve only through the alias table, and only to capabilities granted for the activation.

The host copies only known, bounded fields into IPC events. Host-to-page delivery calls one fixed function with GVariant arguments; no script source is concatenated. The daemon replaces internal hash URIs with opaque, renderer-generation capabilities before sending an activation.

## Live preview and Watch Live capture

`preview.request` is answered with a bounded JPEG (`src/preview.c`). `tilecastd` sends it for the Studio preview and for each Watch Live frame, one at a time. The daemon owns when a capture may happen; the renderer owns where the pixels come from.

- **Primary source: the presented WPE buffer.** `tc_preview_attach_view()` follows `WPEView::buffer-rendered` and `WPEView::buffer-released` and keeps a reference to the one buffer the view presented last. On the DRM platform this is the buffer that the last page flip committed to the display, so it contains HTML video and every other layer. No history of buffers is kept. The reference is dropped when the view releases that buffer, when the web process stops, and when the renderer stops.
- **Copy before encode.** `wpe_buffer_import_to_pixels()` returns memory that the WPE buffer owns. The renderer copies the pixels on its main thread (`tc_pixels_copy()` in `src/preview-pixels.c`) and gives only the copy to the worker-thread GStreamer encoder (`appsrc ! videoconvert ! videoscale ! jpegenc ! appsink`). The rest of the pipeline is unchanged: size and byte bounds, quality retries, the capture deadline, and one capture at a time (`preview_busy`).
- **Formats.** A DMA-BUF buffer is accepted as `DRM_FORMAT_XRGB8888` (`BGRx`) or `DRM_FORMAT_ARGB8888` (`BGRA`); a shared-memory buffer as ARGB8888 (`BGRA`). The release architectures are little-endian. A DMA-BUF import reports no stride, so the stride is the returned size divided by the height. The size must divide evenly and the stride must hold a full row. `tests/test_preview_pixels.c` checks this with truncated, malformed and overflowing sizes.
- **Fallback: WebKit snapshot.** `webkit_web_view_get_snapshot()` is used for a request only when the presented buffer cannot be read: no buffer yet, import not supported, unknown format, a GBM mapping failure, or an invalid size or stride. A WebKit snapshot can leave out a hardware-decoded video layer, so it is a compatibility path. The two paths never run together, and a capture problem never changes playback.
- **Logs.** The backend is logged when it changes: `preview: using presented WPE buffer 1920x1080 dmabuf XRGB8888 modifier 0x0`, or `preview: WPE buffer import unavailable (<reason>); falling back to WebKit snapshot`. Per-capture lines are debug level (`G_MESSAGES_DEBUG=all`). A log line never contains pixels, content URLs or credentials.

The headless end-to-end test runs this path with SHM buffers. The DMA-BUF import on a physical DRM display has no CI coverage; the release canary checks it.

## Build and test

```sh
docker build -t tilecast-wpe-dev -f ci/Dockerfile ci
docker build -t tilecast-edge-dev -f ci/Dockerfile.edge ci
npm run build --workspace @tilecast/player-runtime
docker run --rm -v "$PWD/../../..:/src" -v tilecast-edge-target:/target \
  tilecast-edge-dev /src/apps/edge/renderer-wpe/ci/run-e2e.sh all
```

`ci/run-e2e.sh` builds `tilecastd`, `tilecastctl` and the renderer, runs the C unit tests (including `test-preview-pixels`), assembles the runtime, runs the projection tests (`tests/bridge_projection.test.mjs`), and runs `tests/e2e_headless.py`. That script starts a real daemon and renderer on `WPE_PLATFORM=headless` and checks the lifecycle through `tilecastctl`.

`ci/run-conformance.sh` builds the test-only `tilecast-runtime-conformance` runner (`tests/conformance.c`) and runs the Player Runtime conformance fixtures under WPE WebKit headless, for comparison with the Electron run (`packages/player-runtime/conformance`).

## Not yet supported

These features are not advertised in `renderer.ready`, so `tilecastd` never activates presentations that need them:

- Websites and YouTube: they need the isolation design in `docs/tilecast-edge.md` §10.5.
- Synchronized playback.
- Browser microphone capture: it is always denied, and the Noise Meter moves to PipeWire in `tilecastd`.

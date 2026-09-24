# tilecast-renderer-wpe

The Tilecast Linux display engine: a small C11/GLib embedder of WPE WebKit 2.54+ that uses the WPEPlatform API only. It does not use Cog, libwpe or WPEBackend-fdo. See `docs/tilecast-edge.md` §10.

`tilecastd` decides what to show. This process hosts the shared Tilecast Player Runtime ([`docs/player-runtime.md`](../../../docs/player-runtime.md)), which shows it and reports what happened. It holds no credentials, does no scheduling or downloading, and never receives a path from the page.

## Platforms

| `--platform`    | Use                                                             |
| --------------- | --------------------------------------------------------------- |
| `drm` (default) | Dedicated signage, no compositor (`tilecast-renderer.service`). |
| `wayland`       | Development machines and existing kiosk compositors.            |
| `headless`      | CI and integration tests.                                       |

## What it serves

- `tilecast://runtime/<name>` and `tilecast://runtime/fonts/<name>`: the shared Player Runtime artifact (`packages/player-runtime/dist/runtime`), the same files the Electron player serves. `assemble-runtime.sh` copies it and verifies every file against the artifact's `runtime-manifest.json`. Names are validated against a fixed grammar (`src/validate.c`).
- `tcmedia://sha256/<hex>`: a CAS object. It is served only when the current activation or plugin state lists that digest, and only when the file size matches the declared size. The file is opened with `O_NOFOLLOW`. A single byte range is honored.

## Bridge

`web/tilecast-bridge.js` implements the runtime's host contract, `TilecastRuntimeHostV1`, on two script message handlers. It only translates: projection, timing, transitions and evidence belong to the runtime. It advertises capabilities (no remote web, no synchronized timing, no discovery and no microphone yet), and the runtime decides from them.

- `tilecast` carries events: `runtime.ready`, `presentation.accepted`, `presentation.rejected`, `renderer.progress`, `renderer.item_error`.
- `tilecastRequest` carries `setup.submit_server_url`.

The host copies only known, bounded fields into IPC events. Host-to-page delivery calls one fixed function with GVariant arguments; no script source is concatenated.

## Build and test

```sh
docker build -t tilecast-wpe-dev -f ci/Dockerfile ci
docker build -t tilecast-edge-dev -f ci/Dockerfile.edge ci
npm run build --workspace @tilecast/player-runtime
docker run --rm -v "$PWD/../../..:/src" -v tilecast-edge-target:/target \
  tilecast-edge-dev /src/apps/edge/renderer-wpe/ci/run-e2e.sh all
```

`ci/run-e2e.sh` builds `tilecastd`, `tilecastctl` and the renderer, runs the C unit tests, assembles the runtime, and runs `tests/e2e_headless.py`. That script starts a real daemon and renderer on `WPE_PLATFORM=headless` and checks the lifecycle through `tilecastctl`.

`ci/run-conformance.sh` builds the test-only `tilecast-runtime-conformance` runner (`tests/conformance.c`) and runs the Player Runtime conformance fixtures under WPE WebKit headless, for comparison with the Electron run (`packages/player-runtime/conformance`).

## Not yet supported

These features are not advertised in `renderer.ready`, so `tilecastd` never activates presentations that need them:

- Websites and YouTube: they need the isolation design in `docs/tilecast-edge.md` §10.5.
- Live preview: `preview.request` is answered `preview_not_implemented`.
- Synchronized playback.
- Browser microphone capture: it is always denied, and the Noise Meter moves to PipeWire in `tilecastd`.

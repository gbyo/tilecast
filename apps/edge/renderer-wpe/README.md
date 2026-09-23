# tilecast-renderer-wpe

The Tilecast Linux display engine: a small C11/GLib embedder of WPE WebKit 2.54+ that uses the WPEPlatform API only. It does not use Cog, libwpe or WPEBackend-fdo. See `docs/tilecast-edge.md` (Amendment A1, §28).

`tilecastd` decides what to show. This process shows it and reports what happened. It holds no credentials, does no scheduling or downloading, and never receives a path from the page.

## Platforms

| `--platform`    | Use                                                             |
| --------------- | --------------------------------------------------------------- |
| `drm` (default) | Dedicated signage, no compositor (`tilecast-renderer.service`). |
| `wayland`       | Development machines and existing kiosk compositors.            |
| `headless`      | CI and integration tests.                                       |

## What it serves

- `tilecast://runtime/static/<name>` and `tilecast://runtime/dist/renderer/<name>`: the trusted DOM runtime. The runtime is the reference Linux player's renderer, used unmodified, and `assemble-runtime.sh` copies it. Names are validated against a fixed grammar (`src/validate.c`).
- `tcmedia://cap/<opaque>`: a daemon-issued capability scoped to the current renderer and presentation generation. Reads use the bounded media socket; the renderer has no CAS path or direct CAS permission.

## Bridge

`web/tilecast-bridge.js` implements the runtime's `window.tilecast` interface on two script message handlers:

- `tilecast` carries events: `runtime.ready`, `presentation.accepted`, `presentation.rejected`, `renderer.progress`, `renderer.item_error`.
- `tilecastRequest` carries `setup.submit_server_url`.

The host copies only known, bounded fields into IPC events. Host-to-page delivery calls one fixed function with GVariant arguments; no script source is concatenated. The daemon replaces internal hash URIs with opaque, renderer-generation capabilities before sending an activation.

## Build and test

```sh
docker build -t tilecast-wpe-dev -f ci/Dockerfile ci
docker build -t tilecast-edge-dev -f ci/Dockerfile.edge ci
npm run build --workspace @gibsonmb71/tilecast-player-linux
docker run --rm -v "$PWD/../../..:/src" -v tilecast-edge-target:/target \
  tilecast-edge-dev /src/apps/edge/renderer-wpe/ci/run-e2e.sh all
```

`ci/run-e2e.sh` builds `tilecastd`, `tilecastctl` and the renderer, runs the C unit tests, assembles the runtime, and runs `tests/e2e_headless.py`. That script starts a real daemon and renderer on `WPE_PLATFORM=headless` and checks the lifecycle through `tilecastctl`.

## Not yet supported

These features are not advertised in `renderer.ready`, so `tilecastd` never activates presentations that need them:

- Websites and YouTube: they need the isolation design in RFC §28.6.
- Live preview: `preview.request` is answered `preview_not_implemented`.
- Synchronized playback.
- Browser microphone capture: it is always denied, and the Noise Meter moves to PipeWire in `tilecastd`.

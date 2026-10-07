# Sandbox spike harness

Measures the stage 5c isolation spike in a real browser: the
`SandboxedWidgetExecutor` mounts verified fixture bundles in opaque-origin
`allow-scripts` frames under the exact Player Runtime CSP, and the driver
records lifecycle states, timing, and a screenshot of every placement.

## Run

```sh
node spike/run.mjs [--chrome /path/to/chrome] [--keep]
```

The runner serves a generated `spike/dist/` directory and the frame
documents from two loopback origins, drives the harness in headless
Chrome over CDP in real time, prints one line per case, and exits
nonzero on any failure. Real-time CDP keeps network loads and latency
honest; virtual-time budgets fast-forward timers past frame
navigations. `spike.png` keeps the rendered placements for visual
inspection. `--keep` also keeps the generated bundle, page, and frame
documents.

`CHROME_BIN` overrides the browser search. The harness page refuses to
build when its CSP drifts from
`packages/player-runtime/static/index.html`.

## On other targets

Electron, WPE, and the Android shared-runtime WebView cannot run this
script as-is. `docs/widget-sandbox-spike.md` records the desktop-Chromium
measurements and the per-target procedure: generate `spike/dist/`
(`node spike/run.mjs --keep`), serve it and `spike/dist/frames/` from
two origins, open `harness.html?frames=<port>`, read the `#results`
JSON and the screenshot.

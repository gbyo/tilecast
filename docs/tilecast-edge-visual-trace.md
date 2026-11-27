# Tilecast Edge visual trace

The visual trace is an operator diagnostic of `tilecast-renderer-wpe`. It
records two timelines on one clock for a bounded time:

- the events of the Player Runtime layers that compositor animations move:
  stage crossfades, Layout zone transitions, and the startup reveal;
- every buffer that WPE presents (`WPEView::buffer-rendered`,
  `buffer-released`, `buffers-changed`), as metadata.

The trace answers one question: at the frame where the screen shows a wrong
picture, what did the Runtime do, and which buffers did WPE present?

The trace does not record pixels. The
[WPE compositor lab](tilecast-edge-wpe-compositor-lab.md) inspects pixels of
synthetic scenes.

## Default state

The trace is off. Without `--visual-trace`, the renderer:

- injects no trace script, so the Runtime has no trace sink;
- connects no extra signal handler and runs no trace timer;
- opens no trace file.

In the Runtime, every trace call site checks one constant boolean before it
builds a record. Without the sink, normal playback allocates nothing and runs
nothing per frame for the trace. The headless e2e `fixture` scenario checks
that the renderer log has no trace output.

## Enable a trace

The flags are local to the renderer process. tilecastd and the Tilecast
Server cannot enable them.

| Option                     | Effect                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `--visual-trace`           | Records for the trace window. Also turns on page console output (`--console`).             |
| `--visual-trace-seconds=N` | Length of the trace window, 5 to 1800 seconds. The default is 120.                         |
| `--visual-trace-dir=PATH`  | Directory of `visual-trace.jsonl`. The default is `$XDG_CACHE_HOME/tilecast-visual-trace`. |
| `--visual-trace-deep`      | Also samples computed styles every animation frame. This changes timing. See below.        |

On a screen, use the field tool. It writes a drop-in in `/run/systemd/system`,
so a reboot removes it. An Edge release from before this trace has no
`--visual-trace` option and no trace sink, so `trace enable` refuses on it.
First install the diagnostic Tilecast overlay of a checkout that has the trace
(`runtime-overlay install`, see
[the lab guide](tilecast-edge-wpe-compositor-lab.md#diagnostic-tilecast-overlay)).
The tool also reads the environment that the renderer and its web process
really have, and refuses to keep a trace for a profile that they do not match:

```sh
sudo python3 -I tilecast_wpe_debug.py doctor
sudo python3 -I tilecast_wpe_debug.py runtime-overlay install tilecast-runtime-overlay-<label>-<arch>.tar
sudo python3 -I tilecast_wpe_debug.py trace enable --seconds 120
# Reproduce the glitch on the screen.
sudo python3 -I tilecast_wpe_debug.py trace collect --out ~/trace
sudo python3 -I tilecast_wpe_debug.py trace disable
sudo python3 -I tilecast_wpe_debug.py runtime-overlay restore
```

To compare compositors in the production renderer, add one allowlisted
variable, for example `--env WEBKIT_USE_SKIA_FOR_COMPOSITION=0`. The tool
refuses every other variable.

The unit sets `XDG_CACHE_HOME=/var/cache/tilecast-renderer`, so the trace is
`/var/cache/tilecast-renderer/tilecast-visual-trace/visual-trace.jsonl`. The
previous trace stays as `visual-trace.jsonl.prev`.

## Mechanism

1. `main.c` parses the options and enables page console output.
2. `view.c` opens the trace file first. If it cannot open it, the renderer
   injects no script and runs as without the option. Then `view.c` injects
   `web/tilecast-visual-trace.js` at document start. The script goes into the
   page world of the trusted top document only, and only at
   `tilecast://runtime/index.html`. Deep mode puts one fixed constant before
   it. The host never puts a variable value into script source.
3. The script defines a frozen `globalThis.__tilecastVisualTrace` sink. The
   Runtime reads the sink once, when it first records. The sink has
   `active()`. The Runtime asks it before it records or samples a frame.
4. The Runtime sends batches of at most 128 records. The sink forwards each
   batch through the existing native relay as a `diagnostics.visual_trace`
   report. A batch that is larger than the relay bound is split. A batch is
   never truncated.
5. `forward_page_message` gives the report to `visual-trace.c`. The report
   goes to the local trace file only. It never goes to tilecastd.
6. `visual-trace.c` follows the presented buffers of the view and samples the
   page clock once each second.
7. When the trace window ends, `visual-trace.c` removes the injected scripts,
   so a later document gets no sink. It also calls the sink's `stop()` with a
   fixed script that has no arguments. After that, `active()` is false, and the
   Runtime stops recording and stops deep sampling. The Runtime also stops at
   its own record limit.

This mechanism adds no generic native call bridge and no new script message
handler. The host checks each record again (`src/visual-trace-format.c`).

## Bounds

| Bound                          | Value                               | Owner                   |
| ------------------------------ | ----------------------------------- | ----------------------- |
| Records waiting in the Runtime | 512, then drops are counted         | `visual-trace.ts`       |
| Records in one document        | 50,000, then the trace stops        | `visual-trace.ts`       |
| Records in one batch           | 128 (Runtime), 256 (host)           | both                    |
| Keys in one record             | 24                                  | both                    |
| String value                   | 48 bytes of `[A-Za-z0-9_.:-]`       | both                    |
| Trace file                     | 32 MiB, 16 KiB kept for the summary | `visual-trace-format.c` |
| One line                       | 8 KiB                               | `visual-trace-format.c` |
| Pacing samples                 | 65,536 presentations                | `visual-trace.c`        |
| Trace window                   | 5 to 1800 seconds                   | `main.c`                |

When a bound is reached, the trace drops lines and counts them. It never
blocks playback. At the end of the window, the renderer writes the summary,
closes the file and disconnects its handlers. The renderer continues to play.

## Privacy

A Runtime record can hold only finite numbers, booleans, null, and tokens of
`[A-Za-z0-9_.:-]`. A token cannot hold a URL, a path with slashes, or free
text. The Runtime applies this rule, and the host applies it again.

Records identify layers by Runtime ordinals and closed tokens only:

- `tx`: transition ordinal;
- `anim`: animation ordinal;
- `mount`: stage mount number;
- `layer`: `a` or `b`;
- `layout`, `zone`, `index`, `epoch`: Layout ordinals, never zone IDs;
- `kind`: item kind, for example `image` or `video`.

The trace has no item ID, zone ID, manifest ID, media capability, URL, Server
address, screen ID, or credential. The buffer identity is an ordinal of the
`WPEBuffer` object (`buf`) and of the DMA-BUF inode (`mem`). It is never a
pointer or a file descriptor.

## Schema `tilecast-visual-v1`

Each line is one JSON object with a `type` member.

| `type`    | Members                                                                                                                                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `header`  | `schema`, `source`, `rendererVersion`, `buildCommit`, `clock`, `startMono`, `webkit`, `platform`, `deep`, `windowSeconds`, `env`, `screen`                                                                     |
| `frame`   | `ev` `rendered`: `mono`, `seq`, `buf`, `w`, `h`, `kind` (`dmabuf`, `shm`, `other`), `mem`, `fourcc`, `modifier`, `planes`, `strides`, `offsets`, `renderFence`, `releaseFence`. `ev` `released`: `mono`, `buf` |
| `buffers` | `mono`, `count`, `bufs`: the buffer set from `buffers-changed`                                                                                                                                                 |
| `runtime` | `recv` (host receive time), `batch`, `sentAt`, optional `dropped`, `rec` (one Runtime record)                                                                                                                  |
| `clock`   | `t0`, `t1` (host time before and after), `js` (`performance.now()` in the page)                                                                                                                                |
| `summary` | `endedBy`, `durationMs`, frame and record counts, `droppedLines`, `pacing`                                                                                                                                     |

Host times (`mono`, `recv`, `t0`, `t1`) are `CLOCK_MONOTONIC` microseconds.
Runtime times (`rec.t`, `startTime`, `currentTime`) are milliseconds on the
document timeline, which is the origin of `performance.now()`.
WebKit reduces the resolution of `performance.now()` to 1 ms. A Runtime event
is therefore placed on the host clock with an error of about 1 ms plus half the
round trip of the clock sample that the report uses. One display interval at
60 Hz is 16.7 ms, so the error does not move an event to another frame in most
cases.

`header.buildCommit` is the Tilecast git commit that the renderer was built
from (`unknown` for a release build; a diagnostic overlay has its commit, with
`-dirty` for modified files). `trace collect` also copies `trace-meta.json`,
which has the requested and observed environment, the renderer and Runtime
hashes, and the overlay.

`header.env` names the compositor variables that change rendering. The list is
`tc_trace_env_allowlist` in `src/visual-trace-format.c`. A value that is not a
short token is written as `<invalid>`.

### Runtime events

Each stage crossfade has one `tx`:

| Event                                    | Meaning                                                               |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `stage.fill`, `stage.ready`              | The incoming surface is staged on the hidden layer, then ready.       |
| `stage.swap`                             | The swap starts. Includes the outgoing layer and its `visible` state. |
| `swap.stack`                             | z-index: incoming 1, outgoing 0.                                      |
| `fade.pin`                               | Inline `opacity: 0` on the incoming layer.                            |
| `anim.create`                            | `element.animate()` returned. Play state, times and effect `endTime`. |
| `swap.visible`                           | The `visible` class is on the incoming layer.                         |
| `anim.ready`                             | The animation is ready: `startTime`, `currentTime`, `playState`.      |
| `anim.finish`, `anim.cancel`             | The animation ended.                                                  |
| `fade.unpin`                             | The inline opacity is removed and the animation is cancelled.         |
| `swap.settle`                            | The incoming layer is `visible`. The outgoing layer is not.           |
| `stage.outgoing-paused`, `stage.dispose` | The outgoing surface is paused, then released.                        |
| `stage.activated`, `stage.settled`       | The incoming surface plays. The transition is complete.               |

Layout zone transitions use the scope `zone`, with `zone.stage`, `zone.ready`,
`zone.show`, `zone.settled`, `zone.cut` and `zone.superseded`, and the same
`fade.*` and `anim.*` events.

The startup reveal uses the scope `startup`: `startup.phase` (`revealing`,
`resolving`, `done`), `startup.pulse`, `startup.settle`, `startup.push`,
`startup.push-end`, `startup.covered` (the screen is the white sheet),
`startup.resolve`, `startup.resolve-end` and `startup.remove`. The animations
`front-settle`, `mark-recede`, `card-push`, `shade` and `resolve` have
`anim.*` events.

## Read a trace

Run the report on any computer:

```sh
python3 apps/edge/renderer-wpe/diagnostics/visual_trace_report.py visual-trace.jsonl
```

The report maps each Runtime document to the host clock. It uses the clock
sample with the smallest round trip that agrees with every record of that
document. After a reload, a sample is used for the new document only if its
time origin is not before the last record of the previous document. A sample
that the previous document answered has that document's earlier origin, so it
is not used. Then it prints, for each transition, the Runtime events and the
presented frames in time order. It flags:

- `end-window`: a frame presented after the end of an animation on the
  compositor clock (`startTime` plus duration) and before the Runtime cleanup
  for that animation. A compositor that shows the resting value of an ended
  animation shows a wrong picture in these frames. The duration is the
  `currentTime` of `anim.finish`. Without a finish record, it is the effect's
  `endTime`, which `anim.create` records. A cancelled animation did not reach
  its end, so it has no end window.
- `long-frame`: an interval longer than 1.5 display intervals.

`--json` prints the same analysis as JSON.

## Deep mode

`--visual-trace-deep` reads `getComputedStyle()` for each animated element in
every animation frame of a transition. It records `deep.sample` events with
opacity, a transformed flag and the animation times.

Deep mode can change what it measures:

- `requestAnimationFrame` callbacks make the main thread produce a frame for
  each display interval. Without them, WebKit can run an accelerated animation
  on the compositor thread only.
- `getComputedStyle()` forces a style update.

Use deep mode only after a plain trace. Do not compare a deep trace with a
plain trace as evidence of a timing problem.

## Tests

- `packages/player-runtime/src/diagnostics/visual-trace.test.ts`: default off,
  record rules, bounds, batching, animation events, deep sampling.
- `packages/player-runtime/src/transitions/crossfade.test.ts`: the trace
  changes no DOM state of a crossfade.
- `scripts/ci/wpe-visual-trace.test.mjs`: the sink script.
- `apps/edge/renderer-wpe/tests/test_visual_trace_format.c`: file bounds,
  record checks, the environment allowlist, pacing.
- `apps/edge/renderer-wpe/tests/e2e_headless.py --scenario visual-trace`: a
  real daemon and renderer with the trace on.
- `apps/edge/renderer-wpe/diagnostics/test_diagnostics.py`: the report.

# WPE compositor lab and field diagnostics

This document describes the tools that find where a rendering defect of
Tilecast Edge occurs: in the Player Runtime, in WebKit composition, or below
WebKit in the WPEPlatform DRM path and the driver. The tools are for
development and diagnosis. They do not change playback, and an Edge release
does not install them.

| Tool                                     | Location                                                    | Runs on                     |
| ---------------------------------------- | ----------------------------------------------------------- | --------------------------- |
| Visual trace of the real Runtime         | `tilecast-renderer-wpe --visual-trace`                      | a screen                    |
| Compositor lab                           | `apps/edge/renderer-wpe/lab/`                               | a screen, Wayland, headless |
| Experiment matrix, overlay, field bundle | `apps/edge/renderer-wpe/diagnostics/tilecast_wpe_debug.py`  | a screen, as root           |
| Local WPE build                          | `apps/edge/renderer-wpe/diagnostics/wpe-local.sh`           | a development computer      |
| Trace report                             | `apps/edge/renderer-wpe/diagnostics/visual_trace_report.py` | any computer                |

The visual trace has its own contract: [Tilecast Edge visual trace](tilecast-edge-visual-trace.md).

## Field evidence that started this work

An x86_64 screen with Debian 13, Linux 6.12, Tilecast Edge 1.4.0, WPE WebKit
2.54.0, GStreamer 1.26.2 and the WPEPlatform DRM backend shows two defects
with Skia composition, the default:

- the startup reveal flashes;
- a playlist crossfade flashes, and the outgoing item can show again during
  the transition.

The renderer stays healthy and does not restart. PR #1945 (inline opacity pin)
is in the build. With `WEBKIT_USE_SKIA_FOR_COMPOSITION=0` (TextureMapper), both
defects stop. The two features use different Runtime code. Both use
compositor-driven opacity and transforms.

TextureMapper is not the solution. Skia is the target compositor.

## Source analysis of WPE WebKit 2.54.0 and 2.54.3

The analysis uses the release tarballs (2.54.0 SHA-256
`efa9bcc3cb891c2d88f50eec710d9ccee71cbdf1040420361eb98c17355eb452`, 2.54.3
SHA-256 `787afd32ae23eac061621465390f44a462e874a9ebaba0b65521d7237fa8a5e4`) and
the 442 commits between the tags `wpewebkit-2.54.0` and `wpewebkit-2.54.3`.

### Leading hypothesis: ended animations use the resting value

In 2.54.0, `SkiaCompositingLayer::opacityForAnimationsState()`,
`localTransform()`, `futureLocalTransform()` and `filter()` return the
animation value only while `m_animationsState->isRunning` is true:

```cpp
float SkiaCompositingLayer::opacityForAnimationsState(const AnimationsState* animationsState) const
{
    if (!animationsState || !animationsState->isRunning)
        return m_opacity;
    return animationsState->opacity.value_or(m_opacity);
}
```

`TextureMapperAnimation::apply()` sets the state to `Stopped` when the
animation time passes the end. It still gives the final keyframe value, but
`isRunning` is then false. The Skia layer shows `m_opacity`, the value the main
thread committed, until the main thread removes the accelerated animation and
commits again. `TextureMapperLayer::syncAnimations()` uses the animation value
without this condition. This difference agrees with the field result: the
defect stops with TextureMapper.

What a Tilecast transition shows in that interval:

| Animation                 | Resting value on the layer         | Frames after the compositor end show           |
| ------------------------- | ---------------------------------- | ---------------------------------------------- |
| Stage crossfade `fade-in` | inline `opacity: 0` (PR #1945 pin) | the incoming layer disappears: the old item    |
| Layout zone `fade-in`     | inline `opacity: 0`                | the old zone item                              |
| Startup `card-push`       | no transform (the small card)      | the small card on black before the white sheet |
| Startup `mark-recede`     | opacity 1                          | the wordmark again                             |
| Startup `resolve`         | opacity 1                          | the white sheet again before removal           |

Before PR #1945 the resting value of the incoming layer was 1, so the end
looked correct. PR #1945 fixed a different defect at the start of the fade.

The fix is upstream commit 320494@main (`4af7b773e279`, bug 321993,
"SkiaCompositingLayer: Take the last animation value after animation ended").
It removes the `isRunning` condition from the four functions. It is in
`webkitglib/2.54` as `2d883a0c1598` and was first released in **2.54.1**. The
commit message says that it has "no effect for web". The lab measures if that
is true on the affected hardware.

Bug 316045 (`d06ccb1bca68`, the opacity damage comparison as a boolean) is
already in 2.54.0. It is not this defect.

### Other changes between 2.54.0 and 2.54.3

| Commit         | Release | Change                                                                | Relevance                           |
| -------------- | ------- | --------------------------------------------------------------------- | ----------------------------------- |
| `1e83cd6518b2` | 2.54.1  | preserve-3d layers painted in the wrong order across the camera plane | startup push (perspective)          |
| `532543ed2201` | 2.54.1  | damage too small for layers that extend behind the camera             | startup push, `transform-3d`        |
| `cc71717027b9` | 2.54.1  | damage too large for layers with an edge at infinity                  | startup push                        |
| `32661519b3dc` | 2.54.1  | `SkiaCompositingLayer` filter rendering under transforms              | none: Tilecast uses no filters here |
| `e2f4f85fbd14` | 2.54.1  | layers with filters always damaged                                    | none                                |
| `c06a84872ba6` | 2.54.2  | `animations-opacity-to-invisibility.html` flaky (test only)           | method for a LayoutTest             |
| `5ba8d8f48f94` | 2.54.3  | clip the non-composited clear to the repainted damage                 | transparent views only              |
| `3d042abf49c1` | 2.54.3  | `wpe_buffer_import_to_pixels()` returns rows without padding          | the lab and preview import          |
| `816fcf2641d7` | 2.54.2  | pre-rendered tiles above the visible area painted first               | low                                 |
| `acb28d816b1f` | 2.54.2  | DRM vblank monitor releases a reference it does not own               | DRM pacing                          |

`4f5451cc6e7e` (2.54.2, bug 325212) removes the negation of
`WPE_SETTING_REDUCED_MOTION`. Before it, the renderer had to set `TRUE` to give
pages `prefers-reduced-motion: no-preference`. After it, `TRUE` gives `reduce`,
and the startup reveal is a plain fade. A comparison of the startup on 2.54.3
with a renderer that always sets `TRUE` shows no glitch only because the
choreography does not run. The renderer and the lab now choose the value from
the WebKit version that is loaded (`src/motion-setting.h`).

The three camera-plane changes can also affect the startup push. The lab
scene `transform-3d` with the variant `cross-camera` separates them from the
end-of-animation defect.

### What the hypothesis predicts

- 2.54.0 with Skia: `opacity-basic`, `crossfade` and `startup-minimal`
  report `reversal` anomalies at the end of animations. The `busy-end`
  variant makes the interval longer and the anomaly reproducible on every
  iteration.
- 2.54.0 with Skia, variant `no-pin`: the fade-in end is correct, because the
  resting value equals the end value.
- 2.54.0 with TextureMapper: no anomaly.
- 2.54.3 with Skia: no anomaly.

If 2.54.3 removes the defect on the affected screen, merge the 2.54.3 pin. Do
not add a Tilecast workaround. If 2.54.3 does not remove it, the lab result
and the trace show the next place to look.

## Compositor lab

`tilecast-wpe-compositor-lab` is a test executable next to the conformance
runner. CMake builds it. No `install()` rule includes it, and
`stage-release.py` does not carry it.

The lab uses the WPEPlatform API with the display, settings and view setup of
the renderer:

- the same display types and `WPE_SETTING_REDUCED_MOTION`;
- the same WebKit settings, a black view background, and a fullscreen toplevel
  on DRM;
- WebKit's bubblewrap sandbox, cleared only in a build with
  `TILECAST_ALLOW_UNSANDBOXED_WEBKIT`.

The lab has no Tilecast Server connection, device credential, network, manifest
or Player Runtime. Scenes come from a private `tclab://` scheme. Video loads as
a `blob:` URL, so the lab does not change the GStreamer protocol allowlist.

### Options

| Option             | Default       | Effect                                                    |
| ------------------ | ------------- | --------------------------------------------------------- |
| `--platform`       | `headless`    | `drm`, `wayland` or `headless`                            |
| `--scene`          | required      | one of the scenes below                                   |
| `--variant`        | none          | scene variants, joined with `:`                           |
| `--iterations`     | 20            | repetitions, 1 to 10000                                   |
| `--size`           | `1920x1080`   | view size on Wayland and headless                         |
| `--out`            | required      | output directory                                          |
| `--inspect`        | `transitions` | `off`, `transitions` or `all` (see below)                 |
| `--grid`           | `8x5`         | sample points in the probe rectangle, at most 256         |
| `--dump-anomalies` | 6             | anomalies to dump as PPM, at most 64                      |
| `--dump-context`   | 2             | frames dumped before and after each anomaly               |
| `--dump-scale`     | 4             | downscale of dumped frames                                |
| `--timeout`        | 900           | seconds                                                   |
| `--inspector`      | off           | Web Inspector on a loopback address. See "Web Inspector". |

Exit status: 0 no anomaly, 3 anomalies, 4 setup failure, 5 timeout.

Output:

- `summary.json`: versions, compositor variables, buffer kinds and formats,
  pacing for all frames and during transitions, import cost, anomaly counts and
  the first anomalies;
- `timeline.jsonl`: the same `frame` and `clock` lines as the visual trace,
  plus `marker`, `inspect` and `anomaly` lines;
- `anomaly-NN-{before,frame,after}-seqNNNNNN.ppm`: frame dumps.

### Scenes

All scenes are in `lab/scenes/` and use only `lab.js` and browser APIs.

| Scene                        | What it exercises                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opacity-basic`              | one box, opacity 0 to 1 and back, resting value different from the end value, like WebKit's damage tests                                                              |
| `crossfade`                  | the Runtime stage crossfade exactly: two layers, black backdrops, z-index, inline pin, WAAPI fade with `fill: both`, `visible`, cleanup in one task, outgoing release |
| `crossfade-cleanup-variants` | the same, with one completion step changed (see `lab/scenes/crossfade.js`)                                                                                            |
| `transform-3d`               | a perspective push with no opacity change; variants `preserve-3d` and `cross-camera`                                                                                  |
| `startup-minimal`            | the startup reveal: pulse, settle, mark recede, perspective card push, white sheet, resolve fade, removal                                                             |
| `video-crossfade`            | the crossfade with `<video>` content (DMA-BUF external textures on hardware)                                                                                          |

`crossfade-cleanup-variants` variants: `retain-animation`, `keep-pin`,
`no-pin`, `commit-final`, `outgoing-1f`, `outgoing-2f`, `keep-outgoing`,
`image`, `busy-end`. Every scene has `busy-end`. It blocks the main thread for
120 ms around the end of the animation, so a compositor that shows a wrong
value after the end shows it for many frames.

These variants are experiments. They are not product changes.

`video-crossfade` needs `lab/scenes/media/lab-a.mp4` and `lab-b.mp4`.
`lab/make-media.sh` makes them with ffmpeg. The repository does not hold them.

### Frame detector

The scene declares its colors and sends markers. For each presented buffer the
lab imports the pixels (`wpe_buffer_import_to_pixels()`), samples a grid of
3x3 means in the probe rectangle, and gives the samples to
`lab/lab-detector.c`:

| Verdict      | Rule                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------- |
| `reversal`   | a point moved back along the declared color path by more than 0.35: the old state came back |
| `foreign`    | a point is more than 40 RGB units from the path: for example a black backdrop flashed       |
| `nonuniform` | points that move together differ by more than 0.25 of the path: part of the frame is stale  |
| `unsettled`  | two frames after `settled`, a point is not the settled color                                |

Markers arrive over IPC and can come one frame late. The rules allow this.

`--inspect=transitions` imports buffers only while a rule applies.
`--inspect=all` imports every buffer. `--inspect=off` imports none and is the
setting for pacing measurements. An import runs in the `buffer-rendered`
handler on the main thread. `summary.json` reports its median, p95 and maximum
time, because the import is part of what the lab measures.

### WPE buffer or physical output

The lab inspects the buffer that WPE presents. On DRM, WPEPlatform emits
`buffer-rendered` from the page-flip handler, after the buffer is on scanout.
Use this table:

| Lab result in the WPE buffer                            | Screen or camera              | Where the defect is                                                                        |
| ------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| anomaly                                                 | flash                         | WebKit composition: Skia layer state, damage, tiles                                        |
| no anomaly                                              | flash                         | below WebCore: WPEPlatform DRM page flips, buffer release and reuse, modifiers, the driver |
| anomaly with `busy-end` only                            | flash during busy main thread | compositor state while the main thread is late                                             |
| anomaly in `video-crossfade` only                       | flash with video only         | video frames and external textures                                                         |
| anomaly with one cleanup variant only                   | flash                         | the completion step that the variant changes                                               |
| no anomaly, Runtime trace shows a wrong order of events | flash                         | the Runtime or its JavaScript and WAAPI state                                              |

A camera at a high frame rate confirms what the panel shows.

### Frame pacing

`summary.json` has `pacing` (all presentations) and `pacingDuringTransitions`:
frames, mean, median, p95, p99 and maximum interval, frames per second, long
frames (over 1.5 display intervals) and an estimate of missed display
intervals. Run the same scene with `--inspect=off` for Skia and for
TextureMapper to compare smoothness. A fix must keep the Skia pacing.

## Experiment matrix

`diagnostics/compositor-matrix.json` defines the configurations. Each one
changes one variable from the Skia default. Combine variables only after the
single-variable runs show what each one changes.

| Variable                               | Values        | Read by (2.54.0)                                                                         |
| -------------------------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `WEBKIT_USE_SKIA_FOR_COMPOSITION`      | `0`           | `DrawingAreaCoordinatedGraphicsGLib.cpp`: TextureMapper                                  |
| `WEBKIT_SKIA_ENABLE_CPU_RENDERING`     | `1`           | `WebProcessGLib.cpp`: no accelerated buffers                                             |
| `WEBKIT_SHOW_DAMAGE`                   | `1`           | `ThreadedCompositor.cpp`: damage overlay (changes pixels)                                |
| `WEBKIT_SHOW_FPS`                      | `1` (seconds) | `ThreadedCompositor.cpp`: FPS in the console                                             |
| `WEBKIT_SKIA_GPU_PAINTING_THREADS`     | 1 to 4        | `SkiaPaintingEngine.cpp`                                                                 |
| `WEBKIT_SKIA_CPU_PAINTING_THREADS`     | 1 to 8        | `SkiaPaintingEngine.cpp`, with CPU rendering                                             |
| `WEBKIT_SKIA_USE_LINEAR_TILE_TEXTURES` | `1`           | `SkiaPaintingEngine.cpp`                                                                 |
| `WEBKIT_DISABLE_DMABUF_ATLAS`          | `1`           | `SkiaPaintingEngine.cpp`                                                                 |
| `WPE_BUFFER_FORMAT`                    | `XR24:0`      | `WPEToplevel.cpp`: fourcc, modifier, usage. 2.54 name of the old DMA-BUF format variable |
| `WEBKIT_FORCE_VBLANK_TIMER`            | `1`           | `DisplayVBlankMonitor.cpp`: timer instead of DRM vblank                                  |
| `WPE_DRM_DISABLE_ATOMIC`               | `1`           | `WPEDisplayDRM.cpp`: legacy page flips                                                   |
| `WPE_USE_EXPLICIT_SYNC`                | `0`           | `WPEDisplay.cpp`                                                                         |
| `WEBKIT_DEBUG`                         | channel list  | WebKit logging channels                                                                  |

Presets:

- `baseline`: Skia, TextureMapper, Skia CPU, Skia with `WEBKIT_SHOW_DAMAGE`,
  Skia with `WEBKIT_SHOW_FPS`. The damage overlay changes the presented pixels,
  so that run has inspection off. Watch it or film it.
- `versions`: Skia, TextureMapper, Skia CPU, for each WPE build given with
  `--wpe`.
- `extended`: the other variables, one at a time.

Each lab run writes `run.json` with the variables it requested, the variables
that the lab and its web process really had, and the compositor that those
variables mean (see [Environment integrity](#environment-integrity)). A run
whose environment is not the profile's is not counted.

## Testing another WPE build on a screen

Tilecast pins WPE WebKit in `apps/edge/release/build-wpe.sh`. A release
carries WebKit under `/opt/tilecast-edge/current/lib/wpe`. WebKit compiles the
paths of its helper processes in, so the prefix is fixed.

### Build

On a computer with Docker and the same architecture as the screen:

```sh
apps/edge/renderer-wpe/diagnostics/wpe-local.sh --label wpe-2.54.3 \
  --version 2.54.3 --sha256 787afd32ae23eac061621465390f44a462e874a9ebaba0b65521d7237fa8a5e4
apps/edge/renderer-wpe/diagnostics/wpe-local.sh --label wpe-2.54.0 --release-pin
apps/edge/renderer-wpe/diagnostics/wpe-local.sh --label webkit-fix --webkit ~/src/WebKit
```

The script runs `build-wpe-local.sh` in the release builder image
(`Dockerfile.builder`):

- `wpe_build_flags.py` reads the `-D` flags from `build-wpe.sh`. That file
  stays the only place where the flags are written. The script is not changed
  for this, so the WPE inputs key and the published prebuilds do not change.
- A tarball build checks the SHA-256. A checkout build records the commit, the
  number of modified files and the SHA-256 of `git diff`.
- The build directory is in the Docker volume `tilecast-wpe-local`, one for
  each label. A second build of a patched checkout is incremental.
- `pack_wpe_overlay.py` uses `copy_wpe()` of `stage-release.py`, so the overlay
  has the same files as a release: one file for each library under its SONAME,
  and no symbolic links, headers or pkg-config files.
- The lab is built against the same WPE, with the runtime path
  `/opt/tilecast-edge/current/lib/wpe/lib`.

Outputs: `wpe-overlay-<label>-<arch>.tar`, its `.sha256`, and
`tilecast-wpe-lab-<arch>.tar`.

### Install and restore

```sh
sudo python3 -I tilecast_wpe_debug.py overlay install wpe-overlay-wpe-2.54.3-x86_64.tar --sha256 <hash>
sudo python3 -I tilecast_wpe_debug.py overlay status
sudo python3 -I tilecast_wpe_debug.py overlay restore
```

`overlay install` does these steps:

1. It refuses while an Edge update is provisional.
2. It checks the archive: only files and directories under `wpe/`, no `..`, no
   links, the architecture of the screen, and the SHA-256 of every file against
   the manifest.
3. It copies the release's `lib/wpe` to
   `/var/lib/tilecast-wpe-debug/overlays/<label>/wpe` and puts the build over
   it. Libraries that the release carries for itself, such as
   `libwpe-1.0.so.1`, stay.
4. It writes `zz-tilecast-wpe-overlay.conf` for `tilecast-renderer.service` and
   `tilecast-web-renderer.service` in `/run/systemd/system`. The drop-in has
   one line: `BindReadOnlyPaths=<overlay>:/opt/tilecast-edge/current/lib/wpe`.
5. It restarts the units. Then it reads the overlay manifest through
   `/proc/<pid>/root` and compares the SHA-256 of the mapped
   `libWPEWebKit-2.0.so.1` with the manifest. If they differ, it stops with an
   error.

`overlay restore` removes the drop-ins, restarts the units, and compares the
mapped library with the release's file.

Why this mechanism is correct:

- The installed release is never written. The bind mount exists only in the
  mount namespaces of the two units. The release directory, its signed manifest
  and the update helper see the original files.
- systemd resolves the symbolic link `current` and mounts on the release's real
  `lib/wpe` directory. The renderer's `RUNPATH` is `$ORIGIN/../lib/wpe/lib`, and
  the loader resolves `$ORIGIN` from the real path of the binary. Both paths
  reach the same mounted directory.
- WebKit starts `WPEWebProcess` and `WPENetworkProcess` from the compiled
  prefix `/opt/tilecast-edge/current/lib/wpe/libexec`. The process sees the
  overlay at that path.
- bubblewrap runs inside the unit's mount namespace. It binds the WebKit paths
  that it finds there, so the sandboxed processes use the overlay too. The
  overlay does not change the sandbox, and the drop-in adds no sandbox
  setting.
- `/run/systemd/system` is cleared at boot. The update helper reads only its
  known drop-in paths in `/etc/systemd/system`.

Do not start an Edge update while an overlay is installed. If one starts,
reboot the screen: the reboot removes the overlay.

`overlay purge` is not needed: an overlay directory is inactive without its
drop-in. Delete `/var/lib/tilecast-wpe-debug` to remove all diagnostics files.

### Patch WebKit and test again

1. Make the change in a WebKit checkout at the tag of the screen's version.
   Add the LayoutTest first.
2. Run `wpe-local.sh --label webkit-fix --webkit <checkout>`. The build is
   incremental after the first one.
3. Copy the overlay and the field tool to the screen. Run `overlay install`.
4. Run the same lab scenes with `lab matrix --wpe release,webkit-fix`.
5. Run `overlay restore`.

Do not keep a WebKit fork in this repository. A fix goes upstream. A Tilecast
release takes it through a WPE version change.

## Environment integrity

An experiment is only true for the environment that reaches the WebKit
processes. systemd can add compositor variables that the tool did not set: the
unit's own `Environment=`, any drop-in in `/etc/systemd/system` or
`/run/systemd/system`, an `EnvironmentFile=`, or the environment of the service
manager. A debug override in `/etc` with `WEBKIT_USE_SKIA_FOR_COMPOSITION=0`
would make a "Skia" run use TextureMapper and put the Skia label on the result.
So the tool never labels a run from what it requested. It reads what reaches
the process.

### Doctor

```sh
sudo python3 -I tilecast_wpe_debug.py doctor
sudo python3 -I tilecast_wpe_debug.py doctor --json
```

`doctor` changes nothing. It reads `systemctl show` of the renderer unit
(`Environment`, `EnvironmentFiles`, `DropInPaths`, `FragmentPath`,
`UnsetEnvironment`, `ExecStart`), `systemctl show-environment`, and each file
that these name. It reports:

- every compositor variable that something other than this tool sets, with its
  value and the file or manager that sets it, and what the renderer would run
  as with it (`BLOCK`);
- the renderer's live environment and its web process's, read from
  `/proc/<pid>/environ` (run as root), the compositor those variables mean,
  and any difference from the unit configuration (a renderer that started
  before a configuration change);
- whether a diagnostic Tilecast overlay is active, with its git commit, and
  whether the running binary and Runtime match it;
- whether `trace enable` can run (see
  [Diagnostic Tilecast overlay](#diagnostic-tilecast-overlay));
- an Edge update that is provisional, a WPE overlay, and an `ExecStart` that
  this tool will not copy.

The exit status is 1 when a `BLOCK` line exists. The `doctor` data is also in
the [field bundle](#field-bundle).

### Rules

1. **Before the start.** `trace enable` finds every allowlisted variable that
   the unit gets from another source. If the profile does not set it, the tool
   refuses and names the variable, the value and the source. With
   `--clear-inherited` it adds `UnsetEnvironment=` for those names to its own
   drop-in. systemd applies `UnsetEnvironment=` after every `Environment=`, so
   only the profile is left.
2. **Order.** The tool's drop-ins are named `zz-tilecast-*.conf`. systemd reads
   drop-ins in file name order and the last assignment wins, so no other drop-in
   overrides the profile. The rule 3 check still applies.
3. **After the start.** The tool reads `/proc/<pid>/environ` of the renderer
   and of its `WPEWebProcess`, which runs the compositor, and compares the
   allowlisted variables with the profile. A variable that is missing, extra or
   different is a mismatch. A web process that does not appear in 30 s is
   "unverified" and also refused. On a mismatch the tool removes its drop-in,
   restarts the renderer, and prints the differences. No trace is kept.
4. **Lab.** The lab runs in a transient unit that sets the profile and
   `UnsetEnvironment=` for every other allowlisted variable. While it runs, the
   tool reads the lab's environment and its web process's. A mismatch stops
   the lab, and the run (and a matrix) ends with the differences. The run's
   `run.json` keeps them.
5. **Records.** `trace-meta.json` (written by `trace enable`, copied by
   `trace collect`) and `run.json` hold `requestedEnv`, `requestedCompositor`,
   the observed variables of both processes, `observedCompositor`, and whether
   they match. The trace header has `env`, the variables that the renderer
   process itself sees.

The compositor name comes from the WebKit 2.54 source. Skia compositing is off
only for `WEBKIT_USE_SKIA_FOR_COMPOSITION` exactly `0`
(`DrawingAreaCoordinatedGraphicsGLib.cpp`). Accelerated buffers are off when
`WEBKIT_SKIA_ENABLE_CPU_RENDERING` is set to anything but `0`
(`WebProcessGLib.cpp`). So `1` for the first variable is still Skia, and the
tool says so.

`/proc/<pid>/environ` shows the environment at the start of the process. The
renderer sets none of the allowlisted variables itself.

## Diagnostic Tilecast overlay

A release from before #1946 has no `--visual-trace` option in its renderer and
no trace sink in its Runtime. `trace enable` reads the renderer binary and the
Runtime directory the unit would use. If either has no trace support, it
refuses and does not write a drop-in. To trace the real Runtime on such a
screen, install a diagnostic Tilecast overlay: the instrumented
`tilecast-renderer-wpe` and the exact assembled Runtime and bridge of a git
commit. The lab does not need it. It runs on the unmodified release.

### Build

On a computer with Docker and the same architecture as the screen, in the
checkout you want to run:

```sh
apps/edge/renderer-wpe/diagnostics/wpe-local.sh --label wpe-2.54.0 --release-pin --runtime-overlay-only
```

Use `--release-pin` so the renderer is built against the WPE that the screen
runs. `--runtime-overlay` builds the WPE overlay and the lab as well. The
script builds the Player Runtime first. Then `build-runtime-overlay.sh`:

- refuses a Runtime build that is older than its sources;
- builds `tilecast-renderer-wpe` with the flags of `build-edge-release.sh`
  (`Release`, the `$ORIGIN/../lib/wpe/lib` runtime path) and runs its `ctest`.
  It checks that the renderer still clears
  `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS`. The overlay does not weaken the
  sandbox;
- compiles the git commit into the renderer (`TILECAST_BUILD_COMMIT`), and the
  trace header repeats it as `buildCommit`;
- runs `assemble-runtime.sh`, which checks the Runtime against its manifest
  and adds `tilecast-bridge.js`, `tilecast-native-relay.js` and
  `tilecast-visual-trace.js`;
- packs `tilecast-runtime-overlay-<label>-<arch>.tar` and its `.sha256`.
  The manifest has the full commit, the number of modified files and the
  SHA-256 of the diff (and of new files), the renderer SHA-256, and the
  SHA-256 of every Runtime file. `<label>` is `tc-` and the first 12 digits of
  the commit, with `-dirty` when files are modified.

`runtime_overlay.py pack` refuses a renderer without `--visual-trace`, a binary
that does not carry the commit, and a Runtime without the sink.

The overlay replaces the renderer and the Runtime as a whole. The installed
tilecastd and the Server keep the release's version. Build the overlay from the
release's own commit plus the diagnostics commits, not from a newer `main`:

```sh
git worktree add ../tilecast-diag <release commit>
git -C ../tilecast-diag cherry-pick <the #1946 commits>
```

A newer Runtime or renderer can use a protocol or a presentation contract that
the installed daemon and Server do not have.

### Install and restore

```sh
sudo python3 -I tilecast_wpe_debug.py runtime-overlay install tilecast-runtime-overlay-tc-<commit>-x86_64.tar --sha256 <hash>
sudo python3 -I tilecast_wpe_debug.py runtime-overlay status
sudo python3 -I tilecast_wpe_debug.py runtime-overlay restore
```

`runtime-overlay install` does these steps:

1. It refuses while an Edge update is provisional.
2. It checks the archive: only files under `runtime/`, no links, no `..`, the
   architecture of the screen, the SHA-256 of every file against the manifest,
   a renderer that has `--visual-trace` and carries the manifest's commit, and a
   Runtime that matches its own manifest and has the trace sink.
3. It writes the files to `/var/lib/tilecast-wpe-debug/runtime-overlays/<label>`.
4. It writes `zz-tilecast-runtime-overlay.conf` for `tilecast-renderer.service`
   only, in `/run/systemd/system`. The drop-in has two lines:
   `BindReadOnlyPaths=<overlay>/bin/tilecast-renderer-wpe:/opt/tilecast-edge/current/bin/tilecast-renderer-wpe`
   and
   `BindReadOnlyPaths=<overlay>/renderer-web:/opt/tilecast-edge/current/share/tilecast/renderer-web`.
5. It restarts the renderer. Then it reads `/proc/<pid>/exe` and compares its
   SHA-256 with the manifest. It compares every file of the Runtime directory
   as the process sees it (through `/proc/<pid>/root`) with the manifest, with
   no file added or missing. It waits 6 s and checks that the renderer is
   still the same process.
6. If one check fails, it removes the drop-in, restarts the renderer and stops
   with the differences.

`runtime-overlay restore` removes the drop-in, restarts the renderer, and
compares the running binary and Runtime with the signed release manifest
(`tilecast-edge-release.json`). `runtime-overlay status` prints the commit and
whether the running process matches.

Why this is safe:

- `/opt/tilecast-edge/<release>` is never written. The mounts exist only in the
  mount namespace of the renderer unit. The release, its signed manifest and the
  update helper see the original files.
- The drop-in is in `/run`. A reboot clears it, so the signed release starts
  again. The overlay files stay in `/var/lib/tilecast-wpe-debug` and are
  inactive.
- `ExecStart` does not change. The unit's sandbox settings do not change, and
  the renderer still starts WebKit's bubblewrap sandbox.
- The renderer finds its libraries through `$ORIGIN/../lib/wpe/lib`. A mounted
  file keeps the path of its mount point, so the overlay renderer loads the
  release's WPE, or a WPE overlay that is also installed.
- The web helper (`tilecast-web-renderer.service`) is not changed.

`trace enable` uses the active overlay. It checks it again before the restart,
and reads the running binary and Runtime again after it. Do not start an Edge
update while an overlay is installed. If one starts, reboot the screen.

## Field procedure on the affected screen

Before you start, copy `apps/edge/renderer-wpe/diagnostics/` to the screen.
On a computer, build for x86_64 the lab and the 2.54.3 WPE overlay (see
above) and the diagnostic Tilecast overlay of the checkout that matches the
screen's release (see [Diagnostic Tilecast overlay](#diagnostic-tilecast-overlay)).

1. Check the screen: `sudo python3 -I tilecast_wpe_debug.py doctor`. Keep the
   output. Remove every `BLOCK` cause, or plan to use `--clear-inherited`.
   An override in `/etc` that sets a compositor variable is the usual one.
2. Install the lab: `lab install tilecast-wpe-lab-x86_64.tar`. The lab runs on
   the installed release. It does not need an overlay.
3. Run the lab baseline on the release WPE:
   `lab matrix --preset baseline --iterations 30`. The renderer stops for the
   run and starts again after it. Each row names the compositor that the lab
   really ran.
4. Run the lab with the main thread blocked:
   `lab run --scene crossfade-cleanup-variants --variant busy-end --iterations 20`,
   then the same with `--variant busy-end:no-pin`.
5. Install the diagnostic Tilecast overlay:
   `runtime-overlay install tilecast-runtime-overlay-tc-<commit>-x86_64.tar`.
   Run `doctor` again. It must say that real-Runtime tracing is possible and
   name the commit.
6. Trace the real Runtime with Skia. Run `trace enable --seconds 180`. Watch
   one startup (the trace restarts the renderer) and at least ten crossfades.
   Film the screen. Run `trace collect --out trace-skia`. Run `trace disable`.
7. Repeat step 6 with `--env WEBKIT_USE_SKIA_FOR_COMPOSITION=0`
   (`trace-texturemapper`). Check that the tool prints
   `compositor as the processes see it: texturemapper`.
8. Install the 2.54.3 WPE overlay: `overlay install wpe-overlay-wpe-2.54.3-x86_64.tar`.
9. Run the version matrix:
   `lab matrix --preset versions --wpe release,wpe-2.54.3 --iterations 30`.
10. With both overlays installed, repeat step 6 (`trace-skia-2.54.3`). Watch
    the startup and the crossfades on the screen.
11. Restore: `overlay restore`, then `runtime-overlay restore`, then `doctor`.
    A reboot also restores the signed release.
12. Make the bundle:
    `bundle --out graphics.tar.gz --trace --results /var/lib/tilecast-wpe-debug/results/<run> ...`.
13. On a computer, run `visual_trace_report.py` on each trace. Compare the
    `end-window` frames with the film.

Expected results if the leading hypothesis is correct:

- step 6: `end-window` frames at each crossfade end and at the startup push
  and resolve ends, at the same times as the flashes in the film;
- steps 3 and 4: `reversal` anomalies with Skia on the release WPE, and none
  with TextureMapper;
- steps 9 and 10: no anomaly and no flash with 2.54.3 and Skia.

If 2.54.3 removes the defect, merge the 2.54.3 pin (a separate change) and
remove nothing else. If it does not, the bundle shows if the presented WPE
buffer has the wrong picture.

## Field bundle

`tilecast_wpe_debug.py bundle --out FILE.tar.gz` collects:

- the Tilecast Edge version, the release's WPE version and the base
  distribution, from `tilecast-edge-release.json`;
- the kernel version, the architecture, the CPU model and count;
- DRM cards (driver, PCI vendor and device IDs) and connectors (status, modes)
  from sysfs, and the output of `tilecast-renderer-wpe --probe-drm`;
- the versions of the Mesa, libdrm, GStreamer, VA-API and bubblewrap packages;
- `NRestarts`, memory and state of the renderer unit;
- the `doctor` data: unit, drop-ins, compositor variables that other
  configuration sets, the environment of the live renderer and its web
  process, the compositor it means, and the running binary and Runtime checks;
- the compositor variables, WPE overlays and diagnostic Tilecast overlays that
  this tool set, with the Tilecast git commit of an active diagnostic overlay;
- with `--results`: `summary.json`, `timeline.jsonl`, `run.json` and the
  anomaly dumps of the given lab runs;
- with `--trace`: the visual traces and `trace-meta.json` (requested and
  observed environment, Tilecast commit, renderer and Runtime hashes, WPE
  overlay);
- with `--renderer-log`: the current boot's renderer journal, sanitized.

It does not collect credentials, Server addresses, screen, player or manifest
IDs, file names, content, EDID, the host name or other journals. The GL
renderer string is not collected, because no EGL context is created for it.

`--renderer-log` passes the journal through `sanitize_log.py`. Then it checks
the result for the same patterns and for the screen's host name, machine ID
and addresses. If it finds one, it stops and does not include the log.

## Web Inspector

The renderer never enables Web Inspector or developer extras. Only the lab
accepts `--inspector=127.0.0.1:PORT` (or `[::1]:PORT`, ports 1024 to 65535). It
sets `WEBKIT_INSPECTOR_HTTP_SERVER` and enables developer extras for the lab
view only. Anyone who can connect to that port controls the page. Reach it
from another computer through an SSH tunnel:
`ssh -L 9222:127.0.0.1:9222 <screen>`. Do not use another address.

## Upstream reproducer

If a scene reproduces a defect on the newest 2.54 release with Skia:

1. Reduce the scene. Remove `lab.js` and keep only the elements, styles and
   animation calls that are necessary. `opacity-basic` and `transform-3d` are
   already near the size of a test in `LayoutTests/platform/glib/damage/`.
2. Write the report with these fields: expected, actual, WPE version and
   WebKit commit, hardware and DRM driver, results with Skia, TextureMapper,
   Skia CPU and `WEBKIT_SHOW_DAMAGE`, and the reproduction rate from
   `summary.json`.
3. Add the failing LayoutTest first, in the style of bug 316045 and bug 321993. Then fix the natural owner, run the GLib and WPE tests, and test the
   patched build on the same screen with an overlay.

## Tests

| Test                                                                 | Covers                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctest` in `apps/edge/renderer-wpe` (`lab-detector`)                 | detector rules, sampling, channel order, PPM output                                                                                                                                                                                                                                                                                                                                      |
| `ctest` (`visual-trace-format`)                                      | trace file bounds, record checks, environment, pacing                                                                                                                                                                                                                                                                                                                                    |
| `python3 -m unittest discover -s apps/edge/renderer-wpe/diagnostics` | build flags, allowlist parity, drop-ins, archive checks, overlay round trips, sanitizer, bundle facts, trace report; a fake systemd and `/proc` for environment integrity (an inherited TextureMapper is not reported as Skia, a missing or unobserved web process is refused) and for the diagnostic Tilecast overlay (trace refuses without it, restore and reboot return the release) |
| headless lab run of each scene                                       | the lab and the scenes on a real engine                                                                                                                                                                                                                                                                                                                                                  |

A headless pass does not prove that a DRM screen is correct. The headless
platform uses shared-memory buffers. The test images use Debian's WPE, which
can be a different 2.54 release than the pinned one.

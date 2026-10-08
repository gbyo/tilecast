# Tilecast Edge M11: remote web frame transport spike

**Status: completed 2026-09-26 technical spike.** The recorded transport architecture was feasible in the tested environment; this is not a current qualification result for production GPUs, displays, or Edge releases. The binding current security contract is [the remote-web threat review](../../tilecast-edge-remote-web-threat-review.md).
**Date:** 2026-09-26
**Scope:** Phase 0 of the M11 remote web work. This record comes before the contracts in [`tilecast-edge-remote-web-threat-review.md`](../../tilecast-edge-remote-web-threat-review.md).
**Code:** [`apps/edge/web-renderer-wpe/spike/`](../../../apps/edge/web-renderer-wpe/spike/)

## 1. Question

Can an untrusted web page render in a separate process, off screen, and appear as a normal compositable surface inside the trusted Player Runtime document? The transport must use FD-backed buffers. It must not use per-frame CPU screenshots, a second visible WPE view, an iframe, a custom WPEPlatform backend or a custom compositor.

## 2. Design under test

```text
producer (untrusted process)                trusted process
WPE headless WPEView                        WPE WebView, bubblewrap sandbox
  WPEView::buffer-rendered                    <video src="tcweb://cap/<64 hex>">
  WPEBufferSHM | WPEBufferDMABuf                playbin → tcwebsrc (bin)
        │                                              │
  appsrc → leaky queue(1) → unixfdsink ── AF_UNIX ── unixfdsrc
                               SCM_RIGHTS: memfd or DMA-BUF fds
```

- The producer uses only public WPEPlatform API: `wpe_display_headless_new()`, a toplevel of the requested size and the `WPEView::buffer-rendered` signal.
- `buffer-rendered` gives the committed `WPEBuffer`. It is a `WPEBufferDMABuf` (fd, offset, stride, DRM fourcc and modifier per plane) when the display has a DRM render node. It is a `WPEBufferSHM` (mapped `GBytes`, no fd) otherwise.
- The trusted side registers the `tcweb` URI protocol with a small GStreamer bin (`tcwebsrc`) around `unixfdsrc`. `WEBKIT_GST_ALLOWED_URI_PROTOCOLS=tcweb` lets the media element use it. This is the same pattern as the existing `tcmediasrc`.
- The capability in the URI is the only input of `tcwebsrc`. It selects `<frames dir>/<capability>.sock`. The page never sees a path.

## 3. Results

Environment: Debian sid image `tilecast-edge-dev`, WPE WebKit 2.54.0, GStreamer 1.28.7, Mesa 26.2.3 llvmpipe, arm64 Linux 6.8 VM without a GPU. The trusted WebKit sandbox (bubblewrap) was on.

| Spike requirement                                          | Result                                                                                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Isolated off-screen WebView outside the trusted process | Proven. The producer is a separate process with its own WebKit processes.                                                                                 |
| 2. Deterministic local HTTP page                           | Proven. `www/remote.html` (CSS animation and a counter) and `www/remote2.html` (canvas animation), served on loopback.                                    |
| 3. Composited buffers from WPE                             | Proven. `buffer-rendered` delivers each committed frame.                                                                                                  |
| 4. GPU-backed path where available                         | API proven, hardware not available here (§4).                                                                                                             |
| 5. FD-backed transport to another process                  | Proven. `unixfdsink` sends memfd buffers with `SCM_RIGHTS`.                                                                                               |
| 6. Standard `unixfdsink` and `unixfdsrc`                   | Proven. No custom FD protocol.                                                                                                                            |
| 7. Received frames as a compositable media surface         | Proven. `<video>` in the trusted page, with `border-radius` clipping and a CSS rotation.                                                                  |
| 8. Two surfaces at different sizes in one canvas           | Proven. 1280×720 and 400×300 streams in one 1280×720 page (`composited.png`).                                                                             |
| 9. Animation, not only a first frame                       | Proven. About 60 frames per second on each surface (`requestVideoFrameCallback`).                                                                         |
| 10. Producer crash does not affect the trusted runtime     | Proven. After `SIGKILL` of one producer, its `<video>` fires `error` (code 4) and the other surface continues. The trusted web process is not terminated. |
| 11. Measurements                                           | §3.1.                                                                                                                                                     |
| 12. Release environment has the unixfd plugin              | Proven by package: Debian 13 `gstreamer1.0-plugins-bad` (1.26) ships `libgstunixfd.so`, added in GStreamer 1.24. The release uses the system GStreamer.   |

### 3.1 Measurements (SHM path, software GL)

| Measurement                                                                      | Value                                                                       |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| First frame on the trusted page after the producer is ready                      | 125 to 271 ms                                                               |
| Frame latency, producer `buffer-rendered` to trusted `requestVideoFrameCallback` | p50 28 to 29 ms, p95 39 to 41 ms, max 47 ms (4 windows of about 180 frames) |
| Producer UI process RSS                                                          | 150 MB (static page), 171 MB (animated 720p)                                |
| Producer web process RSS                                                         | 308 MB (static), 327 MB (animated)                                          |
| Producer network process RSS                                                     | 77 MB                                                                       |
| Trusted web process RSS, blank page                                              | 297 MB                                                                      |
| Trusted web process RSS, one 720p surface                                        | 395 MB (static source), 438 MB (animated source)                            |
| Producer UI process CPU, animated 720p at 60 fps                                 | 4.7 % of one core (one memcpy per frame)                                    |
| Producer web process CPU, animated 720p                                          | 18 % (llvmpipe)                                                             |
| Trusted web process CPU, animated 720p surface                                   | 233 % (llvmpipe upload and composition at 60 fps)                           |
| Trusted web process CPU, static source                                           | below 1 % after start; the 1 Hz repeat frame costs almost nothing           |
| Trusted web process file descriptors                                             | 31 to 43 with one surface                                                   |
| 240 create and destroy cycles of a surface                                       | fds 39 → 35, threads 35 → 32, RSS 400 → 407 MB, producer clients back to 0  |

RSS includes shared libraries, so the per-process values overlap. CPU values are lifetime averages from `ps`.

### 3.2 Copies

| Path                     | Copies per frame                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| No GPU (SHM, this spike) | 1 CPU copy in the helper (WebKit SHM into a memfd buffer). The trusted GL sink then uploads the frame, which is a second CPU copy under llvmpipe. |
| GPU (DMA-BUF, design)    | 1 GPU blit in the helper into a helper-owned buffer. The trusted GL sink imports the DMA-BUF as an EGL image, with no copy.                       |

No path uses CPU readback of a GPU frame, image encoding, base64 or JavaScript frame transport.

## 4. The accelerated path

This VM has no DRM render node. WebKit therefore renders with llvmpipe and gives SHM buffers. The accelerated path cannot run here, and GitHub runners have no GPU either. These facts come from the WPE WebKit 2.54.0 source and the image:

- `WPEDisplayHeadless` opens a GBM EGL display on the DRM render node when one exists (`WPEDisplayHeadless.cpp`). WebKit then creates DMA-BUF buffers (`AcceleratedBackingStore::didCreateDMABufBuffer`).
- The trusted GL video sink adds `memory:DMABuf` caps when a GBM render node exists (`GLVideoSinkGStreamer.cpp`). A DMA-BUF stream from `unixfdsrc` therefore stays zero-copy on the trusted side.
- Mesa llvmpipe on surfaceless EGL has `EGL_EXT_image_dma_buf_import`, `EGL_EXT_image_dma_buf_import_modifiers`, `EGL_MESA_image_dma_buf_export` and `EGL_ANDROID_native_fence_sync`. The VM kernel has `/dev/udmabuf`. CI can therefore run the helper's GPU exporter code with udmabuf-backed buffers.

A zero-copy export of WebKit's own DMA-BUF is not correct. The headless view releases the previous buffer at the next frame, and WebKit can render into it again about two frames later. A consumer that still samples it can show a torn frame. `unixfdsink` tracks the consumer's release of each buffer, but WebKit does not wait for that release. The helper must therefore copy each frame, with one GPU blit, into a buffer that the helper owns and that returns to its pool only when the consumer releases it. The blit waits for the WebKit rendering fence, and the helper waits for the blit fence before the buffer is sent.

The physical M11 qualification must confirm the DMA-BUF path, the copy count and the absence of tearing on each reference GPU.

## 5. Consequences for the implementation

1. The frame transport is `unixfdsink` in the helper and `tcwebsrc` (a bin around `unixfdsrc`) in the trusted renderer.
2. Frame sockets are `<frames dir>/<capability>.sock`. A capability is 64 lowercase hexadecimal characters from a CSPRNG.
3. The helper sends the latest frame only (a leaky queue of one). It repeats the last frame once a second when the page is idle, so the trusted side can tell a live static page from a stalled stream.
4. A producer failure reaches the trusted page as a media `error` event. The runtime maps it to the existing Website failure path.
5. Without a GPU, a 60 fps animated page costs more than two cores in the trusted process. The helper limits the frame rate on the software path (§14 of the threat review).
6. The GPU exporter copies once into helper-owned buffers (§4).

## 6. Reproduce

```sh
docker run -d --privileged --name tc-spike -v "$PWD:/src" tilecast-edge-dev sleep infinity
docker exec tc-spike /src/apps/edge/web-renderer-wpe/spike/build.sh
docker exec tc-spike /src/apps/edge/web-renderer-wpe/spike/run.sh
docker exec -e KILL_A_AFTER=5 tc-spike /src/apps/edge/web-renderer-wpe/spike/run.sh
docker exec tc-spike /src/apps/edge/web-renderer-wpe/spike/measure.sh latency.html 14
docker exec tc-spike /src/apps/edge/web-renderer-wpe/spike/cycle.sh
```

`--privileged` lets the trusted WebKit sandbox create its namespaces, so the run also proves that the sandbox can reach the frame socket directory.

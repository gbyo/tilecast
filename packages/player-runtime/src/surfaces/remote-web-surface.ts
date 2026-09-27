/**
 * The one remote web surface for `remoteWeb: "host-view"` hosts: a Website,
 * a web Widget or YouTube, at the root of a presentation or inside a Layout
 * zone.
 *
 * The page runs in the host's isolated remote web process. The host returns
 * a render target:
 *   - `media-uri`: the runtime shows the stream in its own <video>, so Layout
 *     clipping, z-order, transitions, transforms and preview capture work
 *     exactly as for other media;
 *   - `host-layer`: the host shows its own view at the viewport this surface
 *     reports. The runtime keeps a transparent placeholder in its layout.
 *
 * Policy stays here, on the runtime clock: the load timeout, interval
 * reloads, fallback, completion and evidence. The host only reports what its
 * page did.
 */
import type {
  RemoteWebEventV1,
  RemoteWebViewportV1,
  RuntimeRemoteWebSpecV1,
} from "../host/contract";
import { TimerGroup } from "../clock/scheduler";
import type { RemoteWebPort } from "../remote-web/port";
import { YOUTUBE_MIN_EDGE, normalizeFailureBehavior } from "../remote-web/spec";
import type { MediaSurface, SurfaceEnvironment } from "./surface";
import { showFallbackImage, showWebsitePlaceholder } from "./website-failure";

/** A media-URI stream that shows no frame this long has stalled. The host
 * repeats the last frame of a still page every second. */
export const STREAM_STALL_MS = 5_000;
const MAX_EDGE = 3840;
const MIN_EDGE = 16;

export interface RemoteWebSurfaceOptions {
  spec: RuntimeRemoteWebSpecV1;
  audioEnabled: boolean;
  port: RemoteWebPort;
  env: SurfaceEnvironment;
}

export class HostRemoteWebSurface implements MediaSurface {
  readonly element: HTMLDivElement;
  private readonly spec: RuntimeRemoteWebSpecV1;
  private readonly env: SurfaceEnvironment;
  private readonly port: RemoteWebPort;
  private readonly audioEnabled: boolean;
  private readonly timers: TimerGroup;
  private readonly loadTimer: TimerGroup;
  private readonly key: string;
  private surfaceId: string | null = null;
  private video: HTMLVideoElement | null = null;
  private targetUri: string | null = null;
  private sourceReady = false;
  private hostLayer = false;
  private frameCallback: number | null = null;
  private resize: ResizeObserver | null = null;
  private lastViewport = "";
  private lastFrameAt = 0;
  private loaded = false;
  private streamReady = false;
  /** At least one usable frame reached this element (or the host layer shows the page). */
  private hasVisibleContent = false;
  private shown = false;
  private failed = false;
  private disposed = false;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((reason: Error) => void) | null = null;

  constructor(options: RemoteWebSurfaceOptions) {
    this.spec = options.spec;
    this.env = options.env;
    this.port = options.port;
    this.audioEnabled = options.audioEnabled;
    this.timers = new TimerGroup(this.env.clock);
    this.loadTimer = new TimerGroup(this.env.clock);
    this.key = JSON.stringify(this.spec.content);
    const container = document.createElement("div");
    container.className = "tc-remote-web";
    container.style.position = "relative";
    container.style.width = "100%";
    container.style.height = "100%";
    container.style.overflow = "hidden";
    container.style.background =
      this.spec.content.kind === "page"
        ? this.spec.content.backgroundColor
        : "#000";
    this.element = container;
  }

  prepare(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    const presentation = this.spec.presentation;
    this.loadTimer.after(presentation.loadTimeoutSeconds * 1_000, () =>
      this.fail("load timeout"),
    );
    void this.open();
    return ready;
  }

  /** Settle a still-pending prepare: content shows, or it never can. */
  private settleReady(error: Error | null): void {
    const resolve = this.resolveReady;
    const reject = this.rejectReady;
    this.resolveReady = null;
    this.rejectReady = null;
    if (!resolve || !reject) return;
    if (error) reject(error);
    else resolve();
  }

  activate(): Promise<void> {
    this.shown = true;
    if (this.surfaceId !== null) {
      this.port.setVisible(this.surfaceId, true);
      this.port.setMuted(this.surfaceId, !this.audioEnabled || this.failed);
    }
    return Promise.resolve();
  }

  /** Hidden or leaving: silent at once. */
  pause(): void {
    this.shown = false;
    if (this.surfaceId !== null) {
      this.port.setMuted(this.surfaceId, true);
      this.port.setVisible(this.surfaceId, false);
    }
  }

  seek(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.timers.cancelAll();
    this.loadTimer.cancelAll();
    this.resize?.disconnect();
    this.releaseVideo();
    if (this.surfaceId !== null) {
      const presentation = this.spec.presentation;
      this.port.release(
        this.surfaceId,
        presentation.lifecycle === "keep_warm" && !this.failed
          ? { key: this.key, warmMs: presentation.warmSeconds * 1_000 }
          : null,
      );
    }
  }

  /** Mounted state for diagnostics and the conformance probe. */
  describe(): Record<string, unknown> {
    return {
      surfaceId: this.surfaceId,
      loaded: this.loaded,
      streamReady: this.streamReady,
      failed: this.failed,
    };
  }

  private viewport(): RemoteWebViewportV1 {
    const rect = this.element.getBoundingClientRect();
    // The layout size, before CSS transforms: the page renders at the size
    // of its box, and the compositor applies rotation and scale.
    let width = this.element.clientWidth || rect.width || 1920;
    let height = this.element.clientHeight || rect.height || 1080;
    const scale = Math.max(1, Math.min(globalThis.devicePixelRatio || 1, 4));
    const largest = Math.max(width * scale, height * scale);
    const fit = largest > MAX_EDGE ? MAX_EDGE / largest : 1;
    width = Math.max(MIN_EDGE, Math.round(width * fit));
    height = Math.max(MIN_EDGE, Math.round(height * fit));
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width,
      height,
      deviceScale: scale,
    };
  }

  private async open(): Promise<void> {
    const listener = (event: RemoteWebEventV1) => this.onEvent(event);
    const adopted = this.port.adopt(this.key, listener);
    if (adopted) {
      this.surfaceId = adopted.surfaceId;
      this.loaded = adopted.loaded;
      this.port.updateViewport(adopted.surfaceId, this.viewport());
      this.sourceReady = adopted.streamReady;
      if (adopted.target) this.setTarget(adopted.target);
      this.maybeReady();
      return;
    }
    const viewport = this.viewport();
    const content = this.spec.content;
    if (
      content.kind === "youtube" &&
      (viewport.width < YOUTUBE_MIN_EDGE || viewport.height < YOUTUBE_MIN_EDGE)
    ) {
      // YouTube's embedded player needs at least 200 x 200 pixels.
      this.fail("youtube_too_small");
      return;
    }
    const { state, result } = await this.port.create(
      { content, viewport, muted: true, visible: this.shown },
      listener,
    );
    if (this.disposed) {
      if (result.ok) this.port.release(state.surfaceId, null);
      return;
    }
    if (!result.ok) {
      this.fail(result.code);
      return;
    }
    this.surfaceId = state.surfaceId;
    this.lastViewport = JSON.stringify(viewport);
    this.sourceReady = this.sourceReady || state.streamReady;
    this.setTarget(result.target);
    // Events that arrived before the create reply resolved.
    this.loaded = this.loaded || state.loaded;
    if (state.failed) this.fail(state.failed);
    this.maybeReady();
  }

  private setTarget(
    target: { kind: "media-uri"; uri: string } | { kind: "host-layer" },
  ): void {
    if (target.kind === "host-layer") {
      this.hostLayer = true;
      this.streamReady = this.sourceReady;
      this.attach(null);
    } else {
      this.targetUri = target.uri;
      this.attach(this.sourceReady ? target.uri : null);
    }
  }

  /** Shows the stream (a media URI) or keeps a placeholder (a host layer). */
  private attach(uri: string | null): void {
    if (uri !== null) {
      const video = document.createElement("video");
      video.muted = true; // the stream has no audio; the page's audio is the host's
      video.autoplay = true;
      video.playsInline = true;
      video.disablePictureInPicture = true;
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.objectFit = "fill";
      video.style.display = "block";
      video.addEventListener("error", () => this.fail("stream_failed"));
      video.src = uri;
      this.element.replaceChildren(video);
      this.video = video;
      this.watchFrames();
      void video.play().catch(() => undefined);
    }
    if (!this.resize) {
      this.resize = new ResizeObserver(() => this.sendViewport());
      this.resize.observe(this.element);
    }
  }

  private sendViewport(): void {
    if (this.surfaceId === null || this.disposed) return;
    const viewport = this.viewport();
    const key = JSON.stringify(viewport);
    if (key === this.lastViewport) return;
    this.lastViewport = key;
    this.port.updateViewport(this.surfaceId, viewport);
  }

  private watchFrames(): void {
    const video = this.video;
    if (!video) return;
    const onFrame = () => {
      if (this.disposed || this.video !== video) return;
      this.lastFrameAt = this.env.clock.monotonicNow();
      // A usable frame reached this element: `last_success` must keep it.
      this.hasVisibleContent = true;
      if (!this.streamReady) {
        this.streamReady = true;
        this.maybeReady();
      }
      if (typeof video.requestVideoFrameCallback === "function") {
        this.frameCallback = video.requestVideoFrameCallback(onFrame);
      }
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      this.frameCallback = video.requestVideoFrameCallback(onFrame);
    } else {
      video.addEventListener("timeupdate", onFrame);
    }
    this.timers.every(1_000, () => {
      if (
        this.streamReady &&
        !this.failed &&
        this.env.clock.monotonicNow() - this.lastFrameAt > STREAM_STALL_MS
      ) {
        this.fail("stream_stalled");
      }
    });
  }

  private releaseVideo(): void {
    const video = this.video;
    if (!video) return;
    if (
      this.frameCallback !== null &&
      typeof video.cancelVideoFrameCallback === "function"
    ) {
      video.cancelVideoFrameCallback(this.frameCallback);
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
    this.video = null;
  }

  private onEvent(event: RemoteWebEventV1): void {
    if (this.disposed) return;
    switch (event.kind) {
      case "loaded":
        if (this.loaded && this.shown && !this.failed) {
          // A later load of the same surface (an interval reload): the
          // reference player reports it as a website recovery.
          this.env.sink.websiteRecovered();
          return;
        }
        this.loaded = true;
        this.maybeReady();
        return;
      case "stream-ready":
        this.sourceReady = true;
        if (this.targetUri !== null && this.video === null) {
          this.attach(this.targetUri);
        } else if (this.hostLayer) {
          // The host shows the page at our viewport; that is our content.
          this.hasVisibleContent = true;
          this.streamReady = true;
          this.maybeReady();
        }
        return;
      case "media-ended":
        if (this.spec.presentation.playUntilEnd && this.shown) {
          this.env.sink.ended("ended");
        }
        return;
      case "navigation-blocked":
      case "failed":
      case "process-terminated":
        this.fail(event.code ?? event.kind);
        return;
      case "recovered":
        return;
    }
  }

  private maybeReady(): void {
    if (!this.loaded || !this.streamReady || this.failed || this.disposed)
      return;
    if (!this.resolveReady) return;
    this.loadTimer.cancelAll();
    if (this.port.takeRecovery()) this.env.sink.websiteRecovered();
    this.scheduleReload();
    this.settleReady(null);
  }

  private scheduleReload(): void {
    const interval = this.spec.presentation.reloadIntervalSeconds;
    if (!interval || this.surfaceId === null) return;
    const surfaceId = this.surfaceId;
    this.timers.every(interval * 1_000, () => {
      if (!this.failed) this.port.reload(surfaceId);
    });
  }

  private fail(reason: string): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.loadTimer.cancelAll();
    this.timers.cancelAll();
    const presentation = this.spec.presentation;
    const behavior = normalizeFailureBehavior(presentation.failureBehavior);
    if (behavior === "last_success" && this.hasVisibleContent) {
      // The last rendered frame stays on screen, as on Android: report the
      // failure without finishing the item, and never release the video
      // that shows it. A still-pending prepare resolves: content shows.
      this.env.sink.websiteFailed(reason, true);
      this.settleReady(null);
      return;
    }
    if (this.surfaceId !== null) this.port.setMuted(this.surfaceId, true);
    this.releaseVideo();
    if (behavior === "fallback_image" && presentation.fallbackSrc) {
      const image = showFallbackImage(this.element, presentation.fallbackSrc);
      this.env.sink.websiteFailed(reason, true);
      image.onload = () => {
        if (this.disposed) return;
        this.env.sink.fallbackShown();
        this.settleReady(null);
      };
      image.onerror = () => {
        if (this.disposed) return;
        // The promised fallback cannot be shown: fail deterministically
        // instead of waiting for a fallback that never arrives.
        this.settleReady(new Error("fallback_unavailable"));
      };
      return;
    }
    if (behavior === "placeholder" || behavior === "last_success") {
      // `last_success` before the first usable frame follows the
      // reference player: a placeholder, never an empty surface.
      showWebsitePlaceholder(this.element);
    } else {
      // `skip`: report the failure and let the item finish.
      this.element.replaceChildren();
    }
    this.env.sink.websiteFailed(reason, false);
    this.settleReady(new Error(reason));
  }
}

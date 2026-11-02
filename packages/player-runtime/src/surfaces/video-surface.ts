/**
 * Video through the native HTMLMediaElement. The engine's media pipeline
 * (Chromium's, or WPE's GStreamer) decodes; this surface only starts, bounds
 * and observes it. Nothing here re-renders on media progress.
 *
 * Evidence is stronger where the engine can prove presentation: when
 * `requestVideoFrameCallback` exists, `video-progress` is reported only while
 * decoded frames are actually being presented. Without it the surface falls
 * back to advancing `currentTime`, which is what the player always used.
 *
 * Under a shared timeline the same file comes round again at every lap. The
 * stage may hand this surface the next occurrence (`rebind`) instead of
 * decoding the file a second time, when `videoReuseVerdict` allows it. The
 * element and its decoder stay; everything that belongs to an occurrence moves
 * to the new one: the item, the sink that routes its reports, the offsets, the
 * evidence counters and the drift corrector. Events that were already on their
 * way for the previous occurrence are ignored until the seek to the new start
 * has completed.
 */
import type { RuntimeItem } from "../host/contract";
import { objectFit } from "../engine/model";
import type {
  VideoPlaybackConfig,
  VideoReuseSurface,
} from "../engine/playback-policy";
import type { SyncPosition } from "../engine/timeline";
import { VideoSyncCorrector, type SyncEvent } from "../engine/video-sync";
import type { TimerHandle } from "../clock/scheduler";
import type {
  RestartableSurface,
  SurfaceEnvironment,
  SurfaceSink,
} from "./surface";

/** Advancing video re-reports progress on this cadence. */
export const VIDEO_PROGRESS_INTERVAL_MS = 10_000;
/** A reused element that has not finished its seek by now has failed. */
export const VIDEO_REBIND_TIMEOUT_MS = 5_000;

/** The facts that identify a video and how it plays, for the reuse policy. */
export function videoPlaybackConfig(item: RuntimeItem): VideoPlaybackConfig {
  return {
    itemId: item.id,
    src: item.src,
    fitMode: objectFit(item.fitMode),
    audioEnabled: item.audioEnabled,
    volume: Math.min(Math.max(item.volume, 0), 1),
    endOffsetMs: item.videoEndOffsetMs,
  };
}

interface PendingRebind {
  mount: number;
  resolve(): void;
  reject(error: Error): void;
  timeout: TimerHandle;
}

/**
 * The longest a video may take to present its first frame on the hidden layer.
 * Past this the swap goes ahead anyway: a stalled decoder must delay the
 * playlist by a bounded amount, never hold it on the previous item.
 */
export const VIDEO_FIRST_FRAME_TIMEOUT_MS = 1_500;

export interface HtmlVideoOptions {
  /**
   * Hold `prepare()` until a decoded frame has been presented. For a surface
   * the stage dissolves in: the outgoing layer must stay up until this one
   * has pixels. Layout zones run their own swap and leave it off.
   */
  presentFirstFrame?: boolean;
}

export class HtmlVideoSurface implements RestartableSurface {
  readonly element: HTMLVideoElement;
  private item: RuntimeItem;
  private sink: SurfaceSink;
  private startS: number;
  private endS: number | null;
  private shown = false;
  private failed = false;
  private disposed = false;
  /**
   * The element is moving to the next occurrence and its seek has not
   * finished. Whatever the element reports until then describes the previous
   * occurrence.
   */
  private awaitingOccurrenceSeek = false;
  private rebinding: PendingRebind | null = null;
  private lastReportedAt: number | null = null;
  private lastReportedTime = -1;
  private framesSinceReport = 0;
  private frameHandle: number | null = null;
  private prerollFrame: number | null = null;
  private prerollTimer: TimerHandle | null = null;
  /**
   * Set by the first presented-frame callback. Until then (or on an engine
   * whose callback never fires) progress falls back to media time, so the
   * API strengthens evidence without ever becoming a playback requirement.
   */
  private framesSeen = false;
  private resumePending = false;
  private readonly corrector = new VideoSyncCorrector((event) =>
    this.onSyncEvent(event),
  );
  private readonly listeners: [string, EventListener][] = [];

  constructor(
    item: RuntimeItem,
    private readonly env: SurfaceEnvironment,
    mount: number,
    private readonly options: HtmlVideoOptions = {},
  ) {
    this.item = item;
    this.sink = env.sink;
    const video = document.createElement("video");
    video.style.objectFit = objectFit(item.fitMode);
    video.autoplay = false;
    video.muted = !item.audioEnabled;
    video.volume = Math.min(Math.max(item.volume, 0), 1);
    video.playsInline = true;
    video.preload = "auto";
    // Two occurrences of the same item share an id; the mount tells them
    // apart for drift correction and diagnostics.
    video.dataset["tilecastItemId"] = item.id;
    video.dataset["tilecastMount"] = String(mount);
    this.element = video;
    this.startS = (item.videoStartOffsetMs ?? 0) / 1_000;
    this.endS =
      item.videoEndOffsetMs !== null ? item.videoEndOffsetMs / 1_000 : null;
  }

  prepare(): Promise<void> {
    const video = this.element;
    return new Promise((resolve, reject) => {
      this.on("canplay", () => {
        this.maybeFinishRebind();
        if (this.shown) return;
        this.shown = true;
        // The outgoing layer stays on screen until this video has a frame
        // to show, not merely until it could play: a paused video presents
        // nothing, and on some engines the first frame trails `play()` by
        // longer than the dissolve, so the layer would fade in empty and
        // the picture would then pop in.
        if (this.options.presentFirstFrame) {
          this.presentFirstFrame().then(resolve);
        } else {
          resolve();
        }
      });
      this.on("error", () => {
        this.failed = true;
        const message = "video failed: " + (video.error?.message || "unknown");
        if (!this.shown) reject(new Error(message));
        else this.fail(message);
      });
      this.on("timeupdate", () => this.onTimeUpdate());
      this.on("ended", () => {
        // An `ended` already queued for the previous occurrence can arrive
        // after the element was sent back to the start.
        if (!this.awaitingOccurrenceSeek) this.sink.ended("ended");
      });
      this.on("seeked", () => this.onSeeked());
      this.on("loadeddata", () => this.maybeFinishRebind());
      if (this.startS > 0) {
        this.on("loadedmetadata", () => {
          video.currentTime = this.startS;
        });
      }
      // The one intentional seek: start at the synchronized (or trimmed)
      // offset. Drift correction never seeks merely because the occurrence
      // changed.
      video.currentTime = this.startS;
      video.src = this.item.src;
    });
  }

  activate(): Promise<void> {
    // The first frame was presented muted; the item's own audio setting
    // applies from the moment the video is on screen.
    if (this.options.presentFirstFrame) {
      this.element.muted = !this.item.audioEnabled;
    }
    this.watchFrames();
    return this.element.play().then(
      () => undefined,
      () => this.fail("video autoplay failed"),
    );
  }

  restart(): void {
    // The completion guard stays closed until playback has genuinely resumed.
    this.resumePending = true;
    this.element.currentTime = this.startS;
    this.element.play().catch(() => this.fail("video restart failed"));
  }

  pause(): void {
    this.element.pause();
  }

  seek(seconds: number): Promise<void> {
    this.element.currentTime = seconds;
    return Promise.resolve();
  }

  /** What the reuse policy needs to know about the item this plays. */
  playbackConfig(): VideoPlaybackConfig {
    return videoPlaybackConfig(this.item);
  }

  /** Whether this element could carry another occurrence. */
  reuseState(visible: boolean): VideoReuseSurface {
    return {
      visible,
      disposed: this.disposed,
      failed: this.failed || this.element.error !== null,
      shown: this.shown,
      readyState: this.element.readyState,
    };
  }

  /**
   * Carry this element to the next occurrence of the same video: the shared
   * timeline looped, so the clip starts again at `item.videoStartOffsetMs`.
   * Resolves when the seek has completed and a frame is available, and rejects
   * if the element cannot get there. `sink` and `mount` replace the previous
   * occurrence's, so nothing it still has in flight can reach this one.
   */
  rebind(item: RuntimeItem, sink: SurfaceSink, mount: number): Promise<void> {
    const video = this.element;
    const nowMs = this.env.clock.monotonicNow();
    this.cancelRebind(new Error("superseded"), false);
    this.item = item;
    this.sink = sink;
    video.dataset["tilecastItemId"] = item.id;
    video.dataset["tilecastMount"] = String(mount);
    this.startS = (item.videoStartOffsetMs ?? 0) / 1_000;
    this.endS =
      item.videoEndOffsetMs !== null ? item.videoEndOffsetMs / 1_000 : null;
    // The new occurrence reports from scratch: its first presented frame is
    // its own `video-progress`, and nothing counted before the seek is.
    this.lastReportedAt = null;
    this.lastReportedTime = -1;
    this.framesSinceReport = 0;
    // As on a new element: until a frame callback fires for this occurrence,
    // progress is judged by media time.
    this.framesSeen = false;
    this.resumePending = false;
    this.awaitingOccurrenceSeek = true;
    if (video.playbackRate !== 1) video.playbackRate = 1;
    this.corrector.expectSeek(nowMs);
    this.env.diagnostics?.count("seeks-occurrence");
    return new Promise<void>((resolve, reject) => {
      this.rebinding = {
        mount,
        resolve,
        reject,
        timeout: this.env.clock.at(nowMs + VIDEO_REBIND_TIMEOUT_MS, () => {
          this.cancelRebind(new Error("video seek did not complete"));
        }),
      };
      try {
        video.currentTime = this.rebindTargetS();
        if (video.paused || video.ended) {
          video.play().catch(() => {
            this.cancelRebind(new Error("video restart failed"));
          });
        }
      } catch (error) {
        this.cancelRebind(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }

  /** Hold this video on the group's shared timeline. */
  correct(position: SyncPosition): void {
    const video = this.element;
    // The element is on its way to the next occurrence; its time is not yet
    // this occurrence's time.
    if (this.awaitingOccurrenceSeek) return;
    if (position.itemId !== this.item.id) return;
    const nowMs = this.env.clock.monotonicNow();
    const decision = this.corrector.correct(
      {
        nowMs,
        currentTimeMs: video.currentTime * 1_000,
        seeking: video.seeking,
        paused: video.paused,
        ready: video.readyState >= HTMLMediaElement.HAVE_METADATA,
        playbackRate: video.playbackRate,
        limitMs: this.limitMs(),
      },
      position.videoStartOffsetMs + position.offsetMs,
    );
    if (decision.driftMs !== null) {
      this.env.diagnostics?.drift(decision.driftMs);
    }
    if (video.playbackRate !== decision.playbackRate) {
      video.playbackRate = decision.playbackRate;
    }
    if (decision.action !== "seek" || decision.seekToMs === null) return;
    try {
      video.currentTime = decision.seekToMs / 1_000;
    } catch {
      // Metadata may still be settling; the next correction retries.
      this.corrector.abortSeek(nowMs);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRebind(new Error("disposed"), false);
    const video = this.element;
    for (const [type, listener] of this.listeners) {
      video.removeEventListener(type, listener);
    }
    if (this.frameHandle !== null) {
      video.cancelVideoFrameCallback(this.frameHandle);
      this.frameHandle = null;
    }
    this.endPreroll();
    video.pause();
    // Detaching a playing element leaves it decoding into a surface nobody
    // can see; dropping the source releases the decoder now.
    video.removeAttribute("src");
    video.load();
  }

  /**
   * Start playing, muted, on the hidden layer and settle once a decoded frame
   * has been presented (or the bound passes, or the engine cannot say). The
   * shared timeline expects this video to be a little ahead of its occurrence
   * start at worst, which the drift bands already absorb.
   */
  private presentFirstFrame(): Promise<void> {
    const video = this.element;
    if (typeof video.requestVideoFrameCallback !== "function") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        this.endPreroll();
        resolve();
      };
      video.muted = true;
      this.prerollFrame = video.requestVideoFrameCallback(done);
      this.prerollTimer = this.env.clock.at(
        this.env.clock.monotonicNow() + VIDEO_FIRST_FRAME_TIMEOUT_MS,
        done,
      );
      // A refused play() is reported by activate(); do not hold the swap.
      video.play().catch(done);
    });
  }

  private endPreroll(): void {
    if (this.prerollFrame !== null) {
      this.element.cancelVideoFrameCallback(this.prerollFrame);
      this.prerollFrame = null;
    }
    this.prerollTimer?.cancel();
    this.prerollTimer = null;
  }

  private fail(message: string): void {
    this.failed = true;
    this.sink.failed(message);
  }

  private on(type: string, listener: () => void): void {
    const wrapped: EventListener = () => {
      if (!this.disposed) listener();
    };
    this.listeners.push([type, wrapped]);
    this.element.addEventListener(type, wrapped);
  }

  /** Where the next occurrence starts, aimed ahead by the seek latency. */
  private rebindTargetS(): number {
    const aimed = this.startS + this.corrector.leadMs / 1_000;
    // Never past the trimmed end, and never past the end of the file.
    const limitS = (this.limitMs() ?? Number.POSITIVE_INFINITY) / 1_000;
    return aimed < limitS - 0.1 ? aimed : this.startS;
  }

  private limitMs(): number | null {
    if (this.endS !== null) return this.endS * 1_000;
    const duration = this.element.duration;
    return Number.isFinite(duration) && duration > 0 ? duration * 1_000 : null;
  }

  private onSeeked(): void {
    this.corrector.seeked(
      this.env.clock.monotonicNow(),
      this.element.currentTime * 1_000,
    );
    if (this.awaitingOccurrenceSeek) {
      this.awaitingOccurrenceSeek = false;
      this.maybeFinishRebind();
    }
  }

  private maybeFinishRebind(): void {
    const pending = this.rebinding;
    if (!pending || this.awaitingOccurrenceSeek) return;
    if (this.element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    this.rebinding = null;
    pending.timeout.cancel();
    pending.resolve();
  }

  /**
   * Abandon the pending move to the next occurrence. Unless a newer move or
   * disposal caused it, the element could not get there: it is not trusted
   * with another occurrence, so the next boundary decodes afresh.
   */
  private cancelRebind(error: Error, broken = true): void {
    const pending = this.rebinding;
    if (!pending) return;
    this.rebinding = null;
    pending.timeout.cancel();
    if (broken) this.failed = true;
    pending.reject(error);
  }

  private onSyncEvent(event: SyncEvent): void {
    const diagnostics = this.env.diagnostics;
    if (!diagnostics) return;
    switch (event.type) {
      case "seek":
        diagnostics.note("seeks-correction", {
          driftMs: Math.round(event.driftMs),
          toMs: Math.round(event.toMs),
          leadMs: Math.round(event.leadMs),
          consecutive: event.consecutive,
        });
        break;
      case "seek-settled":
        diagnostics.note("seeks-settled", {
          kind: event.kind,
          latencyMs: Math.round(event.latencyMs),
        });
        break;
      case "seek-timeout":
        diagnostics.note("seek-timeouts", { kind: event.kind });
        break;
      case "settle-timeout":
        diagnostics.note("settle-timeouts", { kind: event.kind });
        break;
      case "rate":
        diagnostics.count("rate-changes");
        break;
      case "stale":
        if (event.stalled) diagnostics.note("stalls", { item: this.item.id });
        else diagnostics.count("stale-readings");
        break;
    }
  }

  private watchFrames(): void {
    const video = this.element;
    if (this.frameHandle !== null) return;
    // Capability-detected: older engines play without it.
    if (typeof video.requestVideoFrameCallback !== "function") return;
    const onFrame = (_now: number, metadata?: VideoFrameCallbackMetadata) => {
      if (this.disposed) return;
      // A frame presented before the seek to the new occurrence completed is
      // the previous occurrence's last frame, not progress for this one.
      if (!this.awaitingOccurrenceSeek) {
        this.framesSeen = true;
        this.framesSinceReport += 1;
        if (metadata) {
          this.corrector.frameSample(
            metadata.mediaTime * 1_000,
            this.env.clock.monotonicNow(),
          );
        }
        if (this.lastReportedAt === null) this.report();
      }
      this.frameHandle = video.requestVideoFrameCallback(onFrame);
    };
    this.frameHandle = video.requestVideoFrameCallback(onFrame);
  }

  private report(): void {
    this.lastReportedAt = this.env.clock.monotonicNow();
    this.lastReportedTime = this.element.currentTime;
    this.framesSinceReport = 0;
    this.sink.evidence("video-progress");
  }

  private onTimeUpdate(): void {
    if (this.awaitingOccurrenceSeek) return;
    const video = this.element;
    const now = this.env.clock.monotonicNow();
    const due =
      this.lastReportedAt === null ||
      now - this.lastReportedAt >= VIDEO_PROGRESS_INTERVAL_MS;
    if (due) {
      // With frame callbacks, progress means frames were presented since the
      // last report; without them, that the media time moved.
      const advancing = this.framesSeen
        ? this.framesSinceReport > 0
        : video.currentTime !== this.lastReportedTime;
      if (advancing) this.report();
    }
    if (
      this.resumePending &&
      video.currentTime >= this.startS + 0.15 &&
      (this.endS === null || video.currentTime < this.endS)
    ) {
      this.resumePending = false;
      this.sink.resumed();
    }
    if (this.endS !== null && video.currentTime >= this.endS) {
      this.sink.ended("end-offset");
    }
  }
}

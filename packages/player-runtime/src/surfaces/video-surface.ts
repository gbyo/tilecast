/**
 * Video through the native HTMLMediaElement. The engine's media pipeline
 * (Chromium's, or WPE's GStreamer) decodes; this surface only starts, bounds
 * and observes it. Nothing here re-renders on media progress.
 *
 * Evidence is stronger where the engine can prove presentation: when
 * `requestVideoFrameCallback` exists, `video-progress` is reported only while
 * decoded frames are actually being presented. Without it the surface falls
 * back to advancing `currentTime`, which is what the player always used.
 */
import type { RuntimeItem } from "../host/contract";
import { objectFit } from "../engine/model";
import {
  newVideoSyncState,
  recordVideoSyncSeek,
  videoSyncCorrection,
  type VideoSyncState,
} from "../engine/playback-policy";
import type { SyncPosition } from "../engine/timeline";
import type { RestartableSurface, SurfaceEnvironment } from "./surface";

/** Advancing video re-reports progress on this cadence. */
export const VIDEO_PROGRESS_INTERVAL_MS = 10_000;

export class HtmlVideoSurface implements RestartableSurface {
  readonly element: HTMLVideoElement;
  private readonly startS: number;
  private readonly endS: number | null;
  private shown = false;
  private disposed = false;
  private lastReportedAt: number | null = null;
  private lastReportedTime = -1;
  private framesSinceReport = 0;
  private frameHandle: number | null = null;
  /**
   * Set by the first presented-frame callback. Until then (or on an engine
   * whose callback never fires) progress falls back to media time, so the
   * API strengthens evidence without ever becoming a playback requirement.
   */
  private framesSeen = false;
  private resumePending = false;
  private syncState: VideoSyncState = newVideoSyncState();
  private readonly listeners: [string, EventListener][] = [];

  constructor(
    private readonly item: RuntimeItem,
    private readonly env: SurfaceEnvironment,
    mount: number,
  ) {
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
        if (this.shown) return;
        this.shown = true;
        // Swapping on the first playable frame is what keeps the outgoing
        // layer on screen exactly until this video has something to show.
        resolve();
      });
      this.on("error", () => {
        const message = "video failed: " + (video.error?.message || "unknown");
        if (!this.shown) reject(new Error(message));
        else this.env.sink.failed(message);
      });
      this.on("timeupdate", () => this.onTimeUpdate());
      this.on("ended", () => this.env.sink.ended("ended"));
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
    this.watchFrames();
    return this.element.play().then(
      () => undefined,
      () => this.env.sink.failed("video autoplay failed"),
    );
  }

  restart(): void {
    // The completion guard stays closed until playback has genuinely resumed.
    this.resumePending = true;
    this.element.currentTime = this.startS;
    this.element
      .play()
      .catch(() => this.env.sink.failed("video restart failed"));
  }

  pause(): void {
    this.element.pause();
  }

  seek(seconds: number): Promise<void> {
    this.element.currentTime = seconds;
    return Promise.resolve();
  }

  /** Hold this video on the group's shared timeline. */
  correct(position: SyncPosition): void {
    const video = this.element;
    if (video.readyState < HTMLMediaElement.HAVE_METADATA || video.seeking) {
      return;
    }
    if (position.itemId !== this.item.id) return;
    const nowMs = this.env.clock.monotonicNow();
    const correction = videoSyncCorrection({
      expectedMs: position.videoStartOffsetMs + position.offsetMs,
      actualMs: video.currentTime * 1_000,
      nowMs,
      state: this.syncState,
    });
    video.playbackRate = correction.playbackRate;
    if (correction.action !== "seek" || correction.seekToMs === null) return;
    try {
      video.currentTime = correction.seekToMs / 1_000;
      recordVideoSyncSeek(this.syncState, nowMs);
    } catch {
      // Metadata may still be settling; the next correction retries.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const video = this.element;
    for (const [type, listener] of this.listeners) {
      video.removeEventListener(type, listener);
    }
    if (this.frameHandle !== null) {
      video.cancelVideoFrameCallback(this.frameHandle);
      this.frameHandle = null;
    }
    video.pause();
    // Detaching a playing element leaves it decoding into a surface nobody
    // can see; dropping the source releases the decoder now.
    video.removeAttribute("src");
    video.load();
  }

  private on(type: string, listener: () => void): void {
    const wrapped: EventListener = () => {
      if (!this.disposed) listener();
    };
    this.listeners.push([type, wrapped]);
    this.element.addEventListener(type, wrapped);
  }

  private watchFrames(): void {
    const video = this.element;
    // Capability-detected: older engines play without it.
    if (typeof video.requestVideoFrameCallback !== "function") return;
    const onFrame = () => {
      if (this.disposed) return;
      this.framesSeen = true;
      this.framesSinceReport += 1;
      if (this.lastReportedAt === null) this.report();
      this.frameHandle = video.requestVideoFrameCallback(onFrame);
    };
    this.frameHandle = video.requestVideoFrameCallback(onFrame);
  }

  private report(): void {
    this.lastReportedAt = this.env.clock.monotonicNow();
    this.lastReportedTime = this.element.currentTime;
    this.framesSinceReport = 0;
    this.env.sink.evidence("video-progress");
  }

  private onTimeUpdate(): void {
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
      this.env.sink.resumed();
    }
    if (this.endS !== null && video.currentTime >= this.endS) {
      this.env.sink.ended("end-offset");
    }
  }
}

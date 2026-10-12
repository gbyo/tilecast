/**
 * The playback stage: two full-screen layers and the surfaces in them.
 *
 * The engine says which occurrence is mounted and when it is shown; the stage
 * turns that into DOM. An incoming occurrence is staged on the hidden layer
 * and prepared there, so the outgoing one stays on screen until the incoming
 * one has something to show. The swap runs as a Web Animations transition;
 * the outgoing surface is paused and released when that transition finishes
 * (or at once when there is nothing to dissolve), so two full-screen decoders
 * overlap for the transition and no longer.
 *
 * The stage is imperative on purpose. Lit renders the Tilecast surfaces and
 * overlays; media elements are created and destroyed only here, so no
 * unrelated reactive update can ever replace an active <video>.
 */
import type { EvidenceKind, RuntimeCapabilitiesV1 } from "../host/contract";
import type { RuntimeClock } from "../clock/scheduler";
import type { StageEntry } from "../engine/model";
import { PlaybackDiagnostics } from "../engine/diagnostics";
import type { SurfaceEvent } from "../engine/presentation-machine";
import type { SyncPosition } from "../engine/timeline";
import {
  shouldClearOutgoingLayer,
  shouldPauseOutgoingLayer,
  videoReuseVerdict,
  type VideoReuseRejection,
} from "../engine/playback-policy";
import { swapLayers, type RunningTransition } from "../transitions/crossfade";
import { ImageSurface } from "./image-surface";
import { LayoutSurface } from "./layout-surface";
import { isRestartable, type MediaSurface, type SurfaceSink } from "./surface";
import { HtmlVideoSurface, videoPlaybackConfig } from "./video-surface";
import { HostRemoteWebSurface } from "./remote-web-surface";
import { WebviewWebsiteSurface } from "./website-surface";
import type { RemoteWebPort } from "../remote-web/port";
import { remoteWebSpecOf } from "../remote-web/spec";
import type { RuntimeItem } from "../host/contract";
import { WidgetSurface } from "./widget-surface";
import { ComponentWidgetSurface } from "./component-widget-surface";
import { widgetComponent } from "../engine/model";
import type { RuntimeWidgetHost } from "../widgets/host";

interface Layer {
  el: HTMLDivElement;
  surface: MediaSurface | null;
  mount: number | null;
  restarts: number;
  /** Bumped at every fill, so delayed cleanup can tell a refilled layer. */
  fill: number;
}

export interface StageOptions {
  clock: RuntimeClock;
  capabilities: RuntimeCapabilitiesV1;
  send: (event: SurfaceEvent) => void;
  /** 0 makes transitions instant (snapshot conformance runs). */
  animationScale: number;
  /** Present when the host advertises `remoteWeb: "host-view"`. */
  remoteWeb?: RemoteWebPort | null;
  widgets?: RuntimeWidgetHost;
  /** Shared with the controller so one instance describes the whole engine. */
  diagnostics?: PlaybackDiagnostics;
}

/**
 * Why a video that could not be carried over is nothing to remark on: the
 * playlist moved to different media, so a new decoder is simply required.
 */
const ORDINARY_REJECTIONS: ReadonlySet<VideoReuseRejection> = new Set([
  "item-changed",
  "source-changed",
  "not-video",
  "not-a-shared-boundary",
]);

export class Stage {
  private front: Layer;
  private back: Layer;
  private transition: RunningTransition | null = null;
  private fillSequence = 0;
  /** The mount the engine currently wants on screen. */
  private currentMount: number | null = null;

  constructor(
    layerA: HTMLDivElement,
    layerB: HTMLDivElement,
    private readonly options: StageOptions,
  ) {
    this.front = {
      el: layerA,
      surface: null,
      mount: null,
      restarts: 0,
      fill: 0,
    };
    this.back = {
      el: layerB,
      surface: null,
      mount: null,
      restarts: 0,
      fill: 0,
    };
  }

  /** Render the engine's current occurrence. */
  update(entry: StageEntry | null): void {
    if (!entry) return;
    this.currentMount = entry.mount;
    if (entry.phase === "skipping") {
      if (this.back.mount === entry.mount) this.empty(this.back);
      if (this.front.mount === entry.mount) this.empty(this.front);
      return;
    }
    if (entry.mount !== this.back.mount && entry.mount !== this.front.mount) {
      this.stage(entry);
    }
    if (entry.phase === "shown" && this.back.mount === entry.mount) {
      this.swap(entry);
    }
    const front = this.front;
    if (
      front.mount === entry.mount &&
      entry.restarts > front.restarts &&
      front.surface
    ) {
      front.restarts = entry.restarts;
      if (isRestartable(front.surface)) front.surface.restart();
    }
  }

  /** A Tilecast surface owns the screen: release every item surface. */
  clear(): void {
    this.transition?.cancel();
    this.transition = null;
    for (const layer of [this.front, this.back]) {
      layer.el.classList.remove("visible");
      this.empty(layer);
    }
  }

  /** Hold the visible video on the shared timeline. */
  correct(position: SyncPosition | null): void {
    if (!position || position.kind !== "video") return;
    const surface = this.front.surface;
    // A video still staged on the hidden layer is not corrected: the previous
    // occurrence owns the screen until the incoming one can play. Nor is the
    // visible one when the engine has already moved on to a newer occurrence.
    if (
      surface instanceof HtmlVideoSurface &&
      this.front.el.classList.contains("visible") &&
      this.front.mount === this.currentMount
    ) {
      surface.correct(position);
    }
  }

  /** Mounted state for diagnostics and the conformance probe. */
  describe(): Record<string, unknown> {
    const layer = (l: Layer) => ({
      mount: l.mount,
      visible: l.el.classList.contains("visible"),
      kind: l.surface?.constructor.name ?? null,
    });
    return { front: layer(this.front), back: layer(this.back) };
  }

  /**
   * Carry the video on screen to the next shared occurrence of itself instead
   * of decoding it again. Everything about whether that is safe is decided by
   * `videoReuseVerdict`; this only gathers the facts and acts on the answer.
   */
  private reuseFront(entry: StageEntry): boolean {
    const front = this.front;
    const surface = front.surface;
    if (!(surface instanceof HtmlVideoSurface) || front.mount === null) {
      return false;
    }
    const verdict = videoReuseVerdict({
      sharedBoundary: entry.sharedBoundary === true,
      incomingIsVideo: entry.item.kind === "video",
      surface: surface.reuseState(front.el.classList.contains("visible")),
      outgoing: surface.playbackConfig(),
      incoming: videoPlaybackConfig(entry.item),
      incomingStartMs: entry.item.videoStartOffsetMs,
    });
    const diagnostics = this.options.diagnostics;
    if (!verdict.reuse) {
      diagnostics?.reuseRejected(verdict.reason);
      // The same media was on screen and a second decoder is about to be
      // started anyway: that is the remount this exists to prevent.
      if (!ORDINARY_REJECTIONS.has(verdict.reason)) {
        diagnostics?.note("unexpected-remounts", {
          item: entry.item.id,
          reason: verdict.reason,
        });
      }
      return false;
    }
    // A staged occurrence that never became ready is stale now. One that is
    // fading out is left to its transition's own cleanup.
    if (!this.transition && this.back.surface) this.empty(this.back);
    const mount = entry.mount;
    front.mount = mount;
    front.restarts = entry.restarts;
    diagnostics?.count("decoders-reused");
    surface.rebind(entry.item, this.sink(mount), mount).then(
      () => {
        if (front.surface === surface && front.mount === mount) {
          this.options.send({ type: "SURFACE_READY", mount });
        }
      },
      (error: unknown) => {
        if (front.surface !== surface || front.mount !== mount) return;
        diagnostics?.count("reuse-failures");
        this.options.send({
          type: "SURFACE_FAILED",
          mount,
          message: String((error as Error)?.message ?? error),
        });
      },
    );
    return true;
  }

  private stage(entry: StageEntry): void {
    if (entry.sharedBoundary && this.reuseFront(entry)) return;
    // While a transition runs, the hidden layer is still the outgoing one and
    // on screen under the dissolve. Emptying it then would expose its black
    // backdrop, so the transition settles first.
    this.transition?.cancel();
    this.transition = null;
    const layer = this.back;
    this.empty(layer);
    this.fillSequence += 1;
    layer.fill = this.fillSequence;
    layer.mount = entry.mount;
    layer.restarts = entry.restarts;
    const sink = this.sink(entry.mount);
    let surface: MediaSurface;
    try {
      surface = this.create(entry, sink);
      if (entry.item.kind === "video") {
        this.options.diagnostics?.count("decoders-created");
      }
    } catch (error) {
      this.options.send({
        type: "SURFACE_FAILED",
        mount: entry.mount,
        message: String((error as Error).message ?? error),
      });
      return;
    }
    layer.surface = surface;
    layer.el.replaceChildren(surface.element);
    surface.prepare().then(
      (readiness) => {
        if (layer.surface === surface) {
          this.options.send({
            type: "SURFACE_READY",
            mount: entry.mount,
            ...(readiness?.empty === true ? { empty: true } : {}),
          });
        }
      },
      (error: unknown) => {
        if (layer.surface === surface) {
          this.options.send({
            type: "SURFACE_FAILED",
            mount: entry.mount,
            message: String((error as Error)?.message ?? error),
          });
        }
      },
    );
  }

  private swap(entry: StageEntry): void {
    this.transition?.cancel();
    const incoming = this.back;
    const outgoing = this.front;
    this.front = incoming;
    this.back = outgoing;
    const transition = swapLayers(
      incoming.el,
      outgoing.surface || outgoing.el.classList.contains("visible")
        ? outgoing.el
        : null,
      entry.transition,
      { durationScale: this.options.animationScale },
    );
    this.transition = transition;
    void incoming.surface?.activate();
    // Capture the layer and its fill now: the delayed cleanup must act on the
    // layer that actually faded out, and only if it was not refilled since.
    const capturedFill = outgoing.fill;
    const state = () => ({
      outgoingIsFront: outgoing === this.front,
      capturedFill,
      currentFill: outgoing.fill,
    });
    void transition.finished.then(() => {
      if (this.transition === transition) this.transition = null;
      if (shouldPauseOutgoingLayer(state())) outgoing.surface?.pause();
      if (shouldClearOutgoingLayer(state())) this.empty(outgoing);
    });
  }

  private empty(layer: Layer): void {
    layer.surface?.pause();
    layer.surface?.dispose();
    layer.surface = null;
    layer.mount = null;
    layer.el.replaceChildren();
  }

  /** The isolated remote web surface this host supports, if any. */
  private remoteSurface(
    item: RuntimeItem,
    sink: SurfaceSink,
    mount: number,
  ): MediaSurface | null {
    const env = {
      clock: this.options.clock,
      sink,
      animationScale: this.options.animationScale,
    };
    switch (this.options.capabilities.remoteWeb) {
      case "host-view": {
        const spec = remoteWebSpecOf(item);
        const port = this.options.remoteWeb;
        if (!spec || !port) return null;
        return new HostRemoteWebSurface({
          spec,
          audioEnabled: item.audioEnabled,
          port,
          env,
        });
      }
      case "electron-webview":
        return new WebviewWebsiteSurface(item, env, mount);
      default:
        return null;
    }
  }

  private create(entry: StageEntry, sink: SurfaceSink): MediaSurface {
    const env = {
      clock: this.options.clock,
      sink,
      animationScale: this.options.animationScale,
      remoteWeb: (item: RuntimeItem, zoneSink: SurfaceSink) =>
        this.remoteSurface(item, zoneSink, entry.mount),
      widgets: this.options.widgets,
      ...(this.options.diagnostics
        ? { diagnostics: this.options.diagnostics }
        : {}),
    };
    const item = entry.item;
    switch (item.kind) {
      case "image":
        return new ImageSurface(item);
      case "video":
        return new HtmlVideoSurface(item, env, entry.mount, {
          presentFirstFrame: true,
        });
      case "widget":
        return widgetComponent(item)
          ? new ComponentWidgetSurface(item, env)
          : new WidgetSurface(item, env);
      case "layout":
        return new LayoutSurface(item, env);
      case "website":
      case "youtube": {
        const surface = this.remoteSurface(item, sink, entry.mount);
        if (surface) return surface;
        throw new Error("website playback is not available on this display");
      }
      default:
        throw new Error(`unsupported item kind ${String(item.kind)}`);
    }
  }

  private sink(mount: number): SurfaceSink {
    const send = this.options.send;
    const evidence = (kind: EvidenceKind, zoneId?: string) =>
      send({ type: "SURFACE_EVIDENCE", mount, kind, zoneId });
    return {
      ended: (source) => send({ type: "SURFACE_ENDED", mount, source }),
      failed: (message) => send({ type: "SURFACE_FAILED", mount, message }),
      resumed: () => send({ type: "SURFACE_RESUMED", mount }),
      evidence,
      websiteFailed: (reason, fallback) =>
        send({ type: "WEBSITE_FAILED", mount, reason, fallback }),
      websiteRecovered: () => send({ type: "WEBSITE_RECOVERED", mount }),
      fallbackShown: () => send({ type: "FALLBACK_SHOWN", mount }),
      zoneFailed: (zoneId, message) =>
        send({ type: "ZONE_FAILED", mount, zoneId, message }),
      widgetEmpty: () => send({ type: "WIDGET_EMPTY", mount }),
    };
  }
}

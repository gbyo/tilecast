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
import type { SurfaceEvent } from "../engine/presentation-machine";
import type { SyncPosition } from "../engine/timeline";
import {
  shouldClearOutgoingLayer,
  shouldPauseOutgoingLayer,
} from "../engine/playback-policy";
import { swapLayers, type RunningTransition } from "../transitions/crossfade";
import { ImageSurface } from "./image-surface";
import { LayoutSurface } from "./layout-surface";
import { isRestartable, type MediaSurface, type SurfaceSink } from "./surface";
import { HtmlVideoSurface } from "./video-surface";
import { WebviewWebsiteSurface } from "./website-surface";
import { WidgetSurface } from "./widget-surface";

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
}

export class Stage {
  private front: Layer;
  private back: Layer;
  private transition: RunningTransition | null = null;
  private fillSequence = 0;

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
    // occurrence owns the screen until the incoming one can play.
    if (
      surface instanceof HtmlVideoSurface &&
      this.front.el.classList.contains("visible")
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

  private stage(entry: StageEntry): void {
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
      () => {
        if (layer.surface === surface) {
          this.options.send({ type: "SURFACE_READY", mount: entry.mount });
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

  private create(entry: StageEntry, sink: SurfaceSink): MediaSurface {
    const env = {
      clock: this.options.clock,
      sink,
      animationScale: this.options.animationScale,
    };
    const item = entry.item;
    switch (item.kind) {
      case "image":
        return new ImageSurface(item);
      case "video":
        return new HtmlVideoSurface(item, env, entry.mount);
      case "widget":
        return new WidgetSurface(item, env);
      case "layout":
        return new LayoutSurface(item, env);
      case "website":
      case "youtube":
        if (this.options.capabilities.remoteWeb === "electron-webview") {
          return new WebviewWebsiteSurface(item, env, entry.mount);
        }
        throw new Error("website playback is not available on this display");
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
    };
  }
}

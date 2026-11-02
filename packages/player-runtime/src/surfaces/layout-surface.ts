/**
 * A Layout: a fixed canvas of zones, scaled to the screen. Each zone reports
 * its own render evidence, so a layout whose zones have silently died is
 * distinguishable from one that is working.
 *
 * Zone content is a first-class Widget component (mounted exactly as a
 * fullscreen Widget is), compatibility rendering (RenderNode trees), or
 * media; the zone playlists run on their own zone actors. A web or YouTube
 * Widget zone is the same remote web surface a root item uses, created
 * through the environment, so the Layout never knows how the host isolates
 * the page. Zone evidence is the Layout's: a Widget only says it rendered.
 */
import { createActor } from "xstate";
import { resolveZoneFallback } from "@tilecast/presentation-model";
import type {
  RuntimeItem,
  RuntimeLayoutZone,
  RuntimeLayoutZonePlaylistItem,
} from "../host/contract";
import { TimerGroup } from "../clock/scheduler";
import { layoutPayload, objectFit } from "../engine/model";
import {
  zoneEntry,
  zoneMachine,
  zoneOwesContinuingEvidence,
  type ZoneActor,
} from "../engine/zone-machine";
import { applyAutoFit, buildRenderNode } from "../compat/render-tree-dom";
import type { MediaSurface, SurfaceEnvironment, SurfaceSink } from "./surface";
import type { WidgetExecution } from "@tilecast/widget-sdk/executor";
import { ImageSurface } from "./image-surface";
import { HtmlVideoSurface } from "./video-surface";
import { ComponentWidgetSurface } from "./component-widget-surface";
import { WidgetSurface } from "./widget-surface";

export class LayoutSurface implements MediaSurface {
  readonly element: HTMLDivElement;
  private readonly timers: TimerGroup;
  private readonly zones: ZoneActor[] = [];
  private readonly zoneTeardowns: (() => void)[] = [];
  private readonly nested: MediaSurface[] = [];
  private readonly playlistLifecycles: { activate(): void; pause(): void }[] =
    [];
  private youtubeZones = 0;
  private active = false;
  private readonly widgetMounts: WidgetExecution[] = [];
  private disposed = false;
  private readonly declarations: { id: string; rotating: boolean }[] = [];

  constructor(
    item: RuntimeItem,
    private readonly env: SurfaceEnvironment,
  ) {
    const payload = layoutPayload(item)!;
    this.timers = new TimerGroup(env.clock);
    const canvas = document.createElement("div");
    canvas.style.position = "relative";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.background = payload.background || "#000";
    canvas.style.overflow = "hidden";
    if (payload.backgroundImage) {
      const bg = document.createElement("img");
      bg.alt = "";
      bg.src = payload.backgroundImage;
      bg.style.position = "absolute";
      const crop = payload.backgroundImageViewport;
      if (crop) {
        bg.style.left = `${(-crop.x / crop.width) * 100}%`;
        bg.style.top = `${(-crop.y / crop.height) * 100}%`;
        bg.style.width = `${(crop.canvasWidth / crop.width) * 100}%`;
        bg.style.height = `${(crop.canvasHeight / crop.height) * 100}%`;
      } else {
        bg.style.inset = "0";
        bg.style.width = "100%";
        bg.style.height = "100%";
      }
      bg.style.objectFit = "cover";
      canvas.appendChild(bg);
    }
    const w = payload.canvasWidth || 1920;
    const h = payload.canvasHeight || 1080;
    for (const zone of payload.zones) {
      canvas.appendChild(this.buildZone(zone, w, h));
      if (zone.id) {
        this.declarations.push({
          id: zone.id,
          rotating: zoneOwesContinuingEvidence(zone),
        });
      }
    }
    this.element = canvas;
  }

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  activate(): Promise<void> {
    if (this.disposed || this.active) return Promise.resolve();
    applyAutoFit(this.element);
    this.active = true;
    // Tell the host what each mounted zone owes before it can go silent.
    for (const zone of this.declarations) {
      this.env.sink.evidence(
        zone.rotating ? "layout-zone-rotating" : "layout-zone-declared",
        zone.id,
      );
    }
    for (const zone of this.playlistLifecycles) zone.activate();
    for (const surface of this.nested) void surface.activate();
    return Promise.resolve();
  }

  pause(): void {
    this.active = false;
    for (const zone of this.playlistLifecycles) zone.pause();
    for (const surface of this.nested) surface.pause();
  }

  seek(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.timers.cancelAll();
    for (const surface of this.nested) surface.dispose();
    for (const zone of this.zones) {
      zone.send({ type: "PAUSE", epoch: zone.getSnapshot().context.epoch });
      zone.stop();
    }
    for (const teardown of this.zoneTeardowns) teardown();
    for (const mount of this.widgetMounts) mount.dispose();
  }

  private buildZone(
    zone: RuntimeLayoutZone,
    canvasWidth: number,
    canvasHeight: number,
  ): HTMLElement {
    const el = document.createElement("div");
    el.dataset.tilecastZone = zone.id;
    el.style.position = "absolute";
    el.style.left = `${(zone.x / canvasWidth) * 100}%`;
    el.style.top = `${(zone.y / canvasHeight) * 100}%`;
    el.style.width = `${(zone.width / canvasWidth) * 100}%`;
    el.style.height = `${(zone.height / canvasHeight) * 100}%`;
    el.style.opacity = String(zone.opacity ?? 1);
    el.style.overflow = "hidden";
    if (zone.radius) el.style.borderRadius = `${zone.radius}px`;
    const rendered = () => {
      if (!this.disposed)
        this.env.sink.evidence("layout-zone-rendered", zone.id);
    };
    const zoneFailed = (message: string) => {
      if (!this.disposed) this.env.sink.zoneFailed(zone.id, message);
    };

    if (zone.component) {
      const widgets = this.env.widgets;
      if (zone.component.hidden) {
        requestAnimationFrame(rendered);
      } else if (!widgets) {
        zoneFailed("widget components are unavailable");
      } else {
        let readinessReported = false;
        this.widgetMounts.push(
          widgets.mount(el, zone.component, (state) => {
            if (this.disposed) return;
            if (state.state === "error") {
              zoneFailed(`widget ${state.code}`);
              return;
            }
            // Readiness evidence is a first-render signal. Later lifecycle
            // errors still report through the Layout failure path.
            if (
              readinessReported ||
              (state.state !== "ready" && state.state !== "empty")
            ) {
              return;
            }
            readinessReported = true;
            rendered();
          }),
        );
      }
    } else if (zone.render) {
      const node = buildRenderNode(zone.render, {
        clock: this.env.clock,
        timers: this.timers,
      });
      el.appendChild(node);
      // A render node is only evidence once its first frame has painted.
      requestAnimationFrame(() => {
        if (node.isConnected) rendered();
      });
    } else if (zone.image) {
      const img = document.createElement("img");
      img.alt = "";
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = objectFit(zone.image.fit);
      // On load, not on append: an image that never decodes is not evidence
      // that anything appeared in the zone.
      img.onload = rendered;
      img.onerror = () => zoneFailed("image failed to load");
      img.src = zone.image.src;
      this.zoneTeardowns.push(() => {
        img.onload = null;
        img.onerror = null;
      });
      el.appendChild(img);
    } else if (zone.remoteWeb) {
      this.startRemoteZone(el, zone, rendered);
    } else if (zone.playlistItems && zone.playlistItems.length > 0) {
      this.startZonePlaylist(
        el,
        zone.playlistItems,
        zone.id,
        rendered,
        zoneFailed,
        zone.loop ?? true,
        zone.fallback ?? "background",
      );
    } else {
      // An empty zone owes nothing; reporting for it keeps the pending set
      // honest rather than leaving a zone permanently outstanding.
      queueMicrotask(rendered);
    }
    return el;
  }

  private startRemoteZone(
    container: HTMLElement,
    zone: RuntimeLayoutZone,
    rendered: () => void,
  ): void {
    const spec = zone.remoteWeb!;
    const sink = this.env.sink;
    const zoneFailed = (message: string) => {
      if (!this.disposed) sink.zoneFailed(zone.id, message);
    };
    if (spec.content.kind === "youtube" && this.youtubeZones++ > 0) {
      // One YouTube player plays at a time (YouTube Required Minimum
      // Functionality). The server refuses such Layouts; an older one that
      // still arrives shows the first player only.
      queueMicrotask(() => zoneFailed("youtube_concurrent_player"));
      return;
    }
    const zoneSink: SurfaceSink = {
      ended: () => undefined,
      failed: (message) => zoneFailed(message),
      resumed: () => undefined,
      evidence: (kind) => {
        if (!this.disposed) sink.evidence(kind, zone.id);
      },
      websiteFailed: (reason) => zoneFailed("website failed: " + reason),
      websiteRecovered: () => sink.websiteRecovered(),
      fallbackShown: rendered,
      zoneFailed: (id, message) => sink.zoneFailed(id, message),
      // Empty Widget state inside a zone must not advance the containing
      // Layout's fullscreen playlist occurrence.
      widgetEmpty: () => undefined,
    };
    const surface = this.env.remoteWeb?.(
      {
        id: zone.id,
        kind: spec.content.kind === "youtube" ? "youtube" : "website",
        src: spec.content.kind === "page" ? spec.content.url : "",
        durationMs: null,
        fitMode: "fill",
        audioEnabled: false,
        volume: 0,
        videoStartOffsetMs: null,
        videoEndOffsetMs: null,
        remoteWeb: spec,
      },
      zoneSink,
    );
    if (!surface) {
      queueMicrotask(() =>
        zoneFailed("remote web is not available on this display"),
      );
      return;
    }
    this.nested.push(surface);
    container.appendChild(surface.element);
    surface.prepare().then(
      () => {
        if (this.disposed) return;
        sink.evidence("website-loaded", zone.id);
        rendered();
        if (this.active) void surface.activate();
      },
      (error: unknown) =>
        zoneFailed(String((error as Error)?.message ?? error)),
    );
  }

  private startZonePlaylist(
    container: HTMLElement,
    items: RuntimeLayoutZonePlaylistItem[],
    zoneId: string,
    onReady: () => void,
    zoneFailed: (message: string) => void,
    loop: boolean,
    fallback: "hide" | "background" | "previous",
  ): void {
    container.style.position = "relative";
    container.style.visibility = "visible";
    const owned = new Set<MediaSurface>();
    const youtube = new Set<MediaSurface>();
    const hasYouTube = items.some(
      (entry) =>
        entry.kind === "remote-web" &&
        entry.remoteWeb.content.kind === "youtube",
    );
    const youtubeAllowed = !hasYouTube || this.youtubeZones++ === 0;
    let visible: MediaSurface | null = null;
    let current: { activate(): void; pause(): void } | null = null;
    let mounted = -1;
    let transition: Animation[] = [];
    let transitionToken = 0;
    const frames = new Set<number>();
    const cancelTransition = () => {
      transitionToken += 1;
      for (const frame of frames) cancelAnimationFrame(frame);
      frames.clear();
      for (const animation of transition) animation.cancel();
      transition = [];
    };
    const release = (surface: MediaSurface) => {
      surface.dispose();
      surface.element.remove();
      owned.delete(surface);
      youtube.delete(surface);
    };
    const actor = createActor(zoneMachine, {
      input: { items, loop, clock: this.env.clock, onReady },
    });
    this.zoneTeardowns.push(() => {
      cancelTransition();
      for (const frame of frames) cancelAnimationFrame(frame);
      frames.clear();
      for (const surface of owned) release(surface);
      visible = null;
      current = null;
    });
    this.playlistLifecycles.push({
      activate: () => {
        actor.send({ type: "RESUME", epoch: mounted });
        current?.activate();
      },
      pause: () => {
        actor.send({ type: "PAUSE", epoch: mounted });
        current?.pause();
      },
    });

    actor.subscribe((snapshot) => {
      const { epoch } = snapshot.context;
      if (epoch === mounted || this.disposed) return;
      mounted = epoch;
      const selected = zoneEntry({ ...snapshot.context, items });
      if (!selected) return;
      const { entry } = selected;
      cancelTransition();
      for (const surface of owned) {
        if (surface !== visible || youtube.has(surface)) {
          if (surface === visible) visible = null;
          release(surface);
        }
      }
      let failedOnce = false;
      let prepared = false;
      let accepted = false;
      let activating = false;
      let activation = 0;
      const isCurrent = () =>
        !this.disposed && epoch === mounted && !failedOnce;
      const failed = (message: string) => {
        if (!isCurrent()) return;
        failedOnce = true;
        activation += 1;
        cancelTransition();
        zoneFailed(message);
        const decision = resolveZoneFallback(true, fallback, visible !== null);
        for (const surface of owned) {
          if (decision !== "previous" || surface !== visible) release(surface);
        }
        if (decision === "previous" && visible) {
          visible.pause();
          visible.element.style.visibility = "visible";
        } else {
          visible = null;
          container.style.visibility =
            decision === "hide" ? "hidden" : "visible";
        }
        actor.send({ type: "MEDIA_FAILED", epoch });
      };
      let completed = false;
      const zoneSink: SurfaceSink = {
        ...this.env.sink,
        failed,
        websiteFailed: (reason) => failed(`website failed: ${reason}`),
        websiteRecovered: () => {
          if (isCurrent()) this.env.sink.websiteRecovered();
        },
        fallbackShown: () => undefined,
        widgetEmpty: () => undefined,
        ended: (source) => {
          if (!isCurrent() || !this.active || !accepted || completed) return;
          completed = true;
          if (selected.loop) return;
          if (source === "end-offset") incoming.pause();
          actor.send({ type: "MEDIA_ENDED", epoch });
        },
        resumed: () => {
          completed = false;
        },
        evidence: (kind) => {
          if (isCurrent() && this.active && accepted)
            this.env.sink.evidence(kind, zoneId);
        },
      };
      const media =
        entry.kind === "image" || entry.kind === "video" ? entry : null;
      const item: RuntimeItem = {
        id: entry.id,
        kind:
          entry.kind === "remote-web"
            ? entry.remoteWeb.content.kind === "youtube"
              ? "youtube"
              : "website"
            : entry.kind,
        src: media?.src ?? "",
        durationMs: entry.durationMs,
        fitMode: media?.fit ?? "fill",
        audioEnabled: media
          ? !media.muted
          : entry.kind === "remote-web"
            ? (entry.audioEnabled ?? false)
            : false,
        volume:
          media?.volume ??
          (entry.kind === "remote-web" ? (entry.volume ?? 0) : 0),
        videoStartOffsetMs: media?.videoStartOffsetMs ?? null,
        videoEndOffsetMs: media?.videoEndOffsetMs ?? null,
        ...(entry.kind === "widget" ? { widget: entry.widget } : {}),
        ...(entry.kind === "remote-web" ? { remoteWeb: entry.remoteWeb } : {}),
      };
      let incoming: MediaSurface;
      try {
        const environment = { ...this.env, sink: zoneSink };
        switch (entry.kind) {
          case "image":
            incoming = new ImageSurface(item);
            break;
          case "video":
            incoming = new HtmlVideoSurface(item, environment, epoch);
            break;
          case "widget":
            incoming =
              "component" in entry.widget
                ? new ComponentWidgetSurface(item, environment)
                : new WidgetSurface(item, environment);
            break;
          case "remote-web": {
            // Reserve YouTube ownership for the whole zone, including while
            // the zone is preparing or transitioning to another occurrence.
            if (entry.remoteWeb.content.kind === "youtube" && !youtubeAllowed)
              throw new Error("youtube_concurrent_player");
            const surface = this.env.remoteWeb?.(item, zoneSink);
            if (!surface)
              throw new Error("remote web is not available on this display");
            incoming = surface;
            break;
          }
        }
      } catch (error) {
        queueMicrotask(() => failed(String(error)));
        return;
      }
      const element = incoming.element;
      element.dataset.tilecastZoneItem = entry.id;
      element.style.position = "absolute";
      element.style.inset = "0";
      element.style.width = "100%";
      element.style.height = "100%";
      element.style.borderRadius = `${entry.radius ?? 0}px`;
      element.style.visibility = "hidden";
      owned.add(incoming);
      if (
        entry.kind === "remote-web" &&
        entry.remoteWeb.content.kind === "youtube"
      )
        youtube.add(incoming);
      container.appendChild(element);

      const show = () => {
        const outgoing = visible;
        visible = incoming;
        if (!outgoing || outgoing === incoming) return;
        if (
          (entry.transition === "fade" || entry.transition === "crossfade") &&
          this.env.animationScale > 0 &&
          typeof element.animate === "function"
        ) {
          const options: KeyframeAnimationOptions = {
            duration: 300 * this.env.animationScale,
            easing: "ease",
            fill: "both",
          };
          transition = [
            element.animate([{ opacity: 0 }, { opacity: 1 }], options),
            outgoing.element.animate([{ opacity: 1 }, { opacity: 0 }], options),
          ];
          const running = transition;
          const token = transitionToken;
          void Promise.all(running.map((animation) => animation.finished))
            .catch(() => undefined)
            .then(() => {
              if (token !== transitionToken) return;
              release(outgoing);
              if (transition === running) transition = [];
            });
        } else release(outgoing);
      };
      const activate = () => {
        if (!isCurrent() || !this.active || !prepared || activating) return;
        activating = true;
        const token = ++activation;
        container.style.visibility = "visible";
        element.style.visibility = "visible";
        // Enabling native looping on a prepared, paused video can stall
        // WebKit's play call. Apply the policy once playback has started.
        if (incoming instanceof HtmlVideoSurface) incoming.element.loop = false;
        void incoming.activate().then(
          () => {
            if (!isCurrent() || token !== activation) return;
            activating = false;
            if (!this.active) return;
            if (incoming instanceof HtmlVideoSurface)
              incoming.element.loop = selected.loop;
            if (accepted) return;
            const ready = () => {
              if (
                !isCurrent() ||
                !this.active ||
                token !== activation ||
                accepted
              )
                return;
              accepted = true;
              show();
              actor.send({ type: "MEDIA_READY", epoch });
            };
            if (entry.kind === "widget") {
              const frame = requestAnimationFrame(() => {
                frames.delete(frame);
                ready();
              });
              frames.add(frame);
            } else ready();
          },
          (error: unknown) =>
            failed(String((error as Error)?.message ?? error)),
        );
      };
      current = {
        activate,
        pause: () => {
          activation += 1;
          activating = false;
          for (const surface of owned) surface.pause();
        },
      };
      incoming.prepare().then(
        () => {
          if (!isCurrent()) return;
          prepared = true;
          activate();
        },
        (error: unknown) => failed(String((error as Error)?.message ?? error)),
      );
    });
    this.zones.push(actor);
    actor.start();
  }
}

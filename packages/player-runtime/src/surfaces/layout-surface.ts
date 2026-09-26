/**
 * A Layout: a fixed canvas of zones, scaled to the screen. Each zone reports
 * its own render evidence, so a layout whose zones have silently died is
 * distinguishable from one that is working.
 *
 * Zone content is compatibility rendering (RenderNode trees and media); the
 * zone playlists run on their own zone actors.
 */
import { createActor } from "xstate";
import type {
  RuntimeItem,
  RuntimeLayoutZone,
  RuntimeLayoutZonePlaylistItem,
} from "../host/contract";
import { TimerGroup } from "../clock/scheduler";
import { layoutPayload, objectFit } from "../engine/model";
import { zoneEntry, zoneMachine, type ZoneActor } from "../engine/zone-machine";
import { applyAutoFit, buildRenderNode } from "../compat/render-tree-dom";
import type { MediaSurface, SurfaceEnvironment } from "./surface";

export class LayoutSurface implements MediaSurface {
  readonly element: HTMLDivElement;
  private readonly timers: TimerGroup;
  private readonly zones: ZoneActor[] = [];
  private readonly zoneTeardowns: (() => void)[] = [];
  private disposed = false;

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
    }
    this.element = canvas;
  }

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  activate(): Promise<void> {
    applyAutoFit(this.element);
    return Promise.resolve();
  }

  pause(): void {
    for (const video of Array.from(this.element.querySelectorAll("video"))) {
      video.pause();
    }
  }

  seek(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.timers.cancelAll();
    for (const zone of this.zones) zone.stop();
    for (const teardown of this.zoneTeardowns) teardown();
  }

  private buildZone(
    zone: RuntimeLayoutZone,
    canvasWidth: number,
    canvasHeight: number,
  ): HTMLElement {
    const el = document.createElement("div");
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

    if (zone.render) {
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
      img.src = zone.image.src;
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = objectFit(zone.image.fit);
      // On load, not on append: an image that never decodes is not evidence
      // that anything appeared in the zone.
      img.onload = rendered;
      el.appendChild(img);
    } else if (zone.playlistItems && zone.playlistItems.length > 0) {
      this.startZonePlaylist(el, zone.playlistItems, rendered);
    } else {
      // An empty zone owes nothing; reporting for it keeps the pending set
      // honest rather than leaving a zone permanently outstanding.
      queueMicrotask(rendered);
    }
    return el;
  }

  private startZonePlaylist(
    container: HTMLElement,
    items: RuntimeLayoutZonePlaylistItem[],
    onAdvance: () => void,
  ): void {
    let video: HTMLVideoElement | null = null;
    const release = () => {
      if (!video) return;
      video.onended = null;
      video.onerror = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
      video = null;
    };
    this.zoneTeardowns.push(release);
    const actor = createActor(zoneMachine, {
      input: { items, clock: this.env.clock, onAdvance },
    });
    let mounted = -1;
    actor.subscribe((snapshot) => {
      const { shown } = snapshot.context;
      if (shown === mounted || this.disposed) return;
      mounted = shown;
      const current = zoneEntry(snapshot.context);
      if (!current) return;
      const { entry, loop } = current;
      if (entry.kind === "video") {
        const next = document.createElement("video");
        next.src = entry.src;
        next.muted = entry.muted;
        next.volume = Math.min(Math.max(entry.volume, 0), 1);
        next.autoplay = true;
        next.loop = loop;
        next.playsInline = true;
        next.style.width = "100%";
        next.style.height = "100%";
        next.style.objectFit = objectFit(entry.fit);
        next.onended = () => actor.send({ type: "MEDIA_ENDED", shown });
        next.onerror = () => actor.send({ type: "MEDIA_FAILED", shown });
        release();
        video = next;
        container.replaceChildren(next);
        void next
          .play()
          .catch(() => actor.send({ type: "MEDIA_FAILED", shown }));
      } else {
        const img = document.createElement("img");
        img.alt = "";
        img.src = entry.src;
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = objectFit(entry.fit);
        release();
        container.replaceChildren(img);
      }
    });
    this.zones.push(actor);
    actor.start();
  }
}

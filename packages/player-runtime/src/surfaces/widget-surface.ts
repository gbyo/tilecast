/**
 * COMPATIBILITY SURFACE. A server-compiled widget, drawn from its RenderNode
 * tree by the compatibility interpreter. Future first-class widgets register
 * through src/widgets/contract.ts instead.
 */
import type { RuntimeItem } from "../host/contract";
import { TimerGroup } from "../clock/scheduler";
import { widgetPayload } from "../engine/model";
import { applyAutoFit, buildRenderNode } from "../compat/render-tree-dom";
import type { MediaSurface, SurfaceEnvironment } from "./surface";

export class WidgetSurface implements MediaSurface {
  readonly element: HTMLDivElement;
  private readonly timers: TimerGroup;

  constructor(item: RuntimeItem, env: SurfaceEnvironment) {
    const payload = widgetPayload(item)!;
    this.timers = new TimerGroup(env.clock);
    const container = document.createElement("div");
    container.style.width = "100%";
    container.style.height = "100%";
    container.style.background = payload.background || "#000";
    container.appendChild(
      buildRenderNode(payload.root, { clock: env.clock, timers: this.timers }),
    );
    this.element = container;
  }

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  activate(): Promise<void> {
    // Only measurable once the container is visible and has a size.
    applyAutoFit(this.element);
    return Promise.resolve();
  }

  pause(): void {}

  seek(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    this.timers.cancelAll();
  }
}

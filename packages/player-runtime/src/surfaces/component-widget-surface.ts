/**
 * A fullscreen first-class Widget (docs/widgets-v2.md). The Widget's own
 * element renders; this surface only mounts it and translates its state.
 *
 * `prepare()` settles when the Widget has rendered: ready or expected-empty
 * resolves, an error or the ready timeout rejects. The stage therefore
 * swaps the item in only after it painted, and the presentation machine
 * reports `widget-shown` and `widget-alive` as it does for every Widget.
 * A Widget that fails after it was shown is reported as a playback failure.
 */
import type { WidgetMount, WidgetMountState } from "@tilecast/widget-sdk/mount";
import type { RuntimeItem } from "../host/contract";
import { widgetComponent } from "../engine/model";
import type { MediaSurface, SurfaceEnvironment } from "./surface";

export class ComponentWidgetSurface implements MediaSurface {
  readonly element: HTMLDivElement;
  private mount: WidgetMount | null = null;
  private settled = false;
  private disposed = false;

  constructor(
    private readonly item: RuntimeItem,
    private readonly env: SurfaceEnvironment,
  ) {
    if (!env.widgets) throw new Error("widget components are unavailable");
    if (!widgetComponent(item)) throw new Error("widget component missing");
    const container = document.createElement("div");
    container.className = "tc-widget-component";
    // The Widget's box is its container: it must fill the layer, or container
    // units and queries would measure an empty box.
    container.style.width = "100%";
    container.style.height = "100%";
    this.element = container;
  }

  prepare(): Promise<void> {
    if (widgetComponent(this.item)?.hidden) {
      this.element.style.display = "none";
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onState = (state: WidgetMountState) => {
        if (this.disposed) return;
        if (!this.settled) {
          if (state.state === "ready" || state.state === "empty") {
            this.settled = true;
            resolve();
          } else if (state.state === "error") {
            this.settled = true;
            reject(new Error(`widget ${state.code}`));
          }
          return;
        }
        if (state.state === "error")
          this.env.sink.failed(`widget ${state.code}`);
      };
      this.mount = this.env.widgets!.mount(
        this.element,
        widgetComponent(this.item)!,
        onState,
      );
    });
  }

  activate(): Promise<void> {
    return Promise.resolve();
  }

  pause(): void {}

  seek(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mount?.dispose();
    this.mount = null;
  }
}

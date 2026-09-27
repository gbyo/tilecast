/**
 * GeometryController: the Widget's own box, for what CSS cannot compute.
 *
 * Use it only for SVG scale calculations and specialized text fitting.
 * Ordinary layout belongs to container queries, which cost no JavaScript
 * and never rerender. The observer is released when the host disconnects,
 * and the host updates only when the size changes by at least a pixel.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";

export interface WidgetSize {
  readonly width: number;
  readonly height: number;
}

export class GeometryController implements ReactiveController {
  private observer: ResizeObserver | null = null;
  size: WidgetSize = { width: 0, height: 0 };
  /** Updates this controller requested; for tests and probes. */
  updates = 0;

  constructor(private readonly host: ReactiveControllerHost & HTMLElement) {
    host.addController(this);
  }

  hostConnected(): void {
    if (typeof ResizeObserver === "undefined") return;
    this.observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) this.measure(box.width, box.height);
    });
    this.observer.observe(this.host);
  }

  hostDisconnected(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  /** Exposed for hosts without ResizeObserver and for tests. */
  measure(width: number, height: number): void {
    const next = { width: Math.round(width), height: Math.round(height) };
    if (
      Math.abs(next.width - this.size.width) < 1 &&
      Math.abs(next.height - this.size.height) < 1
    ) {
      return;
    }
    this.size = next;
    this.updates += 1;
    this.host.requestUpdate();
  }

  get observing(): boolean {
    return this.observer !== null;
  }
}

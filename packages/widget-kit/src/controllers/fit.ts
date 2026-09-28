/**
 * FitController: scale a Widget's type down until its content fits.
 *
 * Authored text has no fixed length, and a Widget must never show a
 * scroll bar or cut a sentence at an arbitrary line. The element declares
 * its type sizes as `calc(var(--tc-fit) * <size>)`, where each size is
 * the largest the design allows for the box. After each render and each
 * resize this controller finds the largest `--tc-fit` in
 * [minimum, 1] at which the measured element does not overflow, with a
 * short binary search, and sets it through the CSSOM.
 *
 * Setting a custom property does not rerender the Lit host, so a fit
 * never loops. Content that still overflows at the minimum scale stays
 * at the minimum: legibility wins over completeness, and the element
 * clips the rest.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";

const STEPS = 7;

export interface FitControllerOptions {
  /** The element whose overflow decides the fit. */
  target(): HTMLElement | null | undefined;
  /** The smallest scale, from 0 to 1. */
  readonly minimum: number;
}

export class FitController implements ReactiveController {
  private observer: ResizeObserver | null = null;
  /** The last applied scale. */
  scale = 1;
  /** Fits run since creation; for tests and probes. */
  fits = 0;

  constructor(
    private readonly host: ReactiveControllerHost & HTMLElement,
    private readonly options: FitControllerOptions,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    if (typeof ResizeObserver === "undefined") return;
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.host);
  }

  hostDisconnected(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  hostUpdated(): void {
    this.fit();
  }

  private overflows(target: HTMLElement): boolean {
    return (
      target.scrollHeight > target.clientHeight + 1 ||
      target.scrollWidth > target.clientWidth + 1
    );
  }

  private apply(target: HTMLElement, scale: number): void {
    target.style.setProperty("--tc-fit", scale.toFixed(4));
  }

  /** Measure now. Exposed for tests. */
  fit(): void {
    const target = this.options.target();
    // Without layout (jsdom, a detached or hidden box) nothing can be
    // measured, and the full size is the correct default.
    if (!target || target.clientHeight === 0 || target.clientWidth === 0) {
      return;
    }
    this.fits += 1;
    const minimum = Math.min(1, Math.max(0.05, this.options.minimum));
    this.apply(target, 1);
    if (!this.overflows(target)) {
      this.scale = 1;
      return;
    }
    let low = minimum;
    let high = 1;
    for (let step = 0; step < STEPS; step += 1) {
      const middle = (low + high) / 2;
      this.apply(target, middle);
      if (this.overflows(target)) high = middle;
      else low = middle;
    }
    this.scale = low;
    this.apply(target, low);
  }
}

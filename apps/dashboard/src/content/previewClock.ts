/**
 * The preview clock behind V2 Widget previews
 * (docs/widgets-v2-authoring-and-first-wave.md).
 *
 * A Widget keeps time with `context.clock` and nothing else, so the
 * existing preview-time control drives the real Widget by swapping this
 * clock's mode: live follows the wall clock, while a fixed instant freezes
 * `now()` for deterministic authoring. Real timers back `after()` in both
 * modes so ready timeouts and element updates keep working.
 */
import type { WidgetClock, WidgetTimer } from "@tilecast/widget-sdk";

export type PreviewClockMode = "live" | "fixed";

export class PreviewClock implements WidgetClock {
  private mode: PreviewClockMode = "live";
  private fixedMs: number = Date.now();

  setMode(mode: PreviewClockMode, fixedMs?: number): void {
    this.mode = mode;
    if (fixedMs !== undefined) this.fixedMs = fixedMs;
  }

  setFixed(fixedMs: number): void {
    this.fixedMs = fixedMs;
    this.mode = "fixed";
  }

  now(): number {
    return this.mode === "fixed" ? this.fixedMs : Date.now();
  }

  monotonicNow(): number {
    return this.mode === "fixed" ? this.fixedMs : Date.now();
  }

  after(delayMs: number, run: () => void): WidgetTimer {
    const timer = window.setTimeout(run, Math.max(0, delayMs));
    return {
      cancel() {
        window.clearTimeout(timer);
      },
    };
  }
}

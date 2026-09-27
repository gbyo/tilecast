/**
 * ClockController: the only way a Widget follows time.
 *
 * It reads the corrected Tilecast clock from the Widget context and asks the
 * host to update at the next boundary its presentation cares about, using
 * the context clock's scheduler. So a manual conformance or preview clock
 * drives it exactly like playback, and a disconnected Widget leaves no
 * timer behind. Never replace it with setInterval(() => new Date()).
 *
 * A key function narrows updates further: a date label keyed on the local
 * calendar day wakes once a minute (the cheapest boundary that is correct
 * across time zones and DST) but rerenders only when the day changes.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type {
  WidgetClock,
  WidgetContext,
  WidgetTimer,
} from "@tilecast/widget-sdk";

export type ClockGranularity = "second" | "minute";

const UNIT_MS: Record<ClockGranularity, number> = {
  second: 1_000,
  minute: 60_000,
};

/** Fire just after a boundary so formatting never sees the previous unit. */
const BOUNDARY_SLACK_MS = 8;

export interface ClockControllerOptions {
  /** How often the presentation can change. Read on each update. */
  granularity(): ClockGranularity;
  /**
   * Optional: the value the presentation depends on. The host updates only
   * when it changes (for example the formatted local date).
   */
  key?(now: number): string;
}

type ClockHost = ReactiveControllerHost &
  HTMLElement & { context?: WidgetContext };

export class ClockController implements ReactiveController {
  private timer: WidgetTimer | null = null;
  private scheduledClock: WidgetClock | null = null;
  private scheduledGranularity: ClockGranularity | null = null;
  private lastKey: string | null = null;
  private connected = false;
  /** Scheduled wake-ups since creation; for tests and probes. */
  wakeups = 0;

  constructor(
    private readonly host: ClockHost,
    private readonly options: ClockControllerOptions,
  ) {
    host.addController(this);
  }

  /** Corrected Unix milliseconds, or NaN before the context arrives. */
  get now(): number {
    return this.host.context?.clock.now() ?? Number.NaN;
  }

  hostConnected(): void {
    this.connected = true;
    this.reschedule();
  }

  hostDisconnected(): void {
    this.connected = false;
    this.cancel();
  }

  hostUpdate(): void {
    // A new context (another clock) or a new granularity takes effect now.
    const clock = this.host.context?.clock ?? null;
    if (
      clock !== this.scheduledClock ||
      this.options.granularity() !== this.scheduledGranularity
    ) {
      this.reschedule();
    }
    if (this.options.key && clock) this.lastKey = this.options.key(clock.now());
  }

  private cancel(): void {
    this.timer?.cancel();
    this.timer = null;
    this.scheduledClock = null;
    this.scheduledGranularity = null;
  }

  private reschedule(): void {
    this.cancel();
    const clock = this.host.context?.clock;
    if (!this.connected || !clock) return;
    const granularity = this.options.granularity();
    const unit = UNIT_MS[granularity];
    const now = clock.now();
    const remainder = ((now % unit) + unit) % unit;
    const delay = unit - remainder + BOUNDARY_SLACK_MS;
    this.scheduledClock = clock;
    this.scheduledGranularity = granularity;
    this.timer = clock.after(delay, () => {
      this.timer = null;
      this.scheduledClock = null;
      this.wakeups += 1;
      const key = this.options.key?.(clock.now());
      if (key === undefined || key !== this.lastKey) {
        this.host.requestUpdate();
      }
      this.reschedule();
    });
  }
}

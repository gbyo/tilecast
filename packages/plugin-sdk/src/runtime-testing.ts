/**
 * A runtime plugin context for tests. Time moves only when a test advances
 * it, timers fire in deadline order, and invalidations are counted rather
 * than acted on, so a plugin's own tests can drive mount, update, and render
 * without the Player runtime host.
 */
import type {
  RuntimeMicrophone,
  RuntimePluginContext,
  SurfaceGrant,
  SurfaceSlot,
  TimerHandle,
} from "./runtime.ts";

interface Timer {
  id: number;
  at: number;
  interval: number | null;
  callback: () => void;
  cancelled: boolean;
}

export interface TestRuntime {
  readonly context: RuntimePluginContext;
  /** Move both clocks forward, firing due timers in order. */
  advance(milliseconds: number): void;
  /** How many times the plugin called invalidate(). */
  readonly invalidations: number;
  setAwake(awake: boolean): void;
  /** Timers that are still scheduled. */
  readonly pendingTimers: number;
}

export function createTestRuntime(
  options: {
    /** Corrected (server) wall time, Unix milliseconds. */
    now?: number;
    /** Server minus local wall time. */
    clockOffsetMs?: number;
    animationScale?: number;
    reducedMotion?: boolean;
    microphone?: RuntimeMicrophone;
  } = {},
): TestRuntime {
  const offset = options.clockOffsetMs ?? 0;
  let wall = (options.now ?? Date.parse("2026-09-01T12:00:00Z")) - offset;
  let monotonic = 1_000;
  let nextId = 1;
  let timers: Timer[] = [];
  let invalidations = 0;
  let awake = true;

  const add = (
    at: number,
    interval: number | null,
    callback: () => void,
  ): TimerHandle => {
    const timer: Timer = {
      id: nextId++,
      at,
      interval,
      callback,
      cancelled: false,
    };
    timers.push(timer);
    return { cancel: () => void (timer.cancelled = true) };
  };

  const context: RuntimePluginContext = {
    clock: {
      now: () => wall + offset,
      localNow: () => wall,
      monotonicNow: () => monotonic,
      after: (delay, callback) =>
        add(monotonic + Math.max(0, delay), null, callback),
      every: (interval, callback) =>
        add(monotonic + Math.max(1, interval), Math.max(1, interval), callback),
    },
    reducedMotion: () =>
      options.reducedMotion ?? (options.animationScale ?? 1) === 0,
    animationScale: options.animationScale ?? 1,
    invalidate: () => void (invalidations += 1),
    awake: () => awake,
    mediaUrl: (assetId, variantId) =>
      `tcmedia://variant/${assetId}/${variantId}`,
    ...(options.microphone ? { microphone: options.microphone } : {}),
  };

  return {
    context,
    advance(milliseconds) {
      const target = monotonic + Math.max(0, milliseconds);
      for (;;) {
        let due: Timer | null = null;
        for (const timer of timers) {
          if (timer.cancelled || timer.at > target) continue;
          if (
            !due ||
            timer.at < due.at ||
            (timer.at === due.at && timer.id < due.id)
          ) {
            due = timer;
          }
        }
        if (!due) break;
        wall += due.at - monotonic;
        monotonic = due.at;
        if (due.interval !== null) due.at += due.interval;
        else due.cancelled = true;
        due.callback();
        timers = timers.filter((timer) => !timer.cancelled);
      }
      wall += target - monotonic;
      monotonic = target;
    },
    get invalidations() {
      return invalidations;
    },
    setAwake(value) {
      awake = value;
    },
    get pendingTimers() {
      return timers.filter((timer) => !timer.cancelled).length;
    },
  };
}

/** A grant that shows the given slots, with no strip lift. */
export function grant(
  shown: readonly SurfaceSlot[],
  lift: { topLiftPx?: number; bottomLiftPx?: number } = {},
): SurfaceGrant {
  return {
    shown: new Set(shown),
    topLiftPx: lift.topLiftPx ?? 0,
    bottomLiftPx: lift.bottomLiftPx ?? 0,
  };
}

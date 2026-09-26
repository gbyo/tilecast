/**
 * The runtime's only source of time and its only user of browser timers.
 *
 * Deadlines are expressed on the monotonic clock. The playback machines never
 * call setTimeout or use XState `after` delays: they ask the scheduler to wake
 * them, receive a typed event, and then re-evaluate from the clock. That keeps
 * synchronized playback anchored to the shared timeline (a late timer is
 * corrected, never trusted) and lets tests and the conformance suite drive
 * time explicitly with a manual clock.
 */

export interface TimerHandle {
  cancel(): void;
}

export interface RuntimeClock {
  /** Uncorrected local wall-clock Unix milliseconds. */
  wallNow(): number;
  /** Monotonic milliseconds; never jumps with wall-clock corrections. */
  monotonicNow(): number;
  /** Run `callback` once the monotonic clock reaches `atMs`. */
  at(atMs: number, callback: () => void): TimerHandle;
  /** Run `callback` every `intervalMs` until cancelled. */
  every(intervalMs: number, callback: () => void): TimerHandle;
  /** Run `callback` after the current task, before any later deadline. */
  soon(callback: () => void): TimerHandle;
}

/** The production clock. */
export function browserClock(): RuntimeClock {
  return {
    wallNow: () => Date.now(),
    monotonicNow: () => performance.now(),
    at(atMs, callback) {
      const delay = Math.max(0, atMs - performance.now());
      const id = setTimeout(callback, delay);
      return { cancel: () => clearTimeout(id) };
    },
    every(intervalMs, callback) {
      const id = setInterval(callback, intervalMs);
      return { cancel: () => clearInterval(id) };
    },
    soon(callback) {
      const id = setTimeout(callback, 0);
      return { cancel: () => clearTimeout(id) };
    },
  };
}

interface ManualTimer {
  id: number;
  atMs: number;
  intervalMs: number | null;
  callback: () => void;
  cancelled: boolean;
}

/**
 * A clock that only moves when told to. Timers fire in deadline order (ties in
 * creation order) as `advance` passes them, so a test sees exactly the
 * sequence of events production would, without waiting.
 */
export class ManualClock implements RuntimeClock {
  private wallMs: number;
  private monoMs: number;
  private nextId = 1;
  private timers: ManualTimer[] = [];

  constructor(options: { wallMs: number; monotonicMs?: number }) {
    this.wallMs = options.wallMs;
    this.monoMs = options.monotonicMs ?? 1_000;
  }

  wallNow(): number {
    return this.wallMs;
  }

  monotonicNow(): number {
    return this.monoMs;
  }

  at(atMs: number, callback: () => void): TimerHandle {
    return this.add(Math.max(atMs, this.monoMs), null, callback);
  }

  every(intervalMs: number, callback: () => void): TimerHandle {
    return this.add(this.monoMs + intervalMs, intervalMs, callback);
  }

  soon(callback: () => void): TimerHandle {
    return this.add(this.monoMs, null, callback);
  }

  /** Step the wall clock without moving monotonic time (an NTP step). */
  stepWall(deltaMs: number): void {
    this.wallMs += deltaMs;
  }

  /** Move both clocks forward, firing every timer that falls due. */
  advance(deltaMs: number): void {
    const target = this.monoMs + Math.max(0, deltaMs);
    for (;;) {
      const due = this.nextDue(target);
      if (!due) break;
      this.wallMs += due.atMs - this.monoMs;
      this.monoMs = due.atMs;
      if (due.intervalMs !== null) {
        due.atMs += due.intervalMs;
      } else {
        due.cancelled = true;
      }
      due.callback();
      this.timers = this.timers.filter((timer) => !timer.cancelled);
    }
    this.wallMs += target - this.monoMs;
    this.monoMs = target;
  }

  /** Fire everything due now, including work queued with `soon`. */
  flush(): void {
    this.advance(0);
  }

  get pendingTimers(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }

  private add(
    atMs: number,
    intervalMs: number | null,
    callback: () => void,
  ): TimerHandle {
    const timer: ManualTimer = {
      id: this.nextId++,
      atMs,
      intervalMs,
      callback,
      cancelled: false,
    };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  private nextDue(limit: number): ManualTimer | null {
    let best: ManualTimer | null = null;
    for (const timer of this.timers) {
      if (timer.cancelled || timer.atMs > limit) continue;
      if (
        !best ||
        timer.atMs < best.atMs ||
        (timer.atMs === best.atMs && timer.id < best.id)
      ) {
        best = timer;
      }
    }
    return best;
  }
}

/**
 * A group of timers owned by one lifecycle (an occurrence, a zone, a
 * surface). Cancelling the group cancels everything it scheduled, so nothing
 * scheduled for a replaced item can fire into its successor.
 */
export class TimerGroup {
  private readonly handles = new Set<TimerHandle>();

  constructor(private readonly clock: RuntimeClock) {}

  at(atMs: number, callback: () => void): TimerHandle {
    return this.track((wrap) => this.clock.at(atMs, wrap), callback, true);
  }

  after(delayMs: number, callback: () => void): TimerHandle {
    return this.at(this.clock.monotonicNow() + delayMs, callback);
  }

  every(intervalMs: number, callback: () => void): TimerHandle {
    return this.track(
      (wrap) => this.clock.every(intervalMs, wrap),
      callback,
      false,
    );
  }

  soon(callback: () => void): TimerHandle {
    return this.track((wrap) => this.clock.soon(wrap), callback, true);
  }

  cancelAll(): void {
    for (const handle of this.handles) handle.cancel();
    this.handles.clear();
  }

  private track(
    schedule: (wrapped: () => void) => TimerHandle,
    callback: () => void,
    once: boolean,
  ): TimerHandle {
    let handle: TimerHandle | null = null;
    const wrapped = () => {
      if (once && handle) this.handles.delete(handle);
      callback();
    };
    handle = schedule(wrapped);
    const tracked = handle;
    this.handles.add(tracked);
    return {
      cancel: () => {
        tracked.cancel();
        this.handles.delete(tracked);
      },
    };
  }
}

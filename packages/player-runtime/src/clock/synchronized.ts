/**
 * Synchronized-group timeline math, shared by every host.
 *
 * A group of screens plays one shared cycle anchored at a server wall-clock
 * instant. The wall clock is read once, at activation, to place the screen in
 * that cycle; from then on the position advances with a monotonic clock, so an
 * NTP step, a manual clock change or a suspend never jumps what is on screen.
 *
 * These are pure functions. The runtime's scheduler turns the positions into
 * `BOUNDARY_DUE` events for the playback machine.
 */

export interface SynchronizedPlaybackMetadata {
  groupId: string;
  anchorMs: number;
  durationsMs: number[];
}

export interface SynchronizedPlaybackPosition {
  index: number;
  offsetMs: number;
  remainingMs: number;
  occurrence: number;
}

/**
 * Where a synchronized presentation was in wall-clock and monotonic time when
 * it was activated.
 */
export interface SynchronizedClockActivation {
  wallMs: number;
  monotonicMs: number;
}

/** Monotonic milliseconds; unaffected by wall-clock corrections. */
export function monotonicNowMs(): number {
  return performance.now();
}

export function activateSynchronizedClock(
  wallMs = Date.now(),
  monotonicMs = monotonicNowMs(),
): SynchronizedClockActivation {
  return { wallMs, monotonicMs };
}

/**
 * The wall-clock instant the shared timeline should be evaluated at, advanced
 * monotonically from activation rather than re-read from the wall clock.
 */
export function synchronizedNowMs(
  activation: SynchronizedClockActivation,
  monotonicMs = monotonicNowMs(),
): number {
  return activation.wallMs + Math.max(0, monotonicMs - activation.monotonicMs);
}

export function synchronizedPlaybackPosition(
  metadata: SynchronizedPlaybackMetadata,
  nowMs: number,
): SynchronizedPlaybackPosition {
  const durations = metadata.durationsMs.map((value) => Math.max(1, value));
  if (durations.length === 0) {
    return { index: 0, offsetMs: 0, remainingMs: 1, occurrence: 0 };
  }

  const cycleDuration = durations.reduce((sum, value) => sum + value, 0);
  const elapsed = Math.max(0, nowMs - metadata.anchorMs);
  const completedCycles = Math.floor(elapsed / cycleDuration);
  let withinCycle = elapsed % cycleDuration;
  let index = 0;
  while (index < durations.length - 1 && withinCycle >= durations[index]!) {
    withinCycle -= durations[index]!;
    index += 1;
  }

  const duration = durations[index]!;
  const offsetMs = Math.min(Math.floor(withinCycle), duration - 1);
  return {
    index,
    offsetMs,
    remainingMs: Math.max(1, duration - offsetMs),
    occurrence: completedCycles * durations.length + index,
  };
}

interface TimelineItem {
  kind: string;
  durationMs: number | null;
  videoStartOffsetMs: number | null;
}

/**
 * Rotate the playlist so the expected shared item comes first and only waits
 * for the remaining portion of its occurrence. A video starts at its shared
 * offset: that is the one intentional seek a healthy synchronized item makes.
 */
export function rotateForSynchronizedPosition<T extends TimelineItem>(
  items: readonly T[],
  position: SynchronizedPlaybackPosition,
): T[] {
  if (items.length === 0) {
    return [];
  }
  const index = Math.min(Math.max(position.index, 0), items.length - 1);
  const rotated = [...items.slice(index), ...items.slice(0, index)].map(
    (item) => ({ ...item }),
  );
  const first = rotated[0]!;
  first.durationMs = position.remainingMs;
  if (first.kind === "video") {
    first.videoStartOffsetMs =
      (items[index]!.videoStartOffsetMs ?? 0) + position.offsetMs;
  }
  return rotated;
}

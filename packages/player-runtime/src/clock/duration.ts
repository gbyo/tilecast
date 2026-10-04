/**
 * What the runtime believes about an item's duration.
 *
 * A duration is a positive number of milliseconds or it is absent. Zero and
 * negative values are how "no duration" gets spelled by stored data and by the
 * hosts' own arithmetic; reading them literally turns the item into an
 * instant boundary, which advances, remounts the same item, and repeats. Every
 * timer in the runtime reads durations through this module so there is one
 * answer to "how long does this item run".
 */

/**
 * No item is shown for less than this. Studio refuses shorter durations, so a
 * shorter one is a fault upstream — a clamp, a zero, a rotated remainder — and
 * obeying it would only produce a flicker the viewer cannot read and a burst
 * of zero-length Proof of Play sessions.
 */
export const MIN_ITEM_DWELL_MS = 1_000;

/** `value` when it is a finite number above zero, otherwise null. */
export function positiveDurationMs(
  value: number | null | undefined,
): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

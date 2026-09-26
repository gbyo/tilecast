/**
 * One availability rule for every content path. The server publishes the
 * same window on playlist items and on media variants used by layouts,
 * fallbacks, and plugins; the player must not make alternate paths bypass it.
 */

export interface AvailabilityWindow {
  availableFrom?: string | null;
  expiresAt?: string | null;
}

function bound(value: string | null | undefined): number | null | "invalid" {
  if (value == null || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : "invalid";
}

export function isAvailableAt(
  value: AvailabilityWindow | null | undefined,
  at: Date,
): boolean {
  if (!value) return true;
  const from = bound(value.availableFrom);
  const until = bound(value.expiresAt);
  if (from === "invalid" || until === "invalid") return false;
  if (from !== null && until !== null && from >= until) return false;
  const now = at.getTime();
  return (from === null || now >= from) && (until === null || now < until);
}

/**
 * Returns the next instant at which one of the supplied windows changes state.
 * Invalid windows are omitted here; structural/readiness validation rejects
 * them before a manifest is published.
 */
export function nextAvailabilityTransition(
  values: readonly (AvailabilityWindow | null | undefined)[],
  at: Date,
): Date | null {
  const now = at.getTime();
  let next: number | null = null;
  for (const value of values) {
    const from = bound(value?.availableFrom);
    const until = bound(value?.expiresAt);
    if (from === "invalid" || until === "invalid") continue;
    for (const candidate of [from, until]) {
      if (
        candidate !== null &&
        candidate > now &&
        (next === null || candidate < next)
      ) {
        next = candidate;
      }
    }
  }
  return next === null ? null : new Date(next);
}

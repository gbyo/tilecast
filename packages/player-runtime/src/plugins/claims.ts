/**
 * Claim validation and slot arbitration: the pure core of the runtime
 * surface host. Nothing here knows any plugin; it compares declared tiers,
 * claimed priorities, and plugin identifiers.
 */
import {
  CLAIM_PRIORITY_LIMIT,
  MAX_STRIP_HEIGHT_PX,
  STRIP_SLOTS,
  type SurfaceClaim,
  type SurfaceSlot,
  type SurfaceTier,
} from "@tilecast/plugin-sdk/runtime";

/** Arbitration order, strongest first. */
export const TIER_ORDER: readonly SurfaceTier[] = [
  "emergency",
  "live",
  "scheduled",
  "ambient",
];

const STRIPS: ReadonlySet<string> = new Set(STRIP_SLOTS);

export function isStripSlot(slot: SurfaceSlot): boolean {
  return STRIPS.has(slot);
}

/** A claim that passed validation, with strip fields filled in. */
export interface ValidClaim {
  slot: SurfaceSlot;
  priority: number;
  heightPx: number;
  displayMode: "overlay" | "push";
}

export interface ClaimCheck {
  claims: ValidClaim[];
  /** One message per refused claim. A refused claim loses arbitration. */
  problems: string[];
}

/**
 * Check what a plugin returned from update(). Anything malformed is refused
 * with a diagnostic, never thrown: a broken bundled plugin loses its slots
 * and playback continues.
 */
export function validateClaims(
  surfaces: readonly SurfaceSlot[],
  returned: unknown,
): ClaimCheck {
  const problems: string[] = [];
  const claims: ValidClaim[] = [];
  if (!Array.isArray(returned)) {
    return { claims, problems: ["update() did not return an array of claims"] };
  }
  const declared = new Set<string>(surfaces);
  const seen = new Set<string>();
  for (const value of returned as unknown[]) {
    if (typeof value !== "object" || value === null) {
      problems.push("a claim is not an object");
      continue;
    }
    const claim = value as Partial<SurfaceClaim> & Record<string, unknown>;
    const slot = claim.slot;
    if (typeof slot !== "string" || !declared.has(slot)) {
      problems.push(`claim for undeclared slot ${String(slot)}`);
      continue;
    }
    if (seen.has(slot)) {
      problems.push(`more than one claim for ${slot}`);
      continue;
    }
    if ("tier" in claim) {
      problems.push(`claim for ${slot} names a tier; the tier is declared`);
      continue;
    }
    const priority = claim.priority;
    if (
      typeof priority !== "number" ||
      !Number.isFinite(priority) ||
      Math.abs(priority) > CLAIM_PRIORITY_LIMIT
    ) {
      problems.push(`claim for ${slot} has an invalid priority`);
      continue;
    }
    if (isStripSlot(slot)) {
      const height = claim.heightPx;
      if (
        typeof height !== "number" ||
        !Number.isFinite(height) ||
        height <= 0 ||
        height > MAX_STRIP_HEIGHT_PX
      ) {
        problems.push(`claim for ${slot} has an invalid heightPx`);
        continue;
      }
      const mode = claim.displayMode ?? "overlay";
      if (mode !== "overlay" && mode !== "push") {
        problems.push(`claim for ${slot} has an invalid displayMode`);
        continue;
      }
      seen.add(slot);
      claims.push({ slot, priority, heightPx: height, displayMode: mode });
      continue;
    }
    if (claim.heightPx !== undefined || claim.displayMode !== undefined) {
      problems.push(`claim for ${slot} sets strip-only fields`);
      continue;
    }
    seen.add(slot);
    claims.push({ slot, priority, heightPx: 0, displayMode: "overlay" });
  }
  return { claims, problems };
}

export interface Contender {
  pluginId: string;
  tier: SurfaceTier;
  claim: ValidClaim;
}

/**
 * The deterministic order: declared tier, then claimed priority, then the
 * plugin identifier. Code-unit comparison keeps it identical on every engine.
 */
export function compareContenders(left: Contender, right: Contender): number {
  const tier = TIER_ORDER.indexOf(left.tier) - TIER_ORDER.indexOf(right.tier);
  if (tier !== 0) return tier;
  if (left.claim.priority !== right.claim.priority) {
    return right.claim.priority - left.claim.priority;
  }
  return left.pluginId < right.pluginId
    ? -1
    : left.pluginId > right.pluginId
      ? 1
      : 0;
}

/** The winner of each slot, compared independently per slot. */
export function arbitrate(
  contenders: readonly Contender[],
): Map<SurfaceSlot, Contender> {
  const winners = new Map<SurfaceSlot, Contender>();
  for (const contender of contenders) {
    const held = winners.get(contender.claim.slot);
    if (!held || compareContenders(contender, held) < 0) {
      winners.set(contender.claim.slot, contender);
    }
  }
  return winners;
}

/** Host-owned geometry that follows from the strip winners. */
export interface SurfaceGeometry {
  /** Content-stage insets from pushing strips. */
  topInsetPx: number;
  bottomInsetPx: number;
  /** How far corner containers sit clear of the strips. */
  topLiftPx: number;
  bottomLiftPx: number;
  /** Height of each strip holder, by slot. */
  stripHeights: Partial<Record<SurfaceSlot, number>>;
}

export function geometry(
  winners: ReadonlyMap<SurfaceSlot, Contender>,
): SurfaceGeometry {
  const top = winners.get("strip.top")?.claim;
  const bottom = winners.get("strip.bottom")?.claim;
  const stripHeights: Partial<Record<SurfaceSlot, number>> = {};
  if (top) stripHeights["strip.top"] = top.heightPx;
  if (bottom) stripHeights["strip.bottom"] = bottom.heightPx;
  return {
    topInsetPx: top?.displayMode === "push" ? top.heightPx : 0,
    bottomInsetPx: bottom?.displayMode === "push" ? bottom.heightPx : 0,
    topLiftPx: top?.heightPx ?? 0,
    bottomLiftPx: bottom?.heightPx ?? 0,
    stripHeights,
  };
}

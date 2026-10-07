import {
  activeHoursFromConfig,
  buildOutsideActiveHoursPresentation,
  evaluateActiveHours,
  overridesActiveHours,
  type ActiveHoursState,
  type OutsideActiveHoursPresentation,
} from "@tilecast/player-active-hours";
import type { SelectionFacts } from "@tilecast/player-runtime/projection";
import type { ActivationPolicy } from "./storage/activation";

/**
 * The rest policy a Browser Player keeps working without the server.
 *
 * Active hours are a power and rest policy, not a content schedule. The shared
 * `@tilecast/player-active-hours` package decides whether the screen should
 * rest. The Host keeps the few accepted configuration values that policy
 * needs inside the activation they were accepted with, so a browser that
 * restarts, or loses the server, still rests and wakes at the right times.
 * Choosing content stays with the server: this file evaluates no schedule and
 * knows no playlist.
 */
const POWER_KEYS = [
  "activeHoursEnabled",
  "activeHoursTimezone",
  "activeHoursDays",
  "activeHoursStart",
  "activeHoursEnd",
  "outsideActiveHoursDisplay",
  "outsideActiveHoursText",
];
const BRANDING_KEYS = ["footerText", "textColor"];

const pick = (source: unknown, keys: string[]): Record<string, unknown> => {
  const record = (source ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    keys.filter((key) => key in record).map((key) => [key, record[key]]),
  );
};

export function policyFromConfig(
  config: { configRevision: number; power?: unknown; branding?: unknown },
  selection: SelectionFacts | null,
  manifestVersion: number | undefined,
  clockOffsetMs: number,
): ActivationPolicy {
  return {
    configRevision: config.configRevision,
    manifestVersion,
    selection,
    power: pick(config.power, POWER_KEYS),
    branding: pick(config.branding, BRANDING_KEYS),
    clockOffsetMs,
  };
}

export interface RestDecision {
  /** The screen should rest now. */
  resting: boolean;
  /** The value reported as `activeHoursState`. */
  state: ActiveHoursState;
  /** What a resting screen shows. */
  presentation: OutsideActiveHoursPresentation;
  /** When to evaluate again, in milliseconds, or null when it never changes. */
  reevaluateInMs: number | null;
}

/**
 * Whether the screen rests at `deviceNowMs`. The device clock is corrected by
 * the last accepted server offset. A Takeover or a Quick Present shows even
 * outside active hours.
 */
export function decideRest(
  policy: ActivationPolicy | undefined,
  deviceNowMs: number,
): RestDecision {
  const presentation = buildOutsideActiveHoursPresentation(policy);
  if (!policy) {
    return {
      resting: false,
      state: "active",
      presentation,
      reevaluateInMs: null,
    };
  }
  const hours = evaluateActiveHours(
    activeHoursFromConfig(policy.power),
    deviceNowMs + policy.clockOffsetMs,
  );
  const resting =
    !hours.active && !overridesActiveHours(policy.selection?.source);
  return {
    resting,
    state: hours.state,
    presentation,
    reevaluateInMs: hours.msUntilTransition,
  };
}

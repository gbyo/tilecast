import type { FleetSummary } from "./attention";

/**
 * Whether the incident list behind the attention count has arrived. Incidents
 * load apart from the screen list, so the count can be a floor.
 */
export type RecapIncidents = "loading" | "failed" | "ready";

/**
 * The server's measured-now fleet health, or nothing when it could not be
 * read. Unavailable data is never turned into zero.
 */
export type RecapPlayback =
  | { state: "unavailable" }
  | { state: "ready"; healthy: number; impaired: number; measured: number };

export type RecapInput = {
  summary: FleetSummary;
  /** Screens already proven to need attention by statuses and incidents. */
  attentionCount: number;
  incidents: RecapIncidents;
  playback: RecapPlayback;
};

/**
 * How many screens need attention, and how sure the count is. `atLeast` is
 * used when incidents failed to load: the proven issues are a floor.
 */
export type RecapAttention =
  | { kind: "none" }
  | { kind: "exact"; count: number }
  | { kind: "atLeast"; count: number };

type ConnectionKind =
  "allOnline" | "mostOnline" | "someOnline" | "fewOnline" | "noneOnline";

/**
 * One sentence about the fleet right now. Domain facts only: the sentence
 * itself is chosen by `recapMessage` and written in the locale files.
 */
export type OverviewRecap =
  | {
      kind: ConnectionKind;
      online: number;
      total: number;
      attention: RecapAttention;
    }
  | { kind: "allOnlineHealthyPlayback"; total: number }
  | { kind: "allOnlineNoHealthyPlayback"; total: number }
  | { kind: "singleScreen"; online: boolean; needsAttention: boolean }
  | { kind: "singleScreenHealthyPlayback" }
  | { kind: "singleScreenNoHealthyPlayback" };

/**
 * "Most" is at least two thirds online and "only" is under one third. These
 * are presentation words, so the cut-offs are exact integer comparisons and
 * a count that is not clearly one thing falls back to the plain "X of Y".
 */
function connectionKind(online: number, total: number): ConnectionKind {
  if (online >= total) return "allOnline";
  if (online === 0) return "noneOnline";
  if (online * 3 >= total * 2) return "mostOnline";
  if (online * 3 < total) return "fewOnline";
  return "someOnline";
}

function recapAttention(
  count: number,
  incidents: RecapIncidents,
): RecapAttention {
  if (incidents === "loading" || count === 0) return { kind: "none" };
  return incidents === "ready"
    ? { kind: "exact", count }
    : { kind: "atLeast", count };
}

/**
 * Playback is folded in only when it contradicts a clean connection summary:
 * every screen online, nothing proven wrong, and the Player either confirming
 * all of the fleet or none of it.
 *
 * "None" also needs a screen the server calls impaired. A fleet with nothing
 * to play (off hours, nothing assigned) is unmeasured, not unhealthy, and
 * would otherwise read as broken every night.
 */
function playbackClaim(
  total: number,
  playback: RecapPlayback,
): "healthy" | "none" | null {
  if (playback.state !== "ready") return null;
  const { healthy, impaired, measured } = playback;
  if (measured > 0 && measured === total && healthy === measured) {
    return "healthy";
  }
  if (measured > 0 && healthy === 0 && impaired > 0) return "none";
  return null;
}

/** The recap for the fleet, or null when there are no screens to describe. */
export function deriveRecap({
  summary,
  attentionCount,
  incidents,
  playback,
}: RecapInput): OverviewRecap | null {
  const { total, online } = summary;
  if (total === 0) return null;
  const attention = recapAttention(attentionCount, incidents);
  const claim =
    online === total && incidents === "ready" && attention.kind === "none"
      ? playbackClaim(total, playback)
      : null;

  if (total === 1) {
    if (claim === "healthy") return { kind: "singleScreenHealthyPlayback" };
    if (claim === "none") return { kind: "singleScreenNoHealthyPlayback" };
    return {
      kind: "singleScreen",
      online: online === 1,
      needsAttention: attention.kind !== "none",
    };
  }

  if (claim === "healthy") return { kind: "allOnlineHealthyPlayback", total };
  if (claim === "none") return { kind: "allOnlineNoHealthyPlayback", total };
  return { kind: connectionKind(online, total), online, total, attention };
}

/** A translation key and the values the sentence interpolates. */
export type RecapMessage = {
  key: RecapKey;
  options: Record<string, number>;
};

/**
 * Every key is spelled out, so a typo fails type-checking and a locale audit
 * can grep for each one. Plural keys take `count`; nested fragments inside
 * the sentences carry their own plural forms.
 */
const keys = {
  allOnline: {
    none: "operations.recap.allOnline.plain",
    exact: "operations.recap.allOnline.attention",
    atLeast: "operations.recap.allOnline.atLeast",
  },
  mostOnline: {
    none: "operations.recap.mostOnline.plain",
    exact: "operations.recap.mostOnline.attention",
    atLeast: "operations.recap.mostOnline.atLeast",
  },
  someOnline: {
    none: "operations.recap.someOnline.plain",
    exact: "operations.recap.someOnline.attention",
    atLeast: "operations.recap.someOnline.atLeast",
  },
  fewOnline: {
    none: "operations.recap.fewOnline.plain",
    exact: "operations.recap.fewOnline.attention",
    atLeast: "operations.recap.fewOnline.atLeast",
  },
  noneOnline: {
    none: "operations.recap.noneOnline.plain",
    exact: "operations.recap.noneOnline.attention",
    atLeast: "operations.recap.noneOnline.atLeast",
  },
} as const;

type RecapKey =
  | (typeof keys)[ConnectionKind][RecapAttention["kind"]]
  | "operations.recap.allOnlineHealthyPlayback"
  | "operations.recap.allOnlineNoHealthyPlayback"
  | "operations.recap.single.online"
  | "operations.recap.single.onlineAttention"
  | "operations.recap.single.notOnline"
  | "operations.recap.single.notOnlineAttention"
  | "operations.recap.single.healthyPlayback"
  | "operations.recap.single.noHealthyPlayback";

export function recapMessage(recap: OverviewRecap): RecapMessage {
  switch (recap.kind) {
    case "allOnlineHealthyPlayback":
      return {
        key: "operations.recap.allOnlineHealthyPlayback",
        options: { count: recap.total },
      };
    case "allOnlineNoHealthyPlayback":
      return {
        key: "operations.recap.allOnlineNoHealthyPlayback",
        options: { count: recap.total },
      };
    case "singleScreenHealthyPlayback":
      return { key: "operations.recap.single.healthyPlayback", options: {} };
    case "singleScreenNoHealthyPlayback":
      return { key: "operations.recap.single.noHealthyPlayback", options: {} };
    case "singleScreen":
      return {
        key: recap.online
          ? recap.needsAttention
            ? "operations.recap.single.onlineAttention"
            : "operations.recap.single.online"
          : recap.needsAttention
            ? "operations.recap.single.notOnlineAttention"
            : "operations.recap.single.notOnline",
        options: {},
      };
    default: {
      const { attention } = recap;
      const options: Record<string, number> = {
        online: recap.online,
        total: recap.total,
      };
      if (attention.kind !== "none") options.attention = attention.count;
      // The headline number is what picks the plural form of the sentence.
      if (recap.kind === "allOnline") options.count = recap.total;
      if (recap.kind === "someOnline" || recap.kind === "fewOnline") {
        options.count = recap.online;
      }
      return { key: keys[recap.kind][attention.kind], options };
    }
  }
}

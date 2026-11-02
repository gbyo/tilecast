import { useSearchParams } from "react-router";

export type ActivityTabName =
  "overview" | "proof" | "incidents" | "content-health" | "events" | "audit";

/** Exact-identifier proof filters, kept behind a disclosure but still chipped. */
export const advancedProofFilterKeys = [
  "media",
  "widget",
  "playlist",
  "layout",
  "schedule",
  "takeover",
] as const;

export const proofResultOptions = [
  "playing",
  "completed",
  "partial",
  "skipped",
  "failed",
  "unknown",
  "recovered",
];
export const auditResultOptions = ["success", "failure", "denied", "partial"];
export const categoryOptions = [
  "connectivity",
  "manifest",
  "playback",
  "scheduling",
  "commands",
  "reliability",
  "updates",
  "takeovers",
];
export const severityOptions = ["info", "warning", "error", "critical"];

export const incidentStatusOptions = [
  "open",
  "acknowledged",
  "recovered",
  "resolved",
  "ignored",
];
export const incidentTypeOptions = [
  "connectivity",
  "playback",
  "storage",
  "safe_mode",
  "update",
  "data_source",
  "content",
];
/**
 * Which timestamp a date range filters on. An incident opened last week and
 * resolved today belongs to a different set under each basis, so the choice
 * has to be explicit rather than assumed.
 */
export const incidentDateBasisOptions = ["opened", "recovered", "resolved"];

export const sessionTypeOptions = [
  "presentation",
  "content",
  "layout_placement",
  "playlist_item",
];

/**
 * `unexpected` is not a stored reason. It is the server-side shorthand for
 * "any reason that is not an expected ending", which is exactly the population
 * the Interrupted plays metric counts — so the drill-down matches the number.
 */
export const terminalReasonOptions = [
  "unexpected",
  "expected_item_boundary",
  "completed_duration",
  "schedule_transition",
  "manifest_replacement",
  "direct_assignment_change",
  "takeover",
  "player_restart",
  "process_exit",
  "heartbeat_gap",
  "renderer_failure",
  "decoder_failure",
  "manual_skip",
  "recovery_action",
  "bounded_timeout",
  "unknown",
];

/**
 * The filter keys each tab can actually apply. A drill-down that carried a key
 * the destination cannot show would narrow a report with an invisible control,
 * so anything outside this list is dropped when the link is built.
 */
export const activityTabFilterKeys: Record<ActivityTabName, readonly string[]> =
  {
    overview: [],
    // Content health is a rollup of current state, not a filtered report.
    "content-health": [],
    incidents: [
      "search",
      "status",
      "severity",
      "type",
      "screen",
      "group",
      "location",
      "assignee",
      "failureCode",
      "dateBasis",
    ],
    proof: [
      "search",
      "screen",
      "group",
      "result",
      "sessionType",
      "terminalReason",
      ...advancedProofFilterKeys,
    ],
    events: ["search", "screen", "group", "category", "severity", "result"],
    audit: ["search", "actor", "action", "resourceType", "result"],
  };

/** Every filter key any tab owns, used when switching tabs clears the rest. */
export const allActivityFilterKeys = [
  ...new Set(Object.values(activityTabFilterKeys).flat()),
];

/**
 * Closed value sets, so a link cannot carry a value the destination rejects.
 * The Audit Log has its own result vocabulary; `result=failed` means nothing
 * there and would silently return no rows.
 */
const allowedValues: Partial<
  Record<ActivityTabName, Record<string, readonly string[]>>
> = {
  proof: {
    result: proofResultOptions,
    sessionType: sessionTypeOptions,
    terminalReason: terminalReasonOptions,
  },
  events: {
    result: proofResultOptions,
    category: categoryOptions,
    severity: severityOptions,
  },
  audit: { result: auditResultOptions },
  incidents: {
    status: incidentStatusOptions,
    severity: severityOptions,
    type: incidentTypeOptions,
    dateBasis: incidentDateBasisOptions,
  },
};

/** The date-range portion of the Activity URL, exactly as the picker stores it. */
export type ActivityRangeParams = {
  range?: string;
  from?: string;
  to?: string;
};

export function activityRangeParams(
  params: URLSearchParams,
): ActivityRangeParams {
  return {
    range: params.get("range") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
  };
}

/**
 * Builds an Activity URL that keeps the reader inside the period they are
 * already looking at. Every metric drill-down goes through this, so a number
 * measured over 30 days can never open a report scoped to 24 hours.
 */
export function buildActivityLink(
  tab: ActivityTabName,
  filters: Record<string, string | undefined> = {},
  range: ActivityRangeParams = {},
): string {
  const params = new URLSearchParams();
  if (tab !== "overview") params.set("tab", tab);
  // A preset is enough on its own; the explicit bounds only mean something for
  // a custom range, where dropping them would silently fall back to 24 hours.
  if (range.range) params.set("range", range.range);
  if (range.range === "custom") {
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
  }
  const permitted = activityTabFilterKeys[tab];
  for (const [key, value] of Object.entries(filters)) {
    if (!value || !permitted.includes(key)) continue;
    const values = allowedValues[tab]?.[key];
    if (values && !values.includes(value)) continue;
    params.set(key, value);
  }
  const query = params.toString();
  return query ? `/activity?${query}` : "/activity";
}

/**
 * Links to a screen's own Activity tab. The range is not carried: the screen
 * panel reports current state over its own fixed windows, so a range parameter
 * there would suggest a filter that is not applied.
 */
export function screenActivityLink(screenId: string): string {
  return `/screens/${screenId}?tab=activity`;
}

/** Reads the live range out of the URL and returns a bound link builder. */
export function useActivityLinkBuilder() {
  const [searchParams] = useSearchParams();
  const range = activityRangeParams(searchParams);
  return (tab: ActivityTabName, filters?: Record<string, string | undefined>) =>
    buildActivityLink(tab, filters, range);
}

/**
 * Activity domain helpers over the typed transport. Incident list and
 * operator-action shapes come from the generated OpenAPI contract; the
 * page-local Incident view model in pages/ActivityIncidentShared stays,
 * with the generated payloads assigning directly to it.
 */
import { apiGet, apiPatch } from "../transport";
import type { components } from "@tilecast/api-schema/generated/openapi";

/** Operator action the contract accepts on an incident. */
export type IncidentAction = components["schemas"]["IncidentAction"];

export type IncidentFilters = {
  status?: string;
  severity?: string;
  type?: string;
  screen?: string;
  group?: string;
  location?: string;
  assignee?: string;
  failureCode?: string;
  search?: string;
  from?: string;
  to?: string;
  dateBasis?: "opened" | "recovered" | "resolved";
};

export function listIncidents(
  filters: IncidentFilters,
): Promise<components["schemas"]["IncidentList"]> {
  // openapi-fetch drops undefined values; the server treats "" as absent,
  // so filters pass through unchanged.
  return apiGet("/api/v1/activity/incidents", {
    params: { query: filters },
  });
}

export function updateIncident(
  id: string,
  input: {
    action: IncidentAction;
    reason?: string;
    notes?: string;
    assignedTo?: string;
  },
  csrfToken: string,
): Promise<components["schemas"]["Incident"]> {
  return apiPatch("/api/v1/activity/incidents/{id}", {
    params: { path: { id } },
    body: input,
    csrfToken,
  });
}

export type ProofFilters = {
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
  cursor?: string;
  screen?: string;
  group?: string;
  result?: string;
  sessionType?: components["schemas"]["ProofSessionType"];
  terminalReason?: components["schemas"]["ProofTerminalReason"] | "unexpected";
  media?: string;
  widget?: string;
  content?: string;
  playlist?: string;
  layout?: string;
  schedule?: string;
  takeover?: string;
  search?: string;
};

export function listProofOfPlay(
  filters: ProofFilters,
): Promise<components["schemas"]["ProofOfPlayPage"]> {
  // openapi-fetch drops undefined values; the server treats "" as absent,
  // so filters pass through unchanged.
  return apiGet("/api/v1/activity/proof-of-play", {
    params: { query: filters },
  });
}

export function getProofOfPlaySummary(
  filters: ProofFilters & { dimension?: string },
): Promise<components["schemas"]["ProofSummary"]> {
  return apiGet("/api/v1/activity/proof-of-play/summary", {
    params: { query: filters },
  });
}

export type EventFilters = {
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
  cursor?: string;
  screen?: string;
  group?: string;
  category?: string;
  severity?: string;
  result?: string;
  search?: string;
};

/** Wire shape of a screen event from the generated contract. */
export type WireScreenEvent = components["schemas"]["ScreenEventRecord"];

/**
 * Server-derived transitions carry no device queue position; the Studio
 * view models a missing sequence as absent.
 */
export type NormalizedScreenEvent = Omit<WireScreenEvent, "sequence"> & {
  sequence?: number;
};

export function normalizeScreenEvent(
  wire: WireScreenEvent,
): NormalizedScreenEvent {
  return {
    ...wire,
    sequence: wire.sequence ?? undefined,
  };
}

export function listScreenEvents(
  filters: EventFilters,
): Promise<components["schemas"]["ScreenEventPage"]> {
  return apiGet("/api/v1/activity/screen-events", {
    params: { query: filters },
  });
}

export type AuditFilters = {
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
  cursor?: string;
  actor?: string;
  action?: string;
  resourceType?: string;
  result?: string;
  search?: string;
};

export function listAuditActivity(
  filters: AuditFilters,
): Promise<components["schemas"]["AuditActivityPage"]> {
  // openapi-fetch drops undefined values; the server treats "" as absent,
  // so filters pass through unchanged.
  return apiGet("/api/v1/activity/audit", {
    params: { query: filters },
  });
}

export type ActivityRange = { from?: string; to?: string };

export function getActivityOverview(
  range: ActivityRange,
): Promise<components["schemas"]["ActivityOverview"]> {
  return apiGet("/api/v1/activity/overview", {
    params: { query: range },
  });
}

export type ComplianceDimension =
  components["schemas"]["ComplianceReport"]["dimension"];

export function getPlaybackCompliance(
  range: ActivityRange & { dimension?: ComplianceDimension },
): Promise<components["schemas"]["ComplianceReport"]> {
  return apiGet("/api/v1/activity/compliance", {
    params: { query: range },
  });
}

export function getIncidentAnalytics(
  range: ActivityRange,
): Promise<components["schemas"]["IncidentAnalytics"]> {
  return apiGet("/api/v1/activity/incidents/analytics", {
    params: { query: range },
  });
}

export function getActivityRetention(): Promise<
  components["schemas"]["ActivityRetention"]
> {
  return apiGet("/api/v1/activity/retention");
}

export function getIncident(
  id: string,
): Promise<components["schemas"]["IncidentDetail"]> {
  return apiGet("/api/v1/activity/incidents/{id}", {
    params: { path: { id } },
  });
}

export function updateActivityRetention(
  input: {
    rawEventDays?: number;
    playbackSessionDays?: number;
    screenStateDays?: number;
    auditLogDays?: number;
    diagnosticMetadataDays?: number;
    telemetryRollupDays?: number;
  },
  csrfToken: string,
): Promise<components["schemas"]["ActivityRetention"]> {
  return apiPatch("/api/v1/activity/retention", {
    body: input,
    csrfToken,
  });
}

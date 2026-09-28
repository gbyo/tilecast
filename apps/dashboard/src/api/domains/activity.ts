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

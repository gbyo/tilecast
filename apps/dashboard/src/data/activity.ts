import { queryOptions } from "@tanstack/react-query";
import {
  getActivityOverview,
  getIncident,
  getIncidentAnalytics,
  getPlaybackCompliance,
  listIncidents,
  normalizeScreenEvent,
  type ActivityRange,
  type ComplianceDimension,
  type IncidentFilters,
} from "../api/domains/activity";

type ComplianceQuery = ActivityRange & { dimension?: ComplianceDimension };

export const activityKeys = {
  all: ["activity"] as const,
  overview: (range: ActivityRange) =>
    [...activityKeys.all, "overview", range.from, range.to] as const,
  incidents: ["activity", "incidents"] as const,
  incidentList: (filters: IncidentFilters) =>
    [...activityKeys.incidents, "list", filters] as const,
  incident: (id: string) => [...activityKeys.incidents, "detail", id] as const,
  incidentAnalytics: (range: ActivityRange) =>
    [...activityKeys.incidents, "analytics", range.from, range.to] as const,
  compliance: ({ from, to, dimension }: ComplianceQuery) =>
    [...activityKeys.all, "compliance", { from, to, dimension }] as const,
};

export const activityQueries = {
  overview: ({ from, to }: ActivityRange) =>
    queryOptions({
      queryKey: activityKeys.overview({ from, to }),
      queryFn: () => getActivityOverview({ from, to }),
    }),
  incidents: (filters: IncidentFilters) =>
    queryOptions({
      queryKey: activityKeys.incidentList(filters),
      queryFn: () => listIncidents(filters),
    }),
  incident: (id: string) =>
    queryOptions({
      queryKey: activityKeys.incident(id),
      queryFn: () =>
        getIncident(id).then((detail) => ({
          ...detail,
          relatedEvents: detail.relatedEvents.map(normalizeScreenEvent),
        })),
      enabled: Boolean(id),
    }),
  incidentAnalytics: ({ from, to }: ActivityRange) =>
    queryOptions({
      queryKey: activityKeys.incidentAnalytics({ from, to }),
      queryFn: () => getIncidentAnalytics({ from, to }),
    }),
  compliance: ({ from, to, dimension }: ComplianceQuery) =>
    queryOptions({
      queryKey: activityKeys.compliance({ from, to, dimension }),
      queryFn: () => getPlaybackCompliance({ from, to, dimension }),
    }),
};

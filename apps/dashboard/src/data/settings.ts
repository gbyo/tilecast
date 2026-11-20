import { queryOptions } from "@tanstack/react-query";
import { api } from "../api/client";

export const settingsKeys = {
  organization: ["settings"] as const,
  screenPolicy: (id: string) => ["screen", id, "policy"] as const,
  groupPolicy: (id: string) => ["group", id, "policy"] as const,
  effectiveScreenPolicy: (id: string) =>
    ["screens", id, "effective-policy"] as const,
};

export const settingsQueries = {
  organization: () =>
    queryOptions({
      queryKey: settingsKeys.organization,
      queryFn: ({ signal }) => api.settings({ signal }),
    }),
  screenPolicy: (id: string) =>
    queryOptions({
      queryKey: settingsKeys.screenPolicy(id),
      queryFn: () => api.screenPolicy(id),
    }),
  effectiveScreenPolicy: (id: string) =>
    queryOptions({
      queryKey: settingsKeys.effectiveScreenPolicy(id),
      queryFn: () => api.effectivePolicy(id),
    }),
};

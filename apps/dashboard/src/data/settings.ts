import { queryOptions } from "@tanstack/react-query";
import { api } from "../api/client";

export const settingsKeys = {
  organization: ["settings"] as const,
};

export const settingsQueries = {
  organization: () =>
    queryOptions({
      queryKey: settingsKeys.organization,
      queryFn: ({ signal }) => api.settings({ signal }),
    }),
};

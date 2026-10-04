import { queryOptions } from "@tanstack/react-query";
import { api } from "../api/client";

export const accountKeys = {
  preferences: ["preferences"] as const,
};

export const accountQueries = {
  preferences: () =>
    queryOptions({
      queryKey: accountKeys.preferences,
      queryFn: ({ signal }) => api.preferences({ signal }),
    }),
};

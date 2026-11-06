import { queryOptions } from "@tanstack/react-query";
import { listFonts } from "../api/fonts";

export const fontKeys = {
  library: ["fonts"] as const,
  catalog: (query: string, category: string) =>
    ["fonts", "catalog", query, category] as const,
  catalogFamily: (sourceId: string) =>
    ["fonts", "catalog", "family", sourceId] as const,
};

export const fontQueries = {
  library: () =>
    queryOptions({
      queryKey: fontKeys.library,
      queryFn: ({ signal }) => listFonts({ signal }),
      staleTime: 60_000,
    }),
};

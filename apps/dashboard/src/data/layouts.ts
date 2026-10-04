import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "../api/client";
import { hasNextPage } from "../api/pagination";

export const layoutKeys = {
  all: ["layouts"] as const,
  list: (search = "") => [...layoutKeys.all, "list", { search }] as const,
  pages: (search = "") => [...layoutKeys.all, "library", search] as const,
  detail: (id: string) => [...layoutKeys.all, "detail", id] as const,
  revisions: (id: string) => [...layoutKeys.detail(id), "revisions"] as const,
};

export const layoutQueries = {
  list: (search = "") =>
    queryOptions({
      queryKey: layoutKeys.list(search),
      queryFn: () => api.layouts(search),
    }),
  pages: (search = "") =>
    infiniteQueryOptions({
      queryKey: layoutKeys.pages(search),
      initialPageParam: 1,
      queryFn: ({ pageParam }) => api.layoutPage(search, pageParam),
      getNextPageParam: (page) =>
        hasNextPage(page) ? page.page + 1 : undefined,
    }),
  detail: (id: string) =>
    queryOptions({
      queryKey: layoutKeys.detail(id),
      queryFn: () => api.layout(id),
      enabled: Boolean(id),
    }),
  revisions: (id: string) =>
    queryOptions({
      queryKey: layoutKeys.revisions(id),
      queryFn: () => api.layoutRevisions(id),
      enabled: Boolean(id),
    }),
};

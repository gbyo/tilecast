import {
  infiniteQueryOptions,
  queryOptions,
} from "@tanstack/react-query";
import { api } from "../api/client";
import { hasNextPage } from "../api/pagination";

export const campaignKeys = {
  all: ["campaigns"] as const,
  pages: (search = "") => [...campaignKeys.all, "pages", search] as const,
  detail: (id: string) => [...campaignKeys.all, "detail", id] as const,
  preflight: (id: string) =>
    [...campaignKeys.detail(id), "preflight"] as const,
  releases: (id: string) => [...campaignKeys.detail(id), "releases"] as const,
  publicationHistory: (id: string) =>
    [...campaignKeys.detail(id), "publication-history"] as const,
};

export const campaignQueries = {
  pages: (search = "") =>
    infiniteQueryOptions({
      queryKey: campaignKeys.pages(search),
      initialPageParam: 1,
      queryFn: ({ pageParam }) => api.campaignPage(search, pageParam),
      getNextPageParam: (page) =>
        hasNextPage(page) ? page.page + 1 : undefined,
    }),
  detail: (id: string) =>
    queryOptions({
      queryKey: campaignKeys.detail(id),
      queryFn: () => api.campaign(id),
      enabled: Boolean(id),
    }),
  preflight: (id: string) =>
    queryOptions({
      queryKey: campaignKeys.preflight(id),
      queryFn: () => api.campaignPreflight(id),
      enabled: Boolean(id),
    }),
  releases: (id: string) =>
    queryOptions({
      queryKey: campaignKeys.releases(id),
      queryFn: () => api.campaignReleases(id),
      enabled: Boolean(id),
    }),
  publicationHistory: (id: string) =>
    queryOptions({
      queryKey: campaignKeys.publicationHistory(id),
      queryFn: () => api.publicationHistory("campaign", id),
      enabled: Boolean(id),
    }),
};

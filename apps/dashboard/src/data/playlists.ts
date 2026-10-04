import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "../api/client";
import { hasNextPage } from "../api/pagination";

export const playlistKeys = {
  all: ["playlists"] as const,
  list: (search = "") => [...playlistKeys.all, "list", { search }] as const,
  pages: (search = "") => [...playlistKeys.all, "library", search] as const,
  detail: (id: string) => [...playlistKeys.all, id] as const,
  revisionLists: ["playlist-revisions"] as const,
  revisions: (id: string) => [...playlistKeys.revisionLists, id] as const,
};

export const playlistQueries = {
  list: (search = "") =>
    queryOptions({
      queryKey: playlistKeys.list(search),
      queryFn: () => api.playlists(search),
    }),
  pages: (search = "") =>
    infiniteQueryOptions({
      queryKey: playlistKeys.pages(search),
      initialPageParam: 1,
      queryFn: ({ pageParam }) => api.playlistPage(search, pageParam),
      getNextPageParam: (page) =>
        hasNextPage(page) ? page.page + 1 : undefined,
    }),
  detail: (id: string) =>
    queryOptions({
      queryKey: playlistKeys.detail(id),
      queryFn: () => api.playlist(id),
      enabled: Boolean(id),
    }),
  revisions: (id: string) =>
    queryOptions({
      queryKey: playlistKeys.revisions(id),
      queryFn: () => api.playlistRevisions(id),
      enabled: Boolean(id),
    }),
};

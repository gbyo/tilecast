import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "../api/client";
import { hasNextPage } from "../api/pagination";

function assetFilters(params: URLSearchParams): string {
  const filters = new URLSearchParams(params);
  filters.delete("page");
  filters.sort();
  return filters.toString();
}

export const contentKeys = {
  assets: ["assets"] as const,
  asset: (id: string) => [...contentKeys.assets, id] as const,
  assetPages: (params: URLSearchParams) =>
    [...contentKeys.assets, "pages", assetFilters(params)] as const,
  definitions: ["content-definitions"] as const,
  folders: ["content-folders"] as const,
  collections: ["content-collections"] as const,
  tags: ["content-tags"] as const,
};

export const contentQueries = {
  assetPages: (params: URLSearchParams) => {
    const filters = assetFilters(params);
    return infiniteQueryOptions({
      queryKey: contentKeys.assetPages(new URLSearchParams(filters)),
      initialPageParam: 1,
      queryFn: ({ pageParam }) => {
        const request = new URLSearchParams(filters);
        request.set("page", String(pageParam));
        return api.assets(request);
      },
      getNextPageParam: (page) =>
        hasNextPage(page) ? page.page + 1 : undefined,
      refetchInterval: (query) =>
        query.state.data?.pages.some((page) =>
          page.items.some((asset) =>
            ["queued", "inspecting", "processing"].includes(
              asset.processingStatus,
            ),
          ),
        )
          ? 3000
          : false,
    });
  },
  asset: (id: string) =>
    queryOptions({
      queryKey: contentKeys.asset(id),
      queryFn: () => api.asset(id),
      enabled: Boolean(id),
    }),
  definitions: () =>
    queryOptions({
      queryKey: contentKeys.definitions,
      queryFn: () => api.contentDefinitions(),
    }),
  folders: () =>
    queryOptions({
      queryKey: contentKeys.folders,
      queryFn: () => api.contentFolders(),
    }),
  collections: () =>
    queryOptions({
      queryKey: contentKeys.collections,
      queryFn: () => api.contentCollections(),
    }),
  tags: () =>
    queryOptions({
      queryKey: contentKeys.tags,
      queryFn: () => api.contentTags(),
    }),
};

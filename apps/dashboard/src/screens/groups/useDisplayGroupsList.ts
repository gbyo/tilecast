import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { useSearchParams } from "react-router";
import { api } from "../../api/client";
import { hasNextPage } from "../../api/pagination";
import { useTypedFilter } from "../../components/FilterBar";
import { SCREEN_STATUS_REFRESH_MS, screenQueries } from "../../data/screens";
import { groupedScreenCount, screenInventory } from "./displayGroupModel";

/**
 * The Display Groups index data: URL-backed search (`?q=`) with a typing
 * pause, server-side paging, and the screen inventory that health is read
 * from.
 */
export function useDisplayGroupsList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get("q") ?? "";
  const setSearch = useCallback(
    (value: string) =>
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value) next.set("q", value);
          else next.delete("q");
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );
  const typedSearch = useTypedFilter(search, setSearch);

  const groups = useInfiniteQuery({
    queryKey: ["screen-groups", "page", { search }],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api.screenGroupPage(search, pageParam),
    getNextPageParam: (page) => (hasNextPage(page) ? page.page + 1 : undefined),
    placeholderData: keepPreviousData,
  });
  const inventory = useQuery({
    ...screenQueries.list(),
    refetchInterval: SCREEN_STATUS_REFRESH_MS,
  });

  const rows = groups.data?.pages.flatMap((page) => page.items) ?? [];
  return {
    search,
    setSearch,
    typedSearch,
    groups,
    rows,
    total: groups.data?.pages[0]?.total ?? rows.length,
    screens: screenInventory(inventory.data?.items),
    groupedScreens: groupedScreenCount(inventory.data?.items),
  };
}

import { useQueries } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { ScreenGroup } from "../../api/types";
import { apiErrorMessage } from "../../i18n";

/** Reliability reports for each member, which the AirPlay dialog needs. */
export function useDisplayGroupAirPlayCapabilities(
  members: ScreenGroup["screens"],
) {
  const queries = useQueries({
    queries: members.map((screen) => ({
      queryKey: ["screen-reliability", screen.id],
      queryFn: () => api.screenReliability(screen.id),
      refetchInterval: 10_000,
    })),
  });
  const failed = queries.find((query) => query.error);
  return {
    capabilities: queries.flatMap((query) => (query.data ? [query.data] : [])),
    loading: queries.some((query) => query.isPending),
    error: failed?.error ? apiErrorMessage(failed.error) : undefined,
  };
}

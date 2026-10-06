import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

/** Every saved Data Source, shared by every source control in Studio. */
export function useDataSourceLibrary(enabled = true) {
  return useQuery({
    queryKey: ["definition-form-data-sources"],
    queryFn: () =>
      api.listDataSources(
        new URLSearchParams({ page: "1", pageSize: "100", sort: "name" }),
      ),
    enabled,
  });
}

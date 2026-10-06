import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { api } from "../api/client";
import { hasNextPage } from "../api/pagination";
import type { ScheduleInput, ScheduleListParams } from "../api/types";

/** The unfiltered library in its default order. */
export const defaultScheduleListParams: ScheduleListParams = {
  search: "",
  enabled: "",
  type: "",
  presentationType: "",
  sort: "updated",
};

export const scheduleKeys = {
  all: ["schedules"] as const,
  list: (search = "") => [...scheduleKeys.all, "list", { search }] as const,
  // Search, every facet, and the sort all shape the server result, so all of
  // them are part of the key. View state is presentation only and is not.
  pages: (params: ScheduleListParams = defaultScheduleListParams) =>
    [...scheduleKeys.all, "pages", params] as const,
  detail: (id: string) => [...scheduleKeys.all, id] as const,
  defaults: () => [...scheduleKeys.all, "defaults"] as const,
  previews: ["schedule-preview"] as const,
  preview: (screenId: string, timestamp: string, proposed?: ScheduleInput) =>
    [...scheduleKeys.previews, screenId, timestamp, proposed] as const,
};

export const scheduleQueries = {
  list: (search = "") =>
    queryOptions({
      queryKey: scheduleKeys.list(search),
      queryFn: () => api.schedules(search),
    }),
  pages: (params: ScheduleListParams = defaultScheduleListParams) =>
    infiniteQueryOptions({
      queryKey: scheduleKeys.pages(params),
      initialPageParam: 1,
      queryFn: ({ pageParam }) => api.schedulePage(params, pageParam),
      getNextPageParam: (page) =>
        hasNextPage(page) ? page.page + 1 : undefined,
    }),
  detail: (id: string) =>
    queryOptions({
      queryKey: scheduleKeys.detail(id),
      queryFn: () => api.schedule(id),
      enabled: Boolean(id),
    }),
  defaults: () =>
    queryOptions({
      queryKey: scheduleKeys.defaults(),
      queryFn: () => api.schedules(),
    }),
  preview: (screenId: string, timestamp: string, proposed?: ScheduleInput) =>
    queryOptions({
      queryKey: scheduleKeys.preview(screenId, timestamp, proposed),
      queryFn: () => api.previewSchedule(screenId, timestamp, proposed),
      enabled: Boolean(screenId),
    }),
};

function invalidateSchedules(client: QueryClient) {
  void client.invalidateQueries({ queryKey: scheduleKeys.all });
  void client.invalidateQueries({ queryKey: scheduleKeys.previews });
}

export const scheduleMutations = {
  save: (client: QueryClient, csrf: string, id?: string) =>
    mutationOptions({
      mutationFn: (input: ScheduleInput) =>
        id
          ? api.updateSchedule(id, input, csrf)
          : api.createSchedule(input, csrf),
      onSuccess: () => invalidateSchedules(client),
    }),
  // The library deletes any row, so the id is the variable, not the factory's.
  removeById: (client: QueryClient, csrf: string) =>
    mutationOptions({
      mutationFn: (id: string) => api.deleteSchedule(id, csrf),
      onSuccess: () => invalidateSchedules(client),
    }),
  remove: (client: QueryClient, csrf: string, id: string) =>
    mutationOptions({
      mutationFn: () => api.deleteSchedule(id, csrf),
      onSuccess: () => invalidateSchedules(client),
    }),
};

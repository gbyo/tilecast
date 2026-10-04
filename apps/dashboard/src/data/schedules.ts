import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "../api/client";
import { hasNextPage } from "../api/pagination";
import type { ScheduleInput } from "../api/types";

export const scheduleKeys = {
  all: ["schedules"] as const,
  list: (search = "") => [...scheduleKeys.all, "list", { search }] as const,
  pages: (search = "") => [...scheduleKeys.all, "pages", { search }] as const,
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
  pages: (search = "") =>
    infiniteQueryOptions({
      queryKey: scheduleKeys.pages(search),
      initialPageParam: 1,
      queryFn: ({ pageParam }) => api.schedulePage(search, pageParam),
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

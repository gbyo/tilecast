import { QueryClient } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ScheduleInput } from "../api/types";
import { scheduleKeys, scheduleQueries } from "./schedules";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Schedule query contracts", () => {
  it("keeps all-results and infinite-page caches separate, including the legacy overview cache", async () => {
    server.use(
      http.get("*/api/v1/schedules", ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get("page"));
        return HttpResponse.json({
          data: {
            items: [{ id: `schedule-${page}`, name: `Schedule ${page}` }],
            total: 2,
            page,
            pageSize: 1,
            defaultTimezone: "America/New_York",
          },
        });
      }),
    );
    const client = new QueryClient();
    try {
      const legacy = { items: [{ id: "legacy" }], total: 1 };
      client.setQueryData(scheduleKeys.all, legacy);
      const list = await client.fetchQuery(scheduleQueries.list());
      const pages = await client.fetchInfiniteQuery({
        ...scheduleQueries.pages(),
        pages: 2,
      });
      expect(list.items.map((item) => item.id)).toEqual([
        "schedule-1",
        "schedule-2",
      ]);
      expect(pages.pageParams).toEqual([1, 2]);
      expect(pages.pages.map((page) => page.items[0]?.id)).toEqual([
        "schedule-1",
        "schedule-2",
      ]);
      expect(client.getQueryData(scheduleKeys.all)).toBe(legacy);
      await client.invalidateQueries({ queryKey: scheduleKeys.all });
      expect(
        client.getQueryState(scheduleQueries.list().queryKey)?.isInvalidated,
      ).toBe(true);
      expect(
        client.getQueryState(scheduleQueries.pages().queryKey)?.isInvalidated,
      ).toBe(true);
    } finally {
      client.clear();
    }
  });

  it("shares typed prefetched detail data with breadcrumb and editor consumers", async () => {
    let requests = 0;
    server.use(
      http.get("*/api/v1/schedules/morning", () => {
        requests++;
        return HttpResponse.json({
          data: { id: "morning", name: "Morning", priority: 7 },
        });
      }),
    );
    const client = new QueryClient();
    try {
      await client.prefetchQuery(scheduleQueries.detail("morning"));
      const cached = client.getQueryData(
        scheduleQueries.detail("morning").queryKey,
      );
      expect(cached?.priority).toBe(7);
      expect(
        await client.fetchQuery({
          ...scheduleQueries.detail("morning"),
          staleTime: Infinity,
        }),
      ).toBe(cached);
      expect(requests).toBe(1);
    } finally {
      client.clear();
    }
  });

  it("isolates previews by instant and proposal through the real POST contract", async () => {
    const timestamps: string[] = [];
    server.use(
      http.post("*/api/v1/schedules/preview", async ({ request }) => {
        const body = (await request.json()) as {
          timestamp: string;
          screenId: string;
          proposedSchedule?: ScheduleInput;
        };
        timestamps.push(body.timestamp);
        return HttpResponse.json({
          data: {
            screenId: body.screenId,
            timestamp: body.timestamp,
            selected: { name: body.proposedSchedule?.name },
          },
        });
      }),
    );
    const client = new QueryClient();
    const proposed: ScheduleInput = {
      name: "Morning",
      description: "",
      type: "weekly",
      timezone: "UTC",
      priority: 1,
      enabled: true,
      daysOfWeek: [1],
      targets: [{ type: "screen", id: "lobby" }],
    };
    const first = "2026-10-05T09:00:00Z";
    const second = "2026-10-12T09:00:00Z";
    try {
      const a = await client.fetchQuery({
        ...scheduleQueries.preview("lobby", first, proposed),
        staleTime: Infinity,
      });
      expect(
        await client.fetchQuery({
          ...scheduleQueries.preview("lobby", first, { ...proposed }),
          staleTime: Infinity,
        }),
      ).toBe(a);
      await client.fetchQuery(
        scheduleQueries.preview("lobby", second, proposed),
      );
      await client.fetchQuery(
        scheduleQueries.preview("lobby", first, { ...proposed, priority: 2 }),
      );
      expect(timestamps).toEqual([first, second, first]);
      await client.invalidateQueries({ queryKey: scheduleKeys.previews });
      expect(
        client.getQueryState(scheduleKeys.preview("lobby", first, proposed))
          ?.isInvalidated,
      ).toBe(true);
    } finally {
      client.clear();
    }
  });
});

import { QueryClient } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { activityKeys, activityQueries } from "./activity";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Activity query contracts", () => {
  it("isolates range caches and sends only API bounds, not a UI range label", async () => {
    const ranges: string[] = [];
    server.use(
      http.get("*/api/v1/activity/overview", ({ request }) => {
        const query = new URL(request.url).searchParams;
        expect([...query.keys()].sort()).toEqual(["from", "to"]);
        ranges.push(query.get("from") ?? "");
        return HttpResponse.json({
          data: { cards: { confirmedScreenPlaybackMs: 123 }, timeline: [] },
        });
      }),
    );
    const client = new QueryClient();
    const range = {
      from: "2026-10-01T00:00:00Z",
      to: "2026-10-02T00:00:00Z",
      label: "Last day",
    };
    try {
      await client.prefetchQuery(activityQueries.overview(range));
      const cached = client.getQueryData(
        activityQueries.overview(range).queryKey,
      );
      expect(cached?.cards.confirmedScreenPlaybackMs).toBe(123);
      const translatedRange = { ...range, label: "Otro idioma" };
      expect(
        await client.fetchQuery({
          ...activityQueries.overview(translatedRange),
          staleTime: Infinity,
        }),
      ).toBe(cached);
      await client.fetchQuery(
        activityQueries.overview({
          from: "2026-09-30T00:00:00Z",
          to: range.from,
        }),
      );
      expect(ranges).toEqual([range.from, "2026-09-30T00:00:00Z"]);
    } finally {
      client.clear();
    }
  });

  it("preserves unmeasured compliance as null and separates dimensions", async () => {
    const dimensions: string[] = [];
    server.use(
      http.get("*/api/v1/activity/compliance", ({ request }) => {
        const dimension = new URL(request.url).searchParams.get("dimension");
        dimensions.push(dimension ?? "");
        return HttpResponse.json({
          data: {
            measurableExpectedMs: 0,
            compliancePercent: null,
            dimension,
            breakdown: [],
          },
        });
      }),
    );
    const client = new QueryClient();
    try {
      const screen = await client.fetchQuery(
        activityQueries.compliance({ dimension: "screen" }),
      );
      expect(screen.compliancePercent).toBeNull();
      const location = await client.fetchQuery(
        activityQueries.compliance({ dimension: "location" }),
      );
      expect(location.dimension).toBe("location");
      expect(dimensions).toEqual(["screen", "location"]);
    } finally {
      client.clear();
    }
  });

  it("uses the incident contract's filters and retains related-event normalization", async () => {
    server.use(
      http.get("*/api/v1/activity/incidents", ({ request }) => {
        expect(new URL(request.url).searchParams.get("status")).toBe("active");
        return HttpResponse.json({ data: { items: [], total: 0 } });
      }),
      http.get("*/api/v1/activity/incidents/outage", () =>
        HttpResponse.json({
          data: {
            incident: { id: "outage", title: "Outage" },
            relatedEvents: [
              { id: "event", sequence: null, eventType: "connection.lost" },
            ],
          },
        }),
      ),
    );
    const client = new QueryClient();
    try {
      expect(
        (
          await client.fetchQuery(
            activityQueries.incidents({ status: "active" }),
          )
        ).items,
      ).toEqual([]);
      const detail = await client.fetchQuery(
        activityQueries.incident("outage"),
      );
      expect(detail.relatedEvents[0]?.sequence).toBeUndefined();
      expect(detail.relatedEvents[0]?.eventType).toBe("connection.lost");
    } finally {
      client.clear();
    }
  });

  it("invalidates incident lists, detail, and analytics without invalidating playback evidence", async () => {
    const client = new QueryClient();
    const keys = [
      activityKeys.incidentList({ status: "active" }),
      activityKeys.incidentList({ status: "recovered" }),
      activityKeys.incident("outage"),
      activityKeys.incidentAnalytics({}),
      activityKeys.overview({}),
      activityKeys.compliance({}),
      ["activity", "proof", "cursor"],
    ];
    try {
      for (const key of keys) client.setQueryData(key, {});
      await client.invalidateQueries({ queryKey: activityKeys.incidents });
      for (const key of keys)
        expect(client.getQueryState(key)?.isInvalidated).toBe(
          key[1] === "incidents",
        );
    } finally {
      client.clear();
    }
  });
});

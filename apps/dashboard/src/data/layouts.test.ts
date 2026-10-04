import { QueryClient } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { layoutKeys, layoutQueries } from "./layouts";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Layout query contracts", () => {
  it("shares the API-normalized draft between editor and preview consumers", async () => {
    let requests = 0;
    server.use(
      http.get("*/api/v1/layouts/lobby", () => {
        requests++;
        return HttpResponse.json({
          data: {
            id: "lobby",
            name: "Lobby",
            orientation: "landscape",
            canvasWidth: 1920,
            canvasHeight: 1080,
            draft: null,
            dependencies: null,
            usage: null,
            draftRevision: 3,
          },
        });
      }),
    );
    const client = new QueryClient();
    try {
      await client.prefetchQuery(layoutQueries.detail("lobby"));
      const cached = client.getQueryData(
        layoutQueries.detail("lobby").queryKey,
      );
      expect(cached?.draft.canvas.width).toBe(1920);
      expect(cached?.draft.placements).toEqual([]);
      expect(cached?.dependencies).toEqual([]);
      expect(cached?.usage.screens).toEqual([]);
      expect(
        await client.fetchQuery({
          ...layoutQueries.detail("lobby"),
          staleTime: Infinity,
        }),
      ).toBe(cached);
      expect(requests).toBe(1);
    } finally {
      client.clear();
    }
  });

  it("keeps complete-list and searched two-page results independent", async () => {
    const searches: string[] = [];
    server.use(
      http.get("*/api/v1/layouts", ({ request }) => {
        const query = new URL(request.url).searchParams;
        searches.push(query.get("search") ?? "");
        const page = Number(query.get("page"));
        return HttpResponse.json({
          data: {
            items: [{ id: `layout-${page}`, name: "Lobby" }],
            total: 2,
            page,
            pageSize: 1,
          },
        });
      }),
    );
    const client = new QueryClient();
    try {
      const list = await client.fetchQuery(layoutQueries.list("Lobby"));
      const pages = await client.fetchInfiniteQuery({
        ...layoutQueries.pages("Lobby"),
        pages: 2,
      });
      expect(list.items.map((item) => item.id)).toEqual([
        "layout-1",
        "layout-2",
      ]);
      expect(pages.pageParams).toEqual([1, 2]);
      expect(
        pages.pages.flatMap((page) => page.items).map((item) => item.id),
      ).toEqual(["layout-1", "layout-2"]);
      expect(searches).toEqual(Array(4).fill("Lobby"));
    } finally {
      client.clear();
    }
  });

  it("invalidates a Layout's detail and revisions together, or the complete domain", async () => {
    const client = new QueryClient();
    const keys = [
      layoutKeys.detail("lobby"),
      layoutKeys.revisions("lobby"),
      layoutKeys.detail("library"),
      layoutKeys.list(),
      layoutKeys.pages(),
    ];
    try {
      for (const key of keys) client.setQueryData(key, {});
      await client.invalidateQueries({ queryKey: layoutKeys.detail("lobby") });
      for (const key of keys)
        expect(client.getQueryState(key)?.isInvalidated).toBe(
          key[2] === "lobby",
        );
      await client.invalidateQueries({ queryKey: layoutKeys.all });
      for (const key of keys)
        expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    } finally {
      client.clear();
    }
  });
});

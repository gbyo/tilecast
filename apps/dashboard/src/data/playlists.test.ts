import { QueryClient } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { playlistKeys, playlistQueries } from "./playlists";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Playlist query contracts", () => {
  it("shares normalized detail data across editor, preview, and dependency consumers", async () => {
    let requests = 0;
    server.use(
      http.get("*/api/v1/playlists/morning", () => {
        requests++;
        return HttpResponse.json({
          data: {
            id: "morning",
            name: "Morning",
            items: null,
            warnings: null,
            layoutUsage: null,
            dataSourceIds: ["weather"],
            draftRevision: 4,
          },
        });
      }),
    );
    const client = new QueryClient();
    try {
      await client.prefetchQuery(playlistQueries.detail("morning"));
      const cached = client.getQueryData(
        playlistQueries.detail("morning").queryKey,
      );
      expect(cached?.items).toEqual([]);
      expect(cached?.warnings).toEqual([]);
      expect(cached?.dataSourceIds).toEqual(["weather"]);
      expect(
        await client.fetchQuery({
          ...playlistQueries.detail("morning"),
          staleTime: Infinity,
        }),
      ).toBe(cached);
      expect(requests).toBe(1);
      if (!cached) throw new Error("Missing prefetched Playlist");
      client.setQueryData(playlistQueries.detail("morning").queryKey, {
        ...cached,
        draftRevision: 5,
      });
      expect(
        (
          await client.fetchQuery({
            ...playlistQueries.detail("morning"),
            staleTime: Infinity,
          })
        ).draftRevision,
      ).toBe(5);
      expect(requests).toBe(1);
    } finally {
      client.clear();
    }
  });

  it("fetches searched pages independently of complete-list consumers", async () => {
    const searches: string[] = [];
    server.use(
      http.get("*/api/v1/playlists", ({ request }) => {
        const query = new URL(request.url).searchParams;
        searches.push(query.get("search") ?? "");
        const page = Number(query.get("page"));
        return HttpResponse.json({
          data: {
            items: [{ id: `playlist-${page}`, name: "Morning", items: [] }],
            page,
            pageSize: 1,
            total: 2,
          },
        });
      }),
    );
    const client = new QueryClient();
    try {
      const list = await client.fetchQuery(playlistQueries.list("Morning"));
      const pages = await client.fetchInfiniteQuery({
        ...playlistQueries.pages("Morning"),
        pages: 2,
      });
      expect(list.items.map((item) => item.id)).toEqual([
        "playlist-1",
        "playlist-2",
      ]);
      expect(pages.pageParams).toEqual([1, 2]);
      expect(
        pages.pages.flatMap((page) => page.items).map((item) => item.id),
      ).toEqual(["playlist-1", "playlist-2"]);
      expect(searches).toEqual(Array(4).fill("Morning"));
      await client.invalidateQueries({ queryKey: playlistKeys.all });
      expect(
        client.getQueryState(playlistQueries.list("Morning").queryKey)
          ?.isInvalidated,
      ).toBe(true);
      expect(
        client.getQueryState(playlistQueries.pages("Morning").queryKey)
          ?.isInvalidated,
      ).toBe(true);
    } finally {
      client.clear();
    }
  });
});

import { QueryClient } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { contentQueries } from "./content";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Content query contracts", () => {
  it("shares equivalent filters, preserves them on every page, and snapshots caller parameters", async () => {
    const pages: number[] = [];
    server.use(
      http.get("*/api/v1/assets", ({ request }) => {
        const query = new URL(request.url).searchParams;
        expect(query.get("search")).toBe("Main | image");
        expect(query.get("archived")).toBe("true");
        expect(query.get("provider")).toBe("website");
        expect(query.get("type")).toBe("widget");
        expect(query.get("folderId")).toBe("folder");
        const page = Number(query.get("page"));
        pages.push(page);
        return HttpResponse.json({
          data: {
            items: [{ id: `asset-${page}`, processingStatus: "ready" }],
            total: 2,
            page,
            pageSize: 1,
          },
        });
      }),
    );
    const params = new URLSearchParams({
      search: "Main | image",
      archived: "true",
      provider: "website",
      type: "widget",
      folderId: "folder",
      pageSize: "1",
      page: "99",
    });
    const options = contentQueries.assetPages(params);
    const equivalent = new URLSearchParams([...params.entries()].reverse());
    equivalent.delete("page");
    params.set("search", "A later caller edit");
    const client = new QueryClient();
    try {
      const data = await client.fetchInfiniteQuery({ ...options, pages: 2 });
      expect(data.pageParams).toEqual([1, 2]);
      expect(
        data.pages.flatMap((page) => page.items).map((asset) => asset.id),
      ).toEqual(["asset-1", "asset-2"]);
      expect(
        await client.fetchInfiniteQuery({
          ...contentQueries.assetPages(equivalent),
          staleTime: Infinity,
        }),
      ).toBe(data);
      expect(pages).toEqual([1, 2]);
    } finally {
      client.clear();
    }
  });

  it("isolates archive, provider, and page-size changes", async () => {
    const requests: string[] = [];
    server.use(
      http.get("*/api/v1/assets", ({ request }) => {
        const query = new URL(request.url).searchParams;
        requests.push(query.toString());
        return HttpResponse.json({
          data: {
            items: [],
            total: 0,
            page: 1,
            pageSize: Number(query.get("pageSize")),
          },
        });
      }),
    );
    const client = new QueryClient();
    try {
      const filterCases: Record<string, string>[] = [
        { pageSize: "48" },
        { pageSize: "48", archived: "true" },
        { pageSize: "48", provider: "website" },
        { pageSize: "100" },
      ];
      for (const filters of filterCases) {
        await client.fetchInfiniteQuery({
          ...contentQueries.assetPages(new URLSearchParams(filters)),
          staleTime: Infinity,
        });
      }
      expect(requests).toHaveLength(4);
    } finally {
      client.clear();
    }
  });

  it("retains the API's definition normalization and shares prefetched catalogs", async () => {
    let requests = 0;
    server.use(
      http.get("*/api/v1/content-definitions", () => {
        requests++;
        return HttpResponse.json({
          data: {
            widgets: [{ id: "example", defaultConfiguration: null }],
            dataSources: null,
          },
        });
      }),
    );
    const client = new QueryClient();
    try {
      await client.prefetchQuery(contentQueries.definitions());
      const cached = client.getQueryData(contentQueries.definitions().queryKey);
      expect(cached?.widgets[0]?.defaultConfiguration).toEqual({});
      expect(cached?.dataSources).toEqual([]);
      expect(
        await client.fetchQuery({
          ...contentQueries.definitions(),
          staleTime: Infinity,
        }),
      ).toBe(cached);
      expect(requests).toBe(1);
    } finally {
      client.clear();
    }
  });
});

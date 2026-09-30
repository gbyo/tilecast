import { describe, expect, it, vi } from "vitest";
import { fetchAllPages, hasNextPage } from "./pagination";

describe("page metadata", () => {
  it("offers another page while records remain", () => {
    expect(hasNextPage({ page: 1, pageSize: 100, total: 101 })).toBe(true);
    expect(hasNextPage({ page: 2, pageSize: 100, total: 101 })).toBe(false);
  });

  it("collects pages in order until the server reports the end", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [1, 2],
        total: 3,
        page: 1,
        pageSize: 2,
      })
      .mockResolvedValueOnce({
        items: [3],
        total: 3,
        page: 2,
        pageSize: 2,
      });

    await expect(fetchAllPages(fetchPage)).resolves.toMatchObject({
      items: [1, 2, 3],
      total: 3,
      page: 1,
      pageSize: 2,
    });
    expect(fetchPage.mock.calls).toEqual([[1], [2]]);
  });
});

// @vitest-environment jsdom
// The chain answers "why does this screen look stale?" by walking from the assignment down to the
// Data Sources feeding it. The playlist leg used to stop at the Widget list, because resolving each
// Widget's sources client-side would have been one detail request per item; the playlist detail
// read now reports them, so both assignment kinds resolve the whole way.
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { DataSource, Layout, Playlist } from "../api/types";
import { ScreenContentChain } from "./ScreenContentChain";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function source(id: string, name: string, status = "ready"): DataSource {
  return {
    id,
    provider: "csv",
    name,
    description: "",
    configVersion: 2,
    configuration: {},
    status,
    cachedRecordCount: 4,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function chain(assignment: {
  playlistId?: string;
  playlistName?: string;
  layoutId?: string;
  layoutName?: string;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ScreenContentChain
          assignment={
            assignment as Parameters<typeof ScreenContentChain>[0]["assignment"]
          }
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScreenContentChain playlist leg", () => {
  it("resolves the Data Sources a playlist reaches, with their status", async () => {
    vi.spyOn(api, "listDataSources").mockResolvedValue({
      items: [
        source("src-1", "Lunch rows"),
        source("src-2", "Allergen notes", "error"),
        source("src-3", "Unrelated feed"),
      ],
      total: 3,
      page: 1,
      pageSize: 100,
    });
    vi.spyOn(api, "playlist").mockResolvedValue({
      id: "playlist-1",
      name: "Cafeteria loop",
      itemCount: 1,
      items: [
        {
          id: "item-1",
          assetId: "widget-1",
          assetName: "Today's Lunch",
          assetType: "widget",
        },
      ],
      dataSourceIds: ["src-1", "src-2"],
    } as unknown as Playlist);

    chain({ playlistId: "playlist-1", playlistName: "Cafeteria loop" });

    expect(
      await screen.findByRole("link", { name: /Lunch rows/ }),
    ).toHaveAttribute("href", "/data-sources/src-1");
    // A failed refresh is visible from the screen, which is the point of the panel.
    expect(
      screen.getByRole("link", { name: /Allergen notes/ }),
    ).toHaveTextContent("Last refresh failed");
    // Sources the playlist does not reach stay out.
    expect(screen.queryByText("Unrelated feed")).toBeNull();
  });

  it("says so when a playlist reads no data at all", async () => {
    vi.spyOn(api, "listDataSources").mockResolvedValue({
      items: [source("src-1", "Lunch rows")],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    vi.spyOn(api, "playlist").mockResolvedValue({
      id: "playlist-1",
      name: "Images only",
      itemCount: 1,
      items: [],
      dataSourceIds: [],
    } as unknown as Playlist);

    chain({ playlistId: "playlist-1", playlistName: "Images only" });

    expect(
      await screen.findByText(/Nothing in this playlist reads a data source/i),
    ).toBeTruthy();
  });

  it("still resolves a Layout assignment through its stored dependencies", async () => {
    vi.spyOn(api, "listDataSources").mockResolvedValue({
      items: [source("src-1", "Lunch rows"), source("src-9", "Other")],
      total: 2,
      page: 1,
      pageSize: 100,
    });
    vi.spyOn(api, "layout").mockResolvedValue({
      id: "layout-1",
      name: "Cafeteria Layout",
      dependencies: [
        { type: "data_source", id: "src-1" },
        { type: "widget", id: "widget-1" },
      ],
    } as unknown as Layout);

    chain({ layoutId: "layout-1", layoutName: "Cafeteria Layout" });

    expect(
      await screen.findByRole("link", { name: /Lunch rows/ }),
    ).toHaveAttribute("href", "/data-sources/src-1");
    expect(screen.queryByText("Other")).toBeNull();
  });

  it("explains the absence of a direct assignment", () => {
    chain({});
    expect(
      screen.getByText(/No content is assigned directly to this screen/),
    ).toHaveTextContent(
      "Schedules and Display Group assignments can still select content for playback.",
    );
  });
});

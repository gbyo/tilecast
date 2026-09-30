// @vitest-environment jsdom
// The chain answers "why does this screen look stale?" by walking from the assignment down to the
// Data Sources feeding it. The playlist leg used to stop at the Widget list, because resolving each
// Widget's sources client-side would have been one detail request per item; the playlist detail
// read now reports them, so both assignment kinds resolve the whole way.
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api/client";
import type {
  DataSource,
  DataSourceDetail,
  Layout,
  Playlist,
} from "../api/types";
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

function mockSources(byId: Record<string, DataSource>, missing: string[] = []) {
  return vi.spyOn(api, "getDataSource").mockImplementation((id: string) => {
    if (missing.includes(id))
      return Promise.reject(new ApiError("Not found", 404, "not_found"));
    const found = byId[id];
    if (!found) throw new Error(`unexpected source request: ${id}`);
    return Promise.resolve(found as unknown as DataSourceDetail);
  });
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
    const user = userEvent.setup();
    const list = vi.spyOn(api, "listDataSources");
    const details = mockSources({
      "src-1": source("src-1", "Lunch rows"),
      "src-2": source("src-2", "Allergen notes", "error"),
    });
    vi.spyOn(api, "playlist").mockResolvedValue({
      id: "playlist-1",
      name: "Cafeteria loop",
      revision: 7,
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

    const playlistLink = await screen.findByRole("link", {
      name: /Cafeteria loop/,
    });
    expect(playlistLink).toHaveAttribute("href", "/playlists/playlist-1");
    await user.hover(playlistLink);
    expect(await screen.findByText(/revision 7/)).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: /Lunch rows/ }),
    ).toHaveAttribute("href", "/data-sources/src-1");
    // A failed refresh is visible from the screen, which is the point of the panel.
    expect(
      screen.getByRole("link", { name: /Allergen notes/ }),
    ).toHaveTextContent("Last refresh failed");
    // Known IDs resolve directly; the catalog is never listed.
    expect(list).not.toHaveBeenCalled();
    expect(details.mock.calls.map(([id]) => id).sort()).toEqual([
      "src-1",
      "src-2",
    ]);
  });

  it("marks a deleted dependency instead of silently dropping it", async () => {
    mockSources({ "src-1": source("src-1", "Lunch rows") }, ["src-gone"]);
    vi.spyOn(api, "playlist").mockResolvedValue({
      id: "playlist-1",
      name: "Cafeteria loop",
      revision: 7,
      itemCount: 1,
      items: [],
      dataSourceIds: ["src-1", "src-gone"],
    } as unknown as Playlist);

    chain({ playlistId: "playlist-1", playlistName: "Cafeteria loop" });

    expect(
      await screen.findByRole("link", { name: /Lunch rows/ }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Linked data source src-gone is unavailable."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Nothing in this playlist reads a data source/i),
    ).toBeNull();
  });

  it("says so when a playlist reads no data at all", async () => {
    const details = mockSources({});
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
    expect(details).not.toHaveBeenCalled();
  });

  it("still resolves a Layout assignment through its stored dependencies", async () => {
    const user = userEvent.setup();
    const details = mockSources({ "src-1": source("src-1", "Lunch rows") });
    vi.spyOn(api, "layout").mockResolvedValue({
      id: "layout-1",
      name: "Cafeteria Layout",
      canvasWidth: 1920,
      canvasHeight: 1080,
      dependencies: [
        { type: "data_source", id: "src-1" },
        { type: "widget", id: "widget-1" },
      ],
    } as unknown as Layout);

    chain({ layoutId: "layout-1", layoutName: "Cafeteria Layout" });

    const layoutLink = await screen.findByRole("link", {
      name: /Cafeteria Layout/,
    });
    expect(layoutLink).toHaveAttribute("href", "/layouts/layout-1");
    await user.hover(layoutLink);
    expect(
      await screen.findByText("1920 × 1080 px · 1 data source"),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: /Lunch rows/ }),
    ).toHaveAttribute("href", "/data-sources/src-1");
    expect(details.mock.calls.map(([id]) => id)).toEqual(["src-1"]);
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

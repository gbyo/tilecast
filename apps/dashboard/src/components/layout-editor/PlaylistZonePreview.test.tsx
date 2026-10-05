// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Asset, LayoutPlacement, Playlist } from "../../api/types";
import { PlaylistZonePreview } from "./WidgetLivePreview";

vi.mock("../../settings/regionalProfile", () => ({
  useOrganizationRegionalProfile: () => ({ ready: true, timezone: "UTC" }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("wakes for far-future availability without overflowing the browser timeout", async () => {
  vi.useFakeTimers();
  const start = Date.parse("2026-10-02T12:00:00Z");
  const wait = 60 * 24 * 60 * 60 * 1000;
  vi.setSystemTime(start);
  const playlist: Playlist = {
    id: "playlist",
    name: "Rotation",
    revision: 1,
    description: "",
    createdAt: new Date(start).toISOString(),
    updatedAt: new Date(start).toISOString(),
    itemCount: 1,
    warnings: [],
    layoutUsage: [],
    items: [
      {
        id: "item",
        assetId: "image",
        assetType: "image",
        assetName: "Future image",
        assetStatus: "ready",
        durationMs: 10_000,
        fitMode: "contain",
        transition: "none",
        position: 0,
        audioEnabled: false,
        volume: 0,
        deliveryPolicy: "download",
        thumbnailUrl: "",
        availableFrom: new Date(start + wait).toISOString(),
      },
    ],
  };
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(["settings"], { values: {} });
  const view = render(
    <QueryClientProvider client={client}>
      <PlaylistZonePreview
        playlist={playlist}
        placement={{ width: 1920, height: 1080 } as LayoutPlacement}
        assetsById={
          new Map([["image", { id: "image", type: "image" } as Asset]])
        }
      />
    </QueryClientProvider>,
  );
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.container.textContent).not.toContain("Only images and videos");
  expect(vi.getTimerCount()).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(2_147_483_647));
  expect(view.container.querySelector("img")).toBeNull();
  expect(vi.getTimerCount()).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(2_147_483_647));
  expect(view.container.querySelector("img")).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(wait - 2 * 2_147_483_647 + 1));
  expect(view.container.querySelector("img")?.getAttribute("src")).toContain(
    "image",
  );
  view.unmount();
  client.clear();
  expect(vi.getTimerCount()).toBe(0);
});

it("evaluates a selected preview date instead of the live clock", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2050-01-01T00:00:00Z"));
  const playlist = {
    id: "playlist",
    name: "Rotation",
    revision: 1,
    items: [
      {
        id: "item",
        assetId: "image",
        assetType: "image",
        assetStatus: "ready",
        availableFrom: "2026-10-03T00:00:00Z",
        expiresAt: "2026-10-04T00:00:00Z",
        durationMs: 10000,
        fitMode: "contain",
        transition: "none",
        audioEnabled: false,
        volume: 0,
      },
    ],
  } as Playlist;
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(["settings"], { values: {} });
  const assets = new Map([["image", { id: "image", type: "image" } as Asset]]);
  const preview = (date: string) => (
    <QueryClientProvider client={client}>
      <PlaylistZonePreview
        playlist={playlist}
        placement={{ width: 1920, height: 1080 } as LayoutPlacement}
        assetsById={assets}
        previewDate={date}
      />
    </QueryClientProvider>
  );
  const view = render(preview("2026-10-02"));
  expect(view.container.querySelector("img")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  view.rerender(preview("2026-10-03"));
  expect(view.container.querySelector("img")).not.toBeNull();
  view.rerender(preview("2026-10-04"));
  expect(view.container.querySelector("img")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  view.unmount();
  client.clear();
});

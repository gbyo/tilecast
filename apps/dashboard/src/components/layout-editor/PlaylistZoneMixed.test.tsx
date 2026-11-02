// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Asset,
  LayoutPlacement,
  Playlist,
  PlaylistItem,
} from "../../api/types";
import { PlaylistZonePreview } from "./WidgetLivePreview";

const mounts = vi.hoisted(
  () =>
    [] as {
      item: PlaylistItem;
      frame: { width: number; height: number };
      previewDate?: string;
      onReady: () => void;
      onError: () => void;
    }[],
);
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "fixture" } }),
}));
vi.mock("../../settings/regionalProfile", () => ({
  useOrganizationRegionalProfile: () => ({ ready: true, timezone: "UTC" }),
}));
vi.mock("../../content/PlaylistWidgetPreview", () => ({
  PlaylistWidgetPreview: (props: (typeof mounts)[number]) => {
    mounts.push(props);
    return (
      <div data-widget={props.item.id}>
        <button onClick={props.onReady}>Ready</button>
        <button onClick={props.onError}>Fail</button>
      </div>
    );
  },
}));
afterEach(() => {
  cleanup();
  mounts.length = 0;
  vi.useRealTimers();
});

it("shares zone timing and the existing Widget preview at zone dimensions while its neighbor holds", async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(["settings"], { values: {} });
  const items = ["image", "widget", "video", "widget"].map(
    (assetType, index) => ({
      id: String(index),
      assetId: String(index),
      assetType,
      assetStatus: "ready",
      durationMs: 100,
      fitMode: "contain",
      transition: "none",
      audioEnabled: false,
      volume: 0,
      videoEndOffsetMs: assetType === "video" ? 2000 : null,
    }),
  ) as PlaylistItem[];
  const playlist = {
    id: "mixed",
    revision: 1,
    name: "Mixed",
    items,
  } as Playlist;
  const assets = new Map(
    items.map((item) => [
      item.assetId,
      { id: item.assetId, type: item.assetType } as Asset,
    ]),
  );
  const neighbor = {
    ...playlist,
    id: "neighbor",
    items: [{ ...items[0]!, id: "neighbor-image", durationMs: 10000 }],
  };
  const placement = {
    width: 333,
    height: 222,
    playback: { loop: false },
  } as LayoutPlacement;
  const view = render(
    <QueryClientProvider client={client}>
      <section>
        <PlaylistZonePreview
          playlist={playlist}
          placement={placement}
          assetsById={assets}
          previewDate="2026-10-13"
        />
      </section>
      <aside>
        <PlaylistZonePreview
          playlist={neighbor}
          placement={placement}
          assetsById={assets}
        />
      </aside>
    </QueryClientProvider>,
  );
  const section = view.container.querySelector("section")!;
  const adjacent = view.container.querySelector("aside img")!;
  fireEvent.load(section.querySelector("img")!);
  fireEvent.load(adjacent);
  await act(() => vi.advanceTimersByTime(100));
  expect(
    section.querySelector("[data-widget]")?.getAttribute("data-widget"),
  ).toBe("1");
  expect(mounts.at(-1)?.frame).toEqual({ width: 333, height: 222 });
  expect(mounts.at(-1)?.previewDate).toBe("2026-10-13");
  await act(() => vi.advanceTimersByTime(1000));
  expect(section.querySelector("video")).toBeNull();
  const stale = mounts.at(-1)!;
  fireEvent.click(section.querySelector("button")!);
  await act(() => vi.advanceTimersByTime(100));
  const video = section.querySelector("video")!;
  fireEvent.loadedData(video);
  video.currentTime = 2;
  fireEvent.timeUpdate(video);
  expect(
    section.querySelector("[data-widget]")?.getAttribute("data-widget"),
  ).toBe("3");
  act(() => {
    stale.onReady();
    stale.onError();
  });
  expect(
    section.querySelector("[data-widget]")?.getAttribute("data-widget"),
  ).toBe("3");
  expect(view.container.querySelector("aside img")).toBe(adjacent);
  view.unmount();
  client.clear();
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(vi.getTimerCount()).toBe(0);
});

it("retains an explicit nested-Layout restriction while accepting every Widget provider", async () => {
  const { playlistZoneIssue } = await import("./playlistZoneIssues");
  const items = ["clock", "website", "youtube", "acme.scoreboard"].map(
    (widgetProvider, index) => ({
      id: String(index),
      assetName: widgetProvider,
      assetType: "widget",
      widgetProvider,
    }),
  ) as PlaylistItem[];
  expect(
    playlistZoneIssue(
      { id: "zone", name: "Zone" },
      { id: "playlist", name: "Playlist", items },
    ),
  ).toBeNull();
  items.push({
    id: "layout",
    assetName: "Nested Layout",
    assetType: "layout",
    layoutId: "layout",
  } as PlaylistItem);
  expect(
    playlistZoneIssue(
      { id: "zone", name: "Zone" },
      { id: "playlist", name: "Playlist", items },
    )?.items,
  ).toEqual([{ id: "layout", name: "Nested Layout", kind: "layout" }]);
});

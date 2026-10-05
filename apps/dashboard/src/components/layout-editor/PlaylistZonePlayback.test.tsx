// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Asset, LayoutPlacement, Playlist } from "../../api/types";
import { PlaylistZonePreview } from "./WidgetLivePreview";
import fixtures from "../../../../../packages/presentation-model/fixtures/zone-policy.json";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(fixtures.fallback)("$name", async (fixture) => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(["settings"], { values: {} });
  const playlist = {
    id: "playlist",
    name: "Rotation",
    revision: 1,
    items: ["first", "second"].map((id) => ({
      id,
      assetId: id,
      assetType: "image",
      assetStatus: "ready",
      durationMs: 100,
      fitMode: "contain",
      transition: "none",
      audioEnabled: false,
      volume: 0,
    })),
  } as Playlist;
  const view = render(
    <QueryClientProvider client={client}>
      <PlaylistZonePreview
        playlist={playlist}
        placement={
          {
            width: 100,
            height: 100,
            playback: { loop: false, fallback: fixture.fallback },
          } as LayoutPlacement
        }
        assetsById={
          new Map(
            ["first", "second"].map((id) => [
              id,
              { id, type: "image" } as Asset,
            ]),
          )
        }
      />
    </QueryClientProvider>,
  );
  const first = view.container.querySelector("img")!;
  if (fixture.hasPrevious) fireEvent.load(first);
  await act(() => vi.advanceTimersByTime(100));
  const current = view.container.querySelector("img")!;
  expect(current.getAttribute("src")).toContain("second");
  if (fixture.failed) fireEvent.error(current);
  const shown = view.container.querySelector("img");
  if (fixture.expected === "previous")
    expect(shown?.getAttribute("src")).toContain("first");
  else if (fixture.expected === "current") expect(shown).toBe(current);
  else expect(shown).toBeNull();
  if (fixture.expected === "hide")
    expect(view.container.childElementCount).toBe(0);
  else expect(view.container.childElementCount).toBe(1);
  view.unmount();
  client.clear();
});

it.each([true, false])(
  "honors a trimmed video's boundaries with loop=%s",
  async (loop) => {
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue();
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
    const playlist: Playlist = {
      id: "playlist",
      name: "Clips",
      description: "",
      revision: 1,
      createdAt: "2026-10-02T12:00:00Z",
      updatedAt: "2026-10-02T12:00:00Z",
      itemCount: 1,
      warnings: [],
      layoutUsage: [],
      items: [
        {
          id: "clip",
          assetId: "video",
          assetType: "video",
          assetName: "Clip",
          assetStatus: "ready",
          position: 0,
          fitMode: "contain",
          transition: "none",
          audioEnabled: false,
          volume: 0,
          deliveryPolicy: "download",
          thumbnailUrl: "",
          videoStartOffsetMs: 2_000,
          videoEndOffsetMs: 5_000,
        },
      ],
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <PlaylistZonePreview
          playlist={playlist}
          placement={
            { width: 1920, height: 1080, playback: { loop } } as LayoutPlacement
          }
          assetsById={
            new Map([["video", { id: "video", type: "video" } as Asset]])
          }
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(client.getQueryState(["settings"])?.status).toBe("success"),
    );
    const video = view.container.querySelector("video")!;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(2);
    video.currentTime = 5;
    fireEvent.timeUpdate(video);
    expect(pause).toHaveBeenCalledOnce();
    expect(video.currentTime).toBe(loop ? 2 : 5);
    expect(play).toHaveBeenCalledTimes(loop ? 1 : 0);
    expect(view.container.querySelector("video")).toBe(video);
    if (loop) {
      video.currentTime = 12;
      fireEvent.ended(video);
      expect(video.currentTime).toBe(2);
      expect(play).toHaveBeenCalledTimes(2);
    }
    view.unmount();
    client.clear();
  },
);

it("advances from the displayed occurrence when the item count shrinks", async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(["settings"], { values: {} });
  const assets = new Map(
    Array.from({ length: 5 }, (_, index) => {
      const id = String(index);
      return [id, { id, type: "image" } as Asset];
    }),
  );
  const preview = (count: number) => (
    <QueryClientProvider client={client}>
      <PlaylistZonePreview
        playlist={
          {
            id: "playlist",
            name: "Rotation",
            revision: 1,
            items: Array.from({ length: count }, (_, index) => ({
              id: String(index),
              assetId: String(index),
              assetType: "image",
              assetStatus: "ready",
              durationMs: 100,
              fitMode: "contain",
              transition: "none",
              audioEnabled: false,
              volume: 0,
            })),
          } as Playlist
        }
        placement={
          {
            width: 100,
            height: 100,
            playback: { loop: true },
          } as LayoutPlacement
        }
        assetsById={assets}
      />
    </QueryClientProvider>
  );
  const view = render(preview(5));
  for (let i = 0; i < 4; i++) await act(() => vi.advanceTimersByTime(100));
  expect(view.container.querySelector("img")?.getAttribute("src")).toContain(
    "/4/",
  );
  view.rerender(preview(3));
  expect(view.container.querySelector("img")?.getAttribute("src")).toContain(
    "/1/",
  );
  await act(() => vi.advanceTimersByTime(100));
  expect(view.container.querySelector("img")?.getAttribute("src")).toContain(
    "/2/",
  );
  view.unmount();
  client.clear();
});

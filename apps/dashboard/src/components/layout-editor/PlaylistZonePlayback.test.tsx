// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Asset, LayoutPlacement, Playlist } from "../../api/types";
import { PlaylistZonePreview } from "./WidgetLivePreview";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type {
  LayoutDocument,
  LayoutPlacement,
  Playlist,
  PlaylistItem,
} from "../../api/types";
import { LayoutPlacementView } from "./LayoutPlacementView";
import { PlaylistZoneIssueAlert } from "./PlaylistZoneIssueAlert";
import {
  playlistZoneIssue,
  playlistZones,
  usePlaylistZoneIssues,
} from "./playlistZoneIssues";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, api: { ...actual.api, playlist: vi.fn() } };
});

const item = (
  id: string,
  assetName: string,
  assetType: PlaylistItem["assetType"],
  extra: Partial<PlaylistItem> = {},
): PlaylistItem => ({
  id,
  assetId: `asset-${id}`,
  position: 0,
  fitMode: "contain",
  transition: "none",
  audioEnabled: false,
  volume: 0,
  deliveryPolicy: "download",
  assetName,
  assetType,
  assetStatus: "ready",
  thumbnailUrl: "",
  ...extra,
});

const playlist = (
  items: PlaylistItem[],
  name = "Morning Announcements",
): Playlist => ({
  id: "playlist-1",
  name,
  description: "",
  revision: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  items,
  itemCount: items.length,
  warnings: [],
  layoutUsage: [],
});

const zone = (over: Partial<LayoutPlacement> = {}): LayoutPlacement => ({
  id: "zone-1",
  type: "playlistZone",
  name: "Announcements",
  playlistId: "playlist-1",
  x: 0,
  y: 0,
  width: 640,
  height: 360,
  layer: 0,
  opacity: 1,
  visible: true,
  locked: false,
  ...over,
});

describe("playlist zone media support", () => {
  const cases: [string, PlaylistItem, string | null][] = [
    ["image", item("i", "Logo", "image"), null],
    ["video", item("v", "Intro", "video"), null],
    [
      "Widget",
      item("w", "Weather", "widget", { widgetProvider: "weather" }),
      null,
    ],
    [
      "Website",
      item("s", "School Website", "widget", { widgetProvider: "website" }),
      null,
    ],
    [
      "nested Layout",
      item("l", "Lobby Layout", "layout", { layoutId: "layout-1" }),
      "layout",
    ],
  ];

  it.each(cases)("%s", (_name, entry, kind) => {
    const issue = playlistZoneIssue(zone(), playlist([entry]));
    if (kind === null) {
      expect(issue).toBeNull();
    } else {
      expect(issue?.items).toEqual([
        { id: entry.id, name: entry.assetName, kind },
      ]);
      expect(issue?.playlistName).toBe("Morning Announcements");
    }
  });

  it("names every offending item and ignores the playable ones", () => {
    const issue = playlistZoneIssue(
      zone(),
      playlist([
        item("i", "Logo", "image"),
        item("w", "Weather", "layout", { widgetProvider: "weather" }),
        item("s", "School Website", "layout", { widgetProvider: "website" }),
      ]),
    );
    expect(issue?.items.map((entry) => entry.name)).toEqual([
      "Weather",
      "School Website",
    ]);
  });

  it("considers only visible zones with a Playlist, as the server does", () => {
    const document = {
      placements: [
        zone(),
        zone({ id: "hidden", visible: false }),
        zone({ id: "empty", playlistId: undefined }),
        { ...zone({ id: "widget" }), type: "widget" },
      ],
    } as LayoutDocument;
    expect(playlistZones(document).map((entry) => entry.id)).toEqual([
      "zone-1",
    ]);
  });
});

describe("zone issue presentation", () => {
  afterEach(cleanup);

  it("says what is wrong, which items, and what to do", () => {
    const issue = playlistZoneIssue(
      zone(),
      playlist([
        item("w", "Weather", "layout", { widgetProvider: "weather" }),
        item("s", "School Website", "layout", { widgetProvider: "website" }),
      ]),
    )!;
    render(<PlaylistZoneIssueAlert issue={issue} />);
    expect(screen.getByRole("alert")).toBeVisible();
    expect(
      screen.getByText("This Layout zone contains unsupported playlist items."),
    ).toBeVisible();
    expect(
      screen.getByText(/"Morning Announcements" contains unsupported items:/),
    ).toBeVisible();
    expect(screen.getByText("Weather — Layout")).toBeVisible();
    expect(screen.getByText("School Website — Layout")).toBeVisible();
    expect(
      screen.getByText(
        "Remove unsupported entries. Play nested Layouts as root content.",
      ),
    ).toBeVisible();
  });

  it("counts the items it does not list", () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      item(`w${index}`, `Layout ${index}`, "layout", {
        widgetProvider: "clock",
      }),
    );
    render(
      <PlaylistZoneIssueAlert
        issue={playlistZoneIssue(zone(), playlist(many))!}
      />,
    );
    expect(screen.getByText("Layout 4 — Layout")).toBeVisible();
    expect(screen.queryByText("Layout 5 — Layout")).toBeNull();
    expect(screen.getByText("and 3 more items")).toBeVisible();
  });

  it("shows an invalid zone as invalid instead of previewing the playable subset", () => {
    const entries = [
      item("i", "Logo", "image"),
      item("w", "Weather", "layout"),
    ];
    const list = playlist(entries);
    const issue = playlistZoneIssue(zone(), list)!;
    const canvas = { width: 1920, height: 1080 } as LayoutDocument["canvas"];
    const { container, rerender } = render(
      <LayoutPlacementView item={zone()} canvas={canvas} playlist={list} />,
    );
    // Without the issue the zone shows its ordinary summary tile.
    expect(
      container.querySelector(".layout-playlist-zone--invalid"),
    ).toBeNull();
    rerender(
      <LayoutPlacementView
        item={zone()}
        canvas={canvas}
        playlist={list}
        zoneIssue={issue}
        playbackPreview
      />,
    );
    expect(
      container.querySelector(".layout-playlist-zone--invalid"),
    ).not.toBeNull();
    expect(screen.getByText("Unsupported items")).toBeVisible();
    expect(screen.getByText("Morning Announcements")).toBeVisible();
  });
});

describe("usePlaylistZoneIssues", () => {
  const playlistApi = vi.mocked(api.playlist);
  let client: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    playlistApi.mockReset();
  });
  afterEach(() => {
    cleanup();
    client.clear();
  });

  it("flags a Playlist that became invalid after the zone referenced it", async () => {
    const document = { placements: [zone()] } as LayoutDocument;
    playlistApi.mockResolvedValue(playlist([item("i", "Logo", "image")]));
    const { result } = renderHook(() => usePlaylistZoneIssues(document), {
      wrapper,
    });
    await waitFor(() => expect(playlistApi).toHaveBeenCalledWith("playlist-1"));
    await waitFor(() => expect(result.current.issues).toEqual([]));

    // Someone adds a nested Layout to the Playlist in another tab; the Layout is untouched.
    playlistApi.mockResolvedValue(
      playlist([
        item("i", "Logo", "image"),
        item("w", "Weather", "layout", { widgetProvider: "weather" }),
      ]),
    );
    await client.invalidateQueries({ queryKey: ["layout-zone-playlist"] });
    await waitFor(() => expect(result.current.issues).toHaveLength(1));
    expect(result.current.byPlacement.get("zone-1")?.items[0]).toMatchObject({
      name: "Weather",
      kind: "layout",
    });

    // Removing the offending item clears it.
    playlistApi.mockResolvedValue(playlist([item("i", "Logo", "image")]));
    await client.invalidateQueries({ queryKey: ["layout-zone-playlist"] });
    await waitFor(() => expect(result.current.issues).toEqual([]));
  });

  it("loads each shared Playlist once", async () => {
    const document = {
      placements: [zone(), zone({ id: "zone-2", name: "Second" })],
    } as LayoutDocument;
    playlistApi.mockResolvedValue(
      playlist([
        item("s", "School Website", "layout", { widgetProvider: "website" }),
      ]),
    );
    const { result } = renderHook(() => usePlaylistZoneIssues(document), {
      wrapper,
    });
    await waitFor(() => expect(result.current.issues).toHaveLength(2));
    expect(playlistApi).toHaveBeenCalledTimes(1);
  });
});

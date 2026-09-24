import { describe, expect, it } from "vitest";
import type {
  Asset,
  LayoutDocument,
  LayoutPlacement,
  Playlist,
  PlaylistItem,
} from "../api/types";
import {
  alignOffsets,
  arrangePlacements,
  createContentPlacement,
  createPlaylistZonePlacement,
  createPrimitivePlacement,
  distributeOffsets,
  flushLatestLayoutDraft,
  offsetPlacements,
  recentLayoutLibraryItems,
} from "./LayoutEditorPage";
import {
  nextPlaylistPreviewIndex,
  playlistPreviewDuration,
} from "../components/layout-editor/WidgetLivePreview";

const canvas = {
  width: 1920,
  height: 1080,
  orientation: "landscape" as const,
  backgroundColor: "#101820",
  safeAreaPercent: 5,
};

describe("Layout editor primitives", () => {
  it("creates renderer-neutral text placements with safe bundled defaults", () => {
    const placement = createPrimitivePlacement("text", canvas);
    expect(placement.type).toBe("primitive");
    expect(placement.primitive?.kind).toBe("text");
    expect(placement.primitive?.fontFamily).toBe("Inter");
    expect(placement.widgetId).toBeUndefined();
    expect(placement.x + placement.width).toBeLessThanOrEqual(canvas.width);
  });

  it("wires an app and a media asset to the field the renderer reads", () => {
    const app = createContentPlacement(
      { id: "app", name: "Weather", type: "widget" } as Asset,
      canvas,
    );
    expect(app.type).toBe("widget");
    expect(app.widgetId).toBe("app");
    expect(app.assetId).toBeUndefined();

    const media = createContentPlacement(
      { id: "poster", name: "Poster", type: "image" } as Asset,
      canvas,
    );
    expect(media.type).toBe("asset");
    expect(media.assetId).toBe("poster");
    expect(media.widgetId).toBeUndefined();
  });

  it("centres a dropped placement on the pointer and keeps it on the canvas", () => {
    const asset = { id: "poster", name: "Poster", type: "image" } as Asset;
    const centred = createContentPlacement(asset, canvas, { x: 960, y: 540 });
    expect(centred.x).toBe(960 - centred.width / 2);
    expect(centred.y).toBe(540 - centred.height / 2);

    const corner = createContentPlacement(asset, canvas, { x: 1900, y: 1070 });
    expect(corner.x + corner.width).toBeLessThanOrEqual(canvas.width);
    expect(corner.y + corner.height).toBeLessThanOrEqual(canvas.height);
  });

  it("gives a playlist zone its own independent loop settings", () => {
    const zone = createPlaylistZonePlacement(
      { id: "lobby", name: "Lobby" } as Playlist,
      canvas,
    );
    expect(zone.type).toBe("playlistZone");
    expect(zone.playlistId).toBe("lobby");
    expect(zone.playback?.loop).toBe(true);
    expect(zone.playback?.fallback).toBe("background");
  });

  it("creates line and group geometry inside the canvas", () => {
    const line = createPrimitivePlacement("line", canvas);
    const group = createPrimitivePlacement("group", canvas);
    expect(line.height).toBe(8);
    expect(group.primitive?.kind).toBe("group");
    expect(group.y + group.height).toBeLessThanOrEqual(canvas.height);
  });
});

describe("Layout arrange, align and distribute", () => {
  const placement = (
    id: string,
    over: Partial<LayoutPlacement> = {},
  ): LayoutPlacement => ({
    id,
    type: "primitive",
    name: id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    layer: 0,
    opacity: 1,
    visible: true,
    locked: false,
    ...over,
  });
  const stack = () => [
    placement("a", { layer: 0 }),
    placement("b", { layer: 1 }),
    placement("c", { layer: 2 }),
    placement("d", { layer: 3 }),
  ];
  const layers = (items: LayoutPlacement[]) =>
    Object.fromEntries(items.map((item) => [item.id, item.layer]));

  it("moves the selection to either end of a dense stack", () => {
    const front = stack();
    arrangePlacements(front, new Set(["a"]), "front");
    expect(layers(front)).toEqual({ a: 3, b: 0, c: 1, d: 2 });

    const back = stack();
    arrangePlacements(back, new Set(["d"]), "back");
    expect(layers(back)).toEqual({ a: 1, b: 2, c: 3, d: 0 });
  });

  it("shuffles a multi-item selection one step without collapsing it", () => {
    const items = stack();
    arrangePlacements(items, new Set(["a", "b"]), "forward");
    expect(layers(items)).toEqual({ a: 1, b: 2, c: 0, d: 3 });

    arrangePlacements(items, new Set(["a", "b"]), "backward");
    expect(layers(items)).toEqual({ a: 0, b: 1, c: 2, d: 3 });
  });

  it("renumbers duplicate layers so repeated moves keep working", () => {
    const items = [
      placement("a", { layer: 5 }),
      placement("b", { layer: 5 }),
      placement("c", { layer: 5 }),
    ];
    arrangePlacements(items, new Set(["c"]), "front");
    expect(layers(items)).toEqual({ a: 0, b: 1, c: 2 });
  });

  it("aligns a lone placement to the canvas and a group to its own bounds", () => {
    const lone = [placement("a", { x: 40, y: 40 })];
    const toCanvas = alignOffsets(
      lone,
      { left: 0, top: 0, right: canvas.width, bottom: canvas.height },
      "hcenter",
    );
    expect(toCanvas.get("a")).toEqual({ dx: 870, dy: 0 });

    const pair = [
      placement("a", { x: 100, y: 0 }),
      placement("b", { x: 500, y: 0 }),
    ];
    const toBounds = alignOffsets(
      pair,
      { left: 100, top: 0, right: 600, bottom: 100 },
      "right",
    );
    expect(toBounds.get("a")).toEqual({ dx: 400, dy: 0 });
    expect(toBounds.get("b")).toEqual({ dx: 0, dy: 0 });
  });

  it("evens out the gaps between three or more centres", () => {
    const items = [
      placement("a", { x: 0 }),
      placement("b", { x: 60 }),
      placement("c", { x: 400 }),
    ];
    const moves = distributeOffsets(items, "horizontal");
    expect(moves.get("a")).toEqual({ dx: 0, dy: 0 });
    expect(moves.get("b")).toEqual({ dx: 140, dy: 0 });
    expect(moves.get("c")).toEqual({ dx: 0, dy: 0 });
  });

  it("carries group children by the offset the group box actually took", () => {
    const document: LayoutDocument = {
      schemaVersion: 2,
      canvas,
      placements: [
        placement("group", { x: 100, y: 100, width: 400, height: 200 }),
        placement("child", { x: 120, y: 120, groupId: "group" }),
      ],
    };
    // The clamp stops the box at the canvas edge, so the child follows only that far.
    offsetPlacements(document, new Map([["group", { dx: 5000, dy: 0 }]]));
    expect(document.placements[0]?.x).toBe(1520);
    expect(document.placements[1]?.x).toBe(1540);
  });
});

describe("Layout playlist previews", () => {
  const item = {
    durationMs: 7_500,
    assetType: "image",
  } as PlaylistItem;

  it("uses configured item timing and a bounded fallback for static content", () => {
    expect(playlistPreviewDuration(item)).toBe(7_500);
    expect(playlistPreviewDuration({ ...item, durationMs: undefined })).toBe(
      10_000,
    );
    expect(
      playlistPreviewDuration({
        ...item,
        durationMs: undefined,
        assetType: "video",
      }),
    ).toBeUndefined();
  });

  it("advances independent zones while honoring the loop setting", () => {
    expect(nextPlaylistPreviewIndex(0, 3, true)).toBe(1);
    expect(nextPlaylistPreviewIndex(2, 3, true)).toBe(0);
    expect(nextPlaylistPreviewIndex(2, 3, false)).toBe(2);
  });
});

describe("Layout recent content library", () => {
  const assets = [
    {
      id: "widget",
      name: "Weather",
      type: "widget",
      createdAt: "2026-07-16T12:00:00Z",
    },
    {
      id: "image",
      name: "Poster",
      type: "image",
      createdAt: "2026-07-16T13:00:00Z",
    },
  ] as Asset[];
  const playlists = [
    {
      id: "playlist",
      name: "Lobby",
      createdAt: "2026-07-16T14:00:00Z",
    },
  ] as Playlist[];

  it("filters by the selected content type", () => {
    expect(recentLayoutLibraryItems("widgets", assets, playlists)).toHaveLength(
      1,
    );
    expect(recentLayoutLibraryItems("media", assets, playlists)[0]?.kind).toBe(
      "asset",
    );
    expect(
      recentLayoutLibraryItems("playlists", assets, playlists)[0]?.kind,
    ).toBe("playlist");
  });
});

describe("Layout autosave", () => {
  it("queues edits made while an earlier draft is saving", async () => {
    let changeVersion = 1;
    let savedChangeVersion = 0;
    let revision = 4;
    let document: LayoutDocument = {
      schemaVersion: 2,
      canvas,
      placements: [],
    };
    const persistedVersions: number[] = [];

    await flushLatestLayoutDraft(
      () => ({ changeVersion, savedChangeVersion, revision, document }),
      (expectedRevision) => {
        persistedVersions.push(changeVersion);
        if (persistedVersions.length === 1) {
          changeVersion = 2;
          document = {
            ...document,
            canvas: { ...canvas, backgroundColor: "#223344" },
          };
        }
        return Promise.resolve({ draftRevision: expectedRevision + 1 });
      },
      (version, draftRevision) => {
        savedChangeVersion = version;
        revision = draftRevision;
      },
    );

    expect(persistedVersions).toEqual([1, 2]);
    expect(savedChangeVersion).toBe(2);
    expect(revision).toBe(6);
  });
});

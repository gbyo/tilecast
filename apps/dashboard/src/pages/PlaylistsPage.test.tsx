// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaylistItem } from "../api/types";
import { i18n } from "../i18n";
import {
  canManagePlaylists,
  openPlaylistPreview,
  playlistDuration,
  playlistItemUsesFixedDuration,
} from "./PlaylistsPage";
import {
  nextPlaylistPreviewItem,
  playlistPreviewItemAvailable,
  playlistPreviewItemDuration,
} from "./PlaylistPreviewPage";
import {
  itemHasTransitionOverride,
  playlistAuthoringDefaults,
  playlistDurationLabel,
  playlistImageDuration,
  playlistTransition,
  movePlaylistItem,
  reorderPlaylistItems,
} from "../components/playlist-editor/playlistEditorModel";

afterEach(() => vi.restoreAllMocks());

const t = i18n.getFixedT("en", "playlists");

const item = (values: Partial<PlaylistItem>): PlaylistItem => ({
  id: "item",
  assetId: "asset",
  position: 0,
  fitMode: "contain",
  transition: "none",
  audioEnabled: true,
  volume: 1,
  deliveryPolicy: "download",
  assetName: "Media",
  assetType: "image",
  assetStatus: "ready",
  thumbnailUrl: "/thumbnail",
  ...values,
});
describe("playlist editor", () => {
  it("keeps viewers read-only", () => {
    expect(canManagePlaylists("owner")).toBe(true);
    expect(canManagePlaylists("administrator")).toBe(true);
    expect(canManagePlaylists("editor")).toBe(true);
    expect(canManagePlaylists("viewer")).toBe(false);
  });
  it("calculates known image and clipped-video duration", () => {
    expect(
      playlistDuration([
        item({ durationMs: 10_000 }),
        item({
          id: "video",
          assetType: "video",
          assetDurationSeconds: 20,
          videoStartOffsetMs: 5_000,
          videoEndOffsetMs: 12_000,
        }),
      ]),
    ).toBe(17_000);
  });
  it("reports an unknown total for video without trusted duration", () => {
    expect(
      playlistDuration([
        item({ assetType: "video", assetDurationSeconds: undefined }),
      ]),
    ).toBeNull();
  });

  it("treats an omitted item collection as an empty playlist", () => {
    expect(playlistDuration(undefined)).toBe(0);
  });

  it("includes Layout item durations", () => {
    expect(
      playlistDuration([
        item({
          assetId: "",
          layoutId: "layout",
          assetType: "layout",
          durationMs: 30_000,
        }),
        item({ id: "image", durationMs: 10_000 }),
      ]),
    ).toBe(40_000);
  });

  it("offers fixed duration for native widgets but preserves YouTube until-end playback", () => {
    expect(
      playlistItemUsesFixedDuration(
        item({ assetType: "widget", widgetProvider: "clock" }),
      ),
    ).toBe(true);
    expect(
      playlistItemUsesFixedDuration(
        item({ assetType: "widget", widgetProvider: "youtube" }),
      ),
    ).toBe(false);
  });

  it("summarizes uniform and mixed playlist transitions", () => {
    expect(playlistTransition([])).toBe("none");
    expect(
      playlistTransition([
        item({ transition: "fade" }),
        item({ id: "second", transition: "fade" }),
      ]),
    ).toBe("fade");
    expect(
      playlistTransition([
        item({ transition: "fade" }),
        item({ id: "second", transition: "crossfade" }),
      ]),
    ).toBe("mixed");
  });

  it("summarizes fixed, mixed, and Player-default image durations", () => {
    expect(
      playlistImageDuration([
        item({ durationMs: 12_000 }),
        item({ id: "second", durationMs: 12_000 }),
      ]),
    ).toEqual({ kind: "value", seconds: 12 });
    expect(
      playlistImageDuration([
        item({ durationMs: 12_000 }),
        item({ id: "second", durationMs: 15_000 }),
      ]),
    ).toEqual({ kind: "mixed" });
    expect(
      playlistImageDuration([
        item({ durationMs: undefined, usePlayerDefaults: true }),
      ]),
    ).toEqual({ kind: "player" });
    expect(
      playlistDurationLabel(
        [item({ durationMs: undefined, usePlayerDefaults: true })],
        t,
      ),
    ).toBe("Uses Player defaults");
  });

  it("inherits playlist playback settings when adding new content", () => {
    const existing = [
      item({ transition: "fade", durationMs: 12_000 }),
      item({ id: "second", transition: "fade", durationMs: 12_000 }),
    ];
    expect(playlistAuthoringDefaults(existing, "image")).toEqual({
      transition: "fade",
      durationMs: 12_000,
      usePlayerDefaults: false,
    });
    expect(playlistAuthoringDefaults(existing, "video")).toEqual({
      transition: "fade",
      durationMs: undefined,
      usePlayerDefaults: false,
    });
    expect(
      playlistAuthoringDefaults(
        [item({ transition: "none", usePlayerDefaults: true })],
        "image",
      ),
    ).toEqual({
      transition: "none",
      durationMs: undefined,
      usePlayerDefaults: true,
    });
  });

  it("marks Player defaults and per-item transitions as overrides", () => {
    expect(
      itemHasTransitionOverride(item({ transition: "fade" }), "fade"),
    ).toBe(false);
    expect(
      itemHasTransitionOverride(item({ transition: "crossfade" }), "fade"),
    ).toBe(true);
    expect(
      itemHasTransitionOverride(item({ usePlayerDefaults: true }), "none"),
    ).toBe(true);
  });

  it("supports deterministic drag and keyboard reordering", () => {
    const items = [
      item({ id: "first" }),
      item({ id: "second" }),
      item({ id: "third" }),
    ];
    expect(reorderPlaylistItems(items, "first", "third")).toEqual([
      "second",
      "third",
      "first",
    ]);
    expect(movePlaylistItem(items, "second", -1)).toEqual([
      "second",
      "first",
      "third",
    ]);
  });

  it("opens the playlist preview in a focused popup window", () => {
    const focus = vi.fn();
    const popup = { focus, opener: window } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);

    expect(openPlaylistPreview("playlist 1")).toBe(popup);
    expect(open).toHaveBeenCalledWith(
      "/playlists/playlist%201/preview",
      "tilecast-playlist-preview-playlist 1",
      "popup=yes,width=1280,height=800,resizable=yes,scrollbars=no",
    );
    expect(popup.opener).toBeNull();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("loops popup preview navigation and uses bounded non-video durations", () => {
    expect(nextPlaylistPreviewItem(2, 3, 1)).toBe(0);
    expect(nextPlaylistPreviewItem(0, 3, -1)).toBe(2);
    expect(playlistPreviewItemDuration(item({ durationMs: 7_500 }))).toBe(
      7_500,
    );
    expect(playlistPreviewItemDuration(item({ assetType: "layout" }))).toBe(
      10_000,
    );
    expect(
      playlistPreviewItemDuration(item({ assetType: "video" })),
    ).toBeUndefined();
  });

  it("uses inclusive availability and exclusive expiration in preview", () => {
    const now = Date.parse("2026-07-25T12:00:00Z");
    expect(
      playlistPreviewItemAvailable(
        item({ availableFrom: "2026-07-25T12:00:00Z" }),
        now,
      ),
    ).toBe(true);
    expect(
      playlistPreviewItemAvailable(
        item({ availableFrom: "2026-07-25T12:00:01Z" }),
        now,
      ),
    ).toBe(false);
    expect(
      playlistPreviewItemAvailable(
        item({ expiresAt: "2026-07-25T12:00:00Z" }),
        now,
      ),
    ).toBe(false);
  });
});

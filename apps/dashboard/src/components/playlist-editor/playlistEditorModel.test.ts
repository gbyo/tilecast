import { describe, expect, it } from "vitest";
import type { PlaylistItem } from "../../api/types";
import { i18n } from "../../i18n";
import {
  formatDuration,
  movePlaylistItem,
  movePlaylistItemToEdge,
  reorderPlaylistItems,
} from "./playlistEditorModel";

function items(ids: string[]): PlaylistItem[] {
  return ids.map(
    (id) =>
      ({
        id,
        assetName: id,
        assetType: "image",
        transition: "none",
      }) as PlaylistItem,
  );
}

describe("playlist duration display", () => {
  const t = i18n.getFixedT("en", "playlists");

  it("rounds milliseconds at the whole-second boundary", () => {
    expect(formatDuration(59_499, t)).toBe("0:59");
    expect(formatDuration(59_500, t)).toBe("1:00");
    expect(formatDuration(3_600_000, t)).toBe("60:00");
  });

  it("keeps the localized full-video label for unknown duration", () => {
    expect(formatDuration(null, t)).toBe(t("model.duration.fullVideo"));
  });
});

describe("playlist reorder actions", () => {
  it("moves an item one step with movePlaylistItem", () => {
    expect(movePlaylistItem(items(["a", "b", "c"]), "b", -1)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(movePlaylistItem(items(["a", "b", "c"]), "b", 1)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("clamps a step move at the timeline edges", () => {
    expect(movePlaylistItem(items(["a", "b"]), "a", -1)).toEqual(["a", "b"]);
    expect(movePlaylistItem(items(["a", "b"]), "b", 1)).toEqual(["a", "b"]);
  });

  it("moves an item to the top or bottom of the timeline", () => {
    const list = items(["a", "b", "c", "d"]);
    expect(movePlaylistItemToEdge(list, "c", "top")).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
    expect(movePlaylistItemToEdge(list, "b", "bottom")).toEqual([
      "a",
      "c",
      "d",
      "b",
    ]);
  });

  it("leaves the order alone when the item is already at the edge", () => {
    const list = items(["a", "b", "c"]);
    expect(movePlaylistItemToEdge(list, "a", "top")).toEqual(["a", "b", "c"]);
    expect(movePlaylistItemToEdge(list, "c", "bottom")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("returns the current order for an unknown item", () => {
    const list = items(["a", "b"]);
    expect(movePlaylistItemToEdge(list, "missing", "top")).toEqual(["a", "b"]);
    expect(movePlaylistItem(list, "missing", 1)).toEqual(["a", "b"]);
    expect(reorderPlaylistItems(list, "missing", "a")).toEqual(["a", "b"]);
  });
});

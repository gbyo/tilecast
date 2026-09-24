// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import {
  filterAndSortPlaylists,
  formatPlaylistUpdatedAt,
  type PlaylistLibraryItem,
} from "./PlaylistLibraryPage";

const t = i18n.getFixedT("en", "playlists");

const playlist = (
  values: Partial<PlaylistLibraryItem> &
    Pick<PlaylistLibraryItem, "id" | "name">,
): PlaylistLibraryItem => ({
  description: "",
  revision: 1,
  createdAt: "2026-07-01T12:00:00Z",
  updatedAt: "2026-07-01T12:00:00Z",
  itemCount: 0,
  sourceType: "static",
  ...values,
});

describe("playlist library", () => {
  it("searches names, descriptions, and previewed content", () => {
    const items = [
      playlist({ id: "morning", name: "Morning rotation" }),
      playlist({
        id: "lunch",
        name: "Daily information",
        description: "Cafeteria lunch and library notices",
        itemCount: 2,
      }),
      playlist({
        id: "sports",
        name: "After school",
        itemCount: 1,
        previewItems: [{ id: "score", name: "Football scores", type: "image" }],
      }),
    ];

    expect(filterAndSortPlaylists(items, "library", "all", "name")).toEqual([
      items[1],
    ]);
    expect(filterAndSortPlaylists(items, "football", "all", "name")).toEqual([
      items[2],
    ]);
  });

  it("filters empty and tag-driven playlists", () => {
    const items = [
      playlist({ id: "empty", name: "Empty" }),
      playlist({
        id: "tagged",
        name: "Tagged",
        sourceType: "tag",
        itemCount: 3,
      }),
      playlist({ id: "standard", name: "Standard", itemCount: 2 }),
    ];

    expect(filterAndSortPlaylists(items, "", "empty", "name")).toEqual([
      items[0],
    ]);
    expect(filterAndSortPlaylists(items, "", "tag", "name")).toEqual([
      items[1],
    ]);
    expect(filterAndSortPlaylists(items, "", "standard", "name")).toEqual([
      items[0],
      items[2],
    ]);
  });

  it("sorts by recent updates and item count with stable name fallbacks", () => {
    const items = [
      playlist({
        id: "alpha",
        name: "Alpha",
        itemCount: 2,
        updatedAt: "2026-07-02T12:00:00Z",
      }),
      playlist({
        id: "beta",
        name: "Beta",
        itemCount: 5,
        updatedAt: "2026-07-03T12:00:00Z",
      }),
      playlist({
        id: "charlie",
        name: "Charlie",
        itemCount: 5,
        updatedAt: "2026-07-01T12:00:00Z",
      }),
    ];

    expect(
      filterAndSortPlaylists(items, "", "all", "updated").map(
        (item) => item.id,
      ),
    ).toEqual(["beta", "alpha", "charlie"]);
    expect(
      filterAndSortPlaylists(items, "", "all", "items").map((item) => item.id),
    ).toEqual(["beta", "charlie", "alpha"]);
  });

  it("formats useful relative update times", () => {
    const now = Date.parse("2026-07-26T16:00:00Z");
    expect(formatPlaylistUpdatedAt("2026-07-26T15:59:30Z", t, now)).toBe(
      "Updated just now",
    );
    expect(formatPlaylistUpdatedAt("2026-07-26T14:00:00Z", t, now)).toBe(
      "Updated 2 hours ago",
    );
    expect(formatPlaylistUpdatedAt("not-a-date", t, now)).toBe(
      "Update time unavailable",
    );
  });
});

import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/media-eligibility.json";
import {
  classifyPlaylistZoneItem,
  isPlaylistZoneMediaItem,
  isPlaylistZoneItem,
  playlistZoneUnsupportedItems,
  resolveMediaEligibility,
  type PlaylistZoneItemLike,
} from "./media-eligibility";

describe("media eligibility contract", () => {
  it.each(fixtures.cases)("$name", (fixture) => {
    const item = { ...fixtures.item, ...fixture.item };
    const asset =
      fixture.asset == null ? null : { ...fixtures.asset, ...fixture.asset };
    const before = structuredClone({ item, asset });
    expect(isPlaylistZoneMediaItem(item)).toBe(fixture.supported);
    expect(resolveMediaEligibility(item, asset, new Date(fixtures.at))).toEqual(
      {
        kind: fixture.kind,
        reason: fixture.reason,
      },
    );
    expect({ item, asset }).toEqual(before);
  });
});

describe("playlist zone unsupported items", () => {
  const item = (
    id: string,
    assetName: string,
    assetType: string,
    extra: Partial<PlaylistZoneItemLike> = {},
  ): PlaylistZoneItemLike => ({ id, assetName, assetType, ...extra });

  it("classifies every kind a zone cannot play and nothing it can", () => {
    expect(classifyPlaylistZoneItem(item("1", "a", "image"))).toBeNull();
    expect(classifyPlaylistZoneItem(item("2", "b", "video"))).toBeNull();
    expect(
      classifyPlaylistZoneItem(
        item("3", "c", "widget", { widgetProvider: "clock" }),
      ),
    ).toBeNull();
    expect(
      classifyPlaylistZoneItem(
        item("4", "d", "widget", { widgetProvider: "website" }),
      ),
    ).toBeNull();
    expect(
      classifyPlaylistZoneItem(
        item("5", "e", "widget", { widgetProvider: "youtube" }),
      ),
    ).toBeNull();
    expect(
      classifyPlaylistZoneItem(item("6", "f", "layout", { layoutId: "l1" })),
    ).toBe("layout");
    expect(classifyPlaylistZoneItem(item("7", "g", "audio"))).toBe("other");
  });

  it("agrees with the supported-item predicate the preview and server use", () => {
    for (const candidate of [
      item("1", "a", "image"),
      item("2", "b", "video"),
      item("3", "c", "widget"),
      item("4", "d", "widget", { widgetProvider: "website" }),
      item("5", "e", "layout", { layoutId: "l" }),
      item("6", "f", "image", { layoutId: "l" }),
      item("7", "g", "document"),
    ]) {
      expect(classifyPlaylistZoneItem(candidate) === null).toBe(
        isPlaylistZoneItem(candidate),
      );
    }
  });

  it("lists the offending items by name in playlist order", () => {
    expect(
      playlistZoneUnsupportedItems([
        item("1", "Logo", "image"),
        item("2", "Weather", "widget", { widgetProvider: "weather" }),
        item("3", "Intro", "video"),
        item("4", "School Website", "widget", { widgetProvider: "website" }),
        item("5", "Nested", "layout", { layoutId: "l" }),
      ]),
    ).toEqual([{ id: "5", name: "Nested", kind: "layout" }]);
    expect(playlistZoneUnsupportedItems([item("1", "Logo", "image")])).toEqual(
      [],
    );
  });
});

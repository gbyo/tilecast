import { describe, expect, it } from "vitest";
import fixtures from "../../../../packages/presentation-model/fixtures/foundation.json";
import mediaFixtures from "../../../../packages/presentation-model/fixtures/media-eligibility.json";
import zoneFixtures from "../../../../packages/presentation-model/fixtures/zone-policy.json";
import {
  defaultImageDurationMsForPlayback,
  fallbackDurationMsFor,
  isAvailableAt,
  nextAvailabilityTransition,
  resolvePlaybackItemSettings,
  resolveMediaEligibility,
} from "@tilecast/presentation-model";
import {
  playlistPreviewDuration,
  isPlaylistZoneMediaItem,
  availablePlaylistZoneItems,
  nextPlaylistPreviewIndex,
} from "../components/layout-editor/WidgetLivePreview";
import type { Asset, Playlist, PlaylistItem } from "../api/types";
import {
  resolvePlaylistPreviewItem,
  playlistPreviewItemDuration,
  playlistPreviewItemAvailable,
} from "../pages/PlaylistPreviewPage";

describe("Studio adopts Presentation Model fixtures", () => {
  it.each(mediaFixtures.cases)("$name", (fixture) => {
    const item = { ...mediaFixtures.item, ...fixture.item };
    const asset =
      fixture.asset == null
        ? null
        : { ...mediaFixtures.asset, ...fixture.asset };
    expect(isPlaylistZoneMediaItem(item)).toBe(fixture.supported);
    expect(
      resolveMediaEligibility(item, asset, new Date(mediaFixtures.at)),
    ).toEqual({
      kind: fixture.kind,
      reason: fixture.reason,
    });
  });
  it.each(zoneFixtures.advance)("$name", (fixture) => {
    expect(
      nextPlaylistPreviewIndex(fixture.index, fixture.count, fixture.loop),
    ).toBe(fixture.nextIndex);
  });
  it.each(fixtures.availability)("$name", (fixture) => {
    const at = new Date(fixture.at);
    expect(isAvailableAt(fixture.window, at)).toBe(fixture.available);
    expect(
      nextAvailabilityTransition([fixture.window], at)?.toISOString() ?? null,
    ).toBe(fixture.next);
    for (const target of ["item", "asset"]) {
      const item = {
        id: "item",
        assetId: "asset",
        assetType: "image",
        assetStatus: "ready",
        ...(target === "item" ? fixture.window : {}),
      } as PlaylistItem;
      const asset = {
        id: "asset",
        type: "image",
        ...(target === "asset" ? fixture.window : {}),
      } as Asset;
      expect(
        availablePlaylistZoneItems(
          { items: [item] } as Playlist,
          new Map([["asset", asset]]),
          at,
        ).map((entry) => entry.id),
      ).toEqual(fixture.available ? ["item"] : []);
    }
    expect(
      playlistPreviewItemAvailable(
        { assetStatus: "ready", ...fixture.window } as PlaylistItem,
        at.getTime(),
      ),
    ).toBe(fixture.available);
  });
  it.each(fixtures.settings)("$name", (fixture) => {
    const item = { ...fixtures.item, ...fixture.item };
    const fallback = fallbackDurationMsFor(
      item.assetType,
      defaultImageDurationMsForPlayback(fixture.playback),
    );
    expect(
      resolvePlaybackItemSettings(item, fixture.playback, fallback),
    ).toEqual(fixture.expected);
    expect(
      resolvePlaylistPreviewItem(item as PlaylistItem, fixture.playback),
    ).toMatchObject({
      ...fixture.expected,
      durationMs: fixture.expected.durationMs ?? undefined,
    });
    expect(
      playlistPreviewItemDuration(item as PlaylistItem, fixture.playback),
    ).toBe(
      item.assetType === "video"
        ? undefined
        : (fixture.expected.durationMs ?? undefined),
    );
    if (item.assetType !== "video")
      expect(
        playlistPreviewDuration(item as PlaylistItem, fixture.playback),
      ).toBe(fixture.expected.durationMs);
  });
});

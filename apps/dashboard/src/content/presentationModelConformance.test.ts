import { describe, expect, it } from "vitest";
import fixtures from "../../../../packages/presentation-model/fixtures/foundation.json";
import {
  defaultImageDurationMsForPlayback,
  fallbackDurationMsFor,
  isAvailableAt,
  nextAvailabilityTransition,
  resolvePlaybackItemSettings,
} from "@tilecast/presentation-model";
import { playlistPreviewDuration } from "../components/layout-editor/WidgetLivePreview";
import type { PlaylistItem } from "../api/types";
import {
  resolvePlaylistPreviewItem,
  playlistPreviewItemDuration,
  playlistPreviewItemAvailable,
} from "../pages/PlaylistPreviewPage";

describe("Studio adopts Presentation Model fixtures", () => {
  it.each(fixtures.availability)("$name", (fixture) => {
    const at = new Date(fixture.at);
    expect(isAvailableAt(fixture.window, at)).toBe(fixture.available);
    expect(
      nextAvailabilityTransition([fixture.window], at)?.toISOString() ?? null,
    ).toBe(fixture.next);
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

import { describe, expect, it } from "vitest";
import fixtures from "../../../../presentation-model/fixtures/foundation.json";
import {
  isAvailableAt,
  nextAvailabilityTransition,
} from "./content-availability";
import {
  defaultImageDurationMsForPlayback,
  fallbackDurationMsFor,
  resolvePlaybackItemSettings,
} from "./playback-defaults";

describe("Runtime adopts Presentation Model fixtures", () => {
  it.each(fixtures.availability)("$name", (fixture) => {
    const at = new Date(fixture.at);
    expect(isAvailableAt(fixture.window, at)).toBe(fixture.available);
    expect(
      nextAvailabilityTransition([fixture.window], at)?.toISOString() ?? null,
    ).toBe(fixture.next);
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
  });
});

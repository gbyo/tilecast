import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/foundation.json";
import {
  defaultImageDurationMsForPlayback,
  fallbackDurationMsFor,
  isAvailableAt,
  nextAvailabilityTransition,
  resolvePlaybackItemSettings,
} from "./index";

describe("Presentation Model foundation fixtures", () => {
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

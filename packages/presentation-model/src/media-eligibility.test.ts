import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/media-eligibility.json";
import {
  isPlaylistZoneMediaItem,
  resolveMediaEligibility,
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

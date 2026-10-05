import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/zone-policy.json";
import {
  resolvePlaylistAdvance,
  resolveNativeVideoLoop,
  resolveZoneFallback,
  type ZoneFallback,
} from "./zone-policy";
describe("zone policy fixtures", () => {
  it.each(fixtures.advance)("$name", (f) =>
    expect(resolvePlaylistAdvance(f.index, f.count, f.loop)).toEqual({
      nextIndex: f.nextIndex,
      canAdvance: f.canAdvance,
    }),
  );
  it.each(fixtures.nativeLoop)("$name", (f) =>
    expect(resolveNativeVideoLoop(f.item, f.count, f.loop)).toBe(f.expected),
  );
  it.each(fixtures.fallback)("$name", (f) =>
    expect(
      resolveZoneFallback(f.failed, f.fallback as ZoneFallback, f.hasPrevious),
    ).toBe(f.expected),
  );
});

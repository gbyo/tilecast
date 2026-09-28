import { describe, expect, it } from "vitest";
import {
  isAvailableAt,
  nextAvailabilityTransition,
} from "./content-availability";

describe("content availability", () => {
  const now = new Date("2026-08-02T12:00:00.000Z");

  it("uses inclusive starts and exclusive expiration for every content path", () => {
    expect(isAvailableAt({ availableFrom: now.toISOString() }, now)).toBe(true);
    expect(
      isAvailableAt(
        { availableFrom: new Date(now.getTime() + 1).toISOString() },
        now,
      ),
    ).toBe(false);
    expect(isAvailableAt({ expiresAt: now.toISOString() }, now)).toBe(false);
    expect(
      isAvailableAt(
        {
          availableFrom: new Date(now.getTime() - 1_000).toISOString(),
          expiresAt: new Date(now.getTime() + 1_000).toISOString(),
        },
        now,
      ),
    ).toBe(true);
  });

  it("returns the next future availability boundary deterministically", () => {
    const future = new Date(now.getTime() + 60_000);
    const later = new Date(now.getTime() + 120_000);
    expect(
      nextAvailabilityTransition(
        [
          { availableFrom: later.toISOString() },
          { expiresAt: future.toISOString() },
        ],
        now,
      ),
    ).toEqual(future);
  });

  it("fails closed for malformed or inverted windows", () => {
    expect(isAvailableAt({ availableFrom: "not-a-time" }, now)).toBe(false);
    expect(
      isAvailableAt(
        {
          availableFrom: new Date(now.getTime() + 1_000).toISOString(),
          expiresAt: now.toISOString(),
        },
        now,
      ),
    ).toBe(false);
  });
});

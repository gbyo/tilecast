import { describe, expect, it } from "vitest";
import { compactDuration } from "../src/runtime";

describe("compact countdown display", () => {
  it("shows seconds below one hour", () => {
    expect(compactDuration((42 * 60 + 18) * 1_000)).toBe("42m 18s");
    expect(compactDuration(18_000)).toBe("18s");
  });

  it("uses coarser units for longer countdowns and Now at completion", () => {
    expect(compactDuration((26 * 60 * 60 + 3 * 60) * 1_000)).toBe("1d 2h");
    expect(compactDuration((2 * 60 * 60 + 3 * 60) * 1_000)).toBe("2h 3m");
    expect(compactDuration(0)).toBe("Now");
    expect(compactDuration(-1)).toBe("Now");
  });
});

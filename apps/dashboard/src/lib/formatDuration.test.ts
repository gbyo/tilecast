import { describe, expect, it } from "vitest";
import { formatDurationClock } from "./formatDuration";

describe("clock duration display", () => {
  it.each([
    [0, "0:00"],
    [9, "0:09"],
    [59.9, "0:59"],
    [60, "1:00"],
    [3601, "60:01"],
    [86_400, "1440:00"],
    [undefined, ""],
    [null, ""],
    [-1, ""],
    [NaN, ""],
    [Infinity, ""],
  ])("formats %s as %s", (input, expected) => {
    expect(formatDurationClock(input)).toBe(expected);
  });
});

import { describe, expect, it } from "vitest";
import { formatDuration, formatValue, safeColor } from "./format";

describe("formatValue", () => {
  it("formats numbers with thousands separators and precision", () => {
    expect(formatValue("1234.5", { format: "number", precision: 1 })).toBe(
      "1,234.5",
    );
    expect(formatValue(1234.9, { format: "integer" })).toBe("1,235");
  });

  it("formats percent and currency", () => {
    expect(formatValue("42", { format: "percent" })).toBe("42%");
    expect(formatValue("1000", { format: "currency" })).toBe("$1,000");
    expect(formatValue("9.5", { format: "currency", precision: 2 })).toBe(
      "$9.50",
    );
  });

  it("applies prefix and suffix only to non-empty output", () => {
    expect(
      formatValue("5", { format: "number", prefix: "~", suffix: " ea" }),
    ).toBe("~5 ea");
    expect(formatValue("", { format: "number", prefix: "~" })).toBe("");
  });

  it("formats booleans", () => {
    expect(formatValue("true", { format: "boolean" })).toBe("Yes");
    expect(formatValue("0", { format: "boolean" })).toBe("No");
  });

  it("formats dates in an explicit timezone", () => {
    const short = formatValue("2026-07-04", {
      format: "date-short",
      timezone: "UTC",
    });
    expect(short).toMatch(/Jul\s*4/);
    const long = formatValue("2026-07-04", {
      format: "date-long",
      timezone: "UTC",
    });
    expect(long).toMatch(/July 4, 2026/);
  });

  it("keeps date-only values on the same calendar day across timezones", () => {
    expect(
      formatValue("2026-07-04", {
        format: "date-long",
        timezone: "America/New_York",
      }),
    ).toMatch(/July 4, 2026/);
    expect(
      formatValue("2026-07-04", {
        format: "date-short",
        timezone: "America/Los_Angeles",
      }),
    ).toMatch(/Jul\s*4/);
  });

  it("still applies the requested timezone to timestamp values", () => {
    expect(
      formatValue("2026-07-04T00:00:00Z", {
        format: "date-long",
        timezone: "America/New_York",
      }),
    ).toMatch(/July 3, 2026/);
  });

  it("passes through impossible date-only values", () => {
    expect(
      formatValue("2026-02-31", {
        format: "date-long",
        timezone: "America/New_York",
      }),
    ).toBe("2026-02-31");
  });

  it("passes through invalid numbers as empty", () => {
    expect(formatValue("n/a", { format: "number" })).toBe("");
  });
});

describe("formatDuration", () => {
  it("renders compound durations", () => {
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(3_661)).toBe("1h 1m"); // seconds dropped past the hour
    expect(formatDuration(90_061)).toBe("1d 1h 1m");
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("safeColor", () => {
  it("accepts valid hex and rejects junk", () => {
    expect(safeColor("#FFAA00", "#000")).toBe("#FFAA00");
    expect(safeColor("#FFAA00CC", "#000")).toBe("#FFAA00CC");
    expect(safeColor("red", "#000")).toBe("#000");
    expect(safeColor(undefined, "#000")).toBe("#000");
    expect(safeColor("javascript:alert(1)", "#000")).toBe("#000");
  });
});

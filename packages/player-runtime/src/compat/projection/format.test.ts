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
    expect(formatValue("42", { format: "percent" })).toMatch(/42\s*%/);
    expect(formatValue("1000", { format: "currency" })).toBe("1,000");
    expect(formatValue("9.5", { format: "currency", precision: 2 })).toBe(
      "9.50",
    );
  });

  it.each(["en-US", "en-GB", "de-DE", "es-ES", "ru-RU"])(
    "uses organization locale %s for numbers and dates",
    (locale) => {
      const regionalFormat = {
        locale,
        timezone: "UTC",
        dateFormat: "locale" as const,
        timeFormat: "locale" as const,
        firstDayOfWeek: "monday" as const,
      };
      const formattedNumber = formatValue("1234.5", {
        format: "number",
        precision: 1,
        regionalFormat,
      }).replace(/[\u00a0\u202f]/g, " ");
      const expectedNumber = new Intl.NumberFormat(locale, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })
        .format(1234.5)
        .replace(/[\u00a0\u202f]/g, " ");
      expect(formattedNumber).toBe(expectedNumber);
      const formattedDate = formatValue("2026-07-04", {
        format: "date-short",
        regionalFormat,
      });
      const expectedDate = new Intl.DateTimeFormat(locale, {
        dateStyle: "short",
        timeZone: "UTC",
      }).format(new Date("2026-07-04T00:00:00Z"));
      expect(formattedDate.replace(/[\u00a0\u202f]/g, " ")).toBe(
        expectedDate.replace(/[\u00a0\u202f]/g, " "),
      );
    },
  );

  it("keeps explicit currency metadata authoritative across locales", () => {
    const regionalFormat = {
      locale: "de-DE",
      timezone: "Europe/Berlin",
      dateFormat: "locale" as const,
      timeFormat: "locale" as const,
      firstDayOfWeek: "monday" as const,
    };
    const eur = formatValue("1234.5", {
      format: "currency",
      currency: "EUR",
      precision: 2,
      regionalFormat,
    });
    expect(eur.replace(/\u00a0/g, " ")).toMatch(/1\.234,50\s*€/);
    expect(eur).not.toContain("$");
    expect(
      formatValue("1234", {
        format: "currency",
        currency: "JPY",
        regionalFormat,
      }),
    ).toContain("¥");
    const legacy = formatValue("1234.5", {
      format: "currency",
      regionalFormat,
    });
    expect(legacy).not.toMatch(/[€£$¥]/);
    expect(legacy.replace(/\u00a0/g, " ")).toBe("1.234,5");
  });

  it("honors explicit hour choices and organization time zone", () => {
    const base = {
      locale: "en-GB",
      timezone: "Asia/Tokyo",
      dateFormat: "locale" as const,
      timeFormat: "locale" as const,
      firstDayOfWeek: "monday" as const,
    };
    const instant = "2026-07-04T13:05:00Z";
    const twelveHour = formatValue(instant, {
      format: "time",
      regionalFormat: { ...base, timeFormat: "12-hour" },
    });
    const twentyFourHour = formatValue(instant, {
      format: "time",
      regionalFormat: { ...base, timeFormat: "24-hour" },
    });
    expect(twelveHour).toMatch(/10:05\s*pm/i);
    expect(twentyFourHour).toMatch(/22:05/);
  });

  it("uses legacy output only when a regional profile is absent", () => {
    expect(formatValue("1234.5", { format: "number", precision: 1 })).toBe(
      "1,234.5",
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
    const expectedShort = new Intl.DateTimeFormat("en-US", {
      dateStyle: "short",
      timeZone: "UTC",
    }).format(new Date("2026-07-04T00:00:00Z"));
    expect(short).toBe(expectedShort);
    const long = formatValue("2026-07-04", {
      format: "date-long",
      timezone: "UTC",
    });
    expect(long).toMatch(/July 4, 2026/);
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

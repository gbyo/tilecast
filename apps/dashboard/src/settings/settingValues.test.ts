import { describe, expect, it } from "vitest";
import {
  canonicalizeLocale,
  firstDayOfWeekForLocale,
  isValidTimezone,
  normalizeTimezone,
  timezoneOptions,
} from "./settingValues";

describe("regional setting values", () => {
  it("canonicalizes arbitrary valid BCP-47 tags and rejects invalid tags", () => {
    expect(canonicalizeLocale("ja-jp")).toBe("ja-JP");
    expect(canonicalizeLocale("ru-ru")).toBe("ru-RU");
    expect(canonicalizeLocale("not a locale")).toBeNull();
  });

  it("uses locale week metadata for Sunday, Monday, and other week starts", () => {
    expect(firstDayOfWeekForLocale("en-US")).toBe("sunday");
    expect(firstDayOfWeekForLocale("en-GB")).toBe("monday");
    expect(firstDayOfWeekForLocale("de-DE")).toBe("monday");
    expect(firstDayOfWeekForLocale("dv-MV")).toBe("friday");
    expect(firstDayOfWeekForLocale("en-IQ")).toBe("saturday");
    expect(firstDayOfWeekForLocale("de")).toBe("monday");
    expect(firstDayOfWeekForLocale("en-u-ca-iso8601")).toBe("monday");
    expect(firstDayOfWeekForLocale("en-u-sd-mvun")).toBe("friday");
  });

  it("uses the CLDR compatibility path when Intl.Locale is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, "Locale");
    expect(descriptor?.configurable).toBe(true);
    Object.defineProperty(Intl, "Locale", {
      configurable: true,
      value: undefined,
    });
    try {
      expect(firstDayOfWeekForLocale("en-US")).toBe("sunday");
      expect(firstDayOfWeekForLocale("de")).toBe("monday");
      expect(firstDayOfWeekForLocale("en-u-ca-iso8601")).toBe("monday");
      expect(firstDayOfWeekForLocale("en-u-sd-mvun")).toBe("friday");
    } finally {
      if (descriptor) Object.defineProperty(Intl, "Locale", descriptor);
    }
  });

  it("offers broad IANA coverage and keeps a valid uncommon existing zone", () => {
    const zones = timezoneOptions("Antarctica/Troll");
    expect(zones).toContain("Europe/Berlin");
    expect(zones).toContain("Asia/Tokyo");
    expect(zones).toContain("Australia/Sydney");
    expect(isValidTimezone("Antarctica/Troll")).toBe(true);
    expect(zones).toContain("Antarctica/Troll");
  });

  it("normalizes legacy US abbreviations without listing them as choices", () => {
    expect(normalizeTimezone("PST")).toBe("America/Los_Angeles");
    expect(timezoneOptions()).not.toContain("PST");
  });
});

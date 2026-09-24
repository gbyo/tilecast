import { describe, expect, it } from "vitest";
import { clockText, dateText } from "./WidgetLivePreview";

describe("organization regional formatting in widget previews", () => {
  const now = new Date("2026-01-01T13:05:00Z");

  it("uses the organization locale, timezone, and 12/24-hour choices", () => {
    const clock = {
      timezone: "",
      format: "locale" as const,
      showSeconds: false,
      foregroundColor: "#fff",
      backgroundColor: "#000",
    };
    expect(clockText(clock, "de-DE", "Europe/Berlin", "locale", now)).toBe(
      new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin",
        hour: "numeric",
        minute: "2-digit",
      }).format(now),
    );
    expect(clockText(clock, "de-DE", "Europe/Berlin", "12-hour", now)).toBe(
      new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(now),
    );
    expect(
      clockText({ ...clock, format: "24" }, "en-US", "UTC", "12-hour", now),
    ).toMatch(/13:05/);
  });

  it("uses organization date order unless the widget selects a style", () => {
    const date = {
      timezone: "",
      format: "locale" as const,
      foregroundColor: "#fff",
      backgroundColor: "#000",
    };
    expect(dateText(date, "de-DE", "Europe/Berlin", "dd/MM/yyyy", now)).toBe(
      "01/01/2026",
    );
    expect(
      dateText(
        { ...date, format: "full" },
        "de-DE",
        "Europe/Berlin",
        "MM/dd/yyyy",
        now,
      ),
    ).toContain("Donnerstag");
  });
});

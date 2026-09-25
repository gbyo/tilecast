import { describe, expect, it } from "vitest";
import {
  organizationRegionalProfile,
  type OrganizationRegionalProfile,
} from "./regionalProfile";
import { formatRegionalDateTimeValue } from "./regionalFormatting";

const profile = (locale: string): OrganizationRegionalProfile =>
  organizationRegionalProfile({
    "organization.locale": locale,
    "organization.timezone": "Europe/Berlin",
    "organization.date_format": "locale",
    "organization.time_format": "locale",
  });

describe("organization preview formatting", () => {
  it.each(["en-US", "en-GB", "de-DE", "es-ES", "ru-RU"])(
    "uses %s as the signage date locale",
    (locale) => {
      const value = "2026-03-04";
      const output = formatRegionalDateTimeValue(
        value,
        "date",
        profile(locale),
      );
      expect(output).toBe(
        new Intl.DateTimeFormat(locale, {
          dateStyle: "short",
          timeZone: "UTC",
        }).format(new Date(`${value}T00:00:00Z`)),
      );
    },
  );

  it("uses the organization locale for numbers and dates independently of Studio", () => {
    const value = "2026-09-24";
    const german = profile("de-DE");
    const american = profile("en-US");
    expect(formatRegionalDateTimeValue(value, "date", german)).toBe(
      new Intl.DateTimeFormat("de-DE", {
        dateStyle: "short",
        timeZone: "UTC",
      }).format(new Date("2026-09-24T00:00:00Z")),
    );
    expect(formatRegionalDateTimeValue(value, "date", german)).not.toBe(
      formatRegionalDateTimeValue(value, "date", american),
    );
  });

  it("uses explicit organization date and time preferences", () => {
    const explicit = organizationRegionalProfile({
      "organization.locale": "de-DE",
      "organization.timezone": "Europe/Berlin",
      "organization.date_format": "MM/dd/yyyy",
      "organization.time_format": "12-hour",
    });
    expect(
      formatRegionalDateTimeValue("2026-09-24T13:05:00Z", "datetime", explicit),
    ).toContain("09/24/2026");
    expect(
      formatRegionalDateTimeValue("2026-09-24T13:05:00Z", "time", explicit),
    ).toMatch(/PM/);
    expect(
      formatRegionalDateTimeValue("2026-09-24T13:05:00Z", "time", {
        ...explicit,
        timeFormat: "24-hour",
      }),
    ).not.toMatch(/AM|PM/);
  });

  it("leaves non-ISO human dates alone instead of invoking Date.parse", () => {
    expect(
      formatRegionalDateTimeValue("03/04/2026", "date", profile("de-DE")),
    ).toBe("03/04/2026");
  });

  it("rejects invalid ISO calendar dates and times", () => {
    expect(
      formatRegionalDateTimeValue(
        "2026-02-30T12:00:00Z",
        "date",
        profile("de-DE"),
      ),
    ).toBe("2026-02-30T12:00:00Z");
    expect(
      formatRegionalDateTimeValue(
        "2026-09-24T25:00:00Z",
        "time",
        profile("de-DE"),
      ),
    ).toBe("2026-09-24T25:00:00Z");
  });
});

import { describe, expect, it } from "vitest";
import {
  formatPresentationValue,
  selectTemporalRecords,
} from "./SourceEditors";

const now = new Date("2026-08-24T13:30:00Z");
const records = [
  {
    id: "algebra",
    start: "2026-08-24T13:00:00Z",
    end: "2026-08-24T14:00:00Z",
  },
  {
    id: "science",
    start: "2026-08-24T14:10:00Z",
    end: "2026-08-24T15:00:00Z",
  },
  {
    id: "art",
    start: "2026-08-24T15:10:00Z",
    end: "2026-08-24T16:00:00Z",
  },
];

describe("temporal presentation preview", () => {
  it("selects current and future records using preview time", () => {
    expect(
      selectTemporalRecords(records, now, "current", "start", "end").map(
        (record) => record.id,
      ),
    ).toEqual(["algebra"]);
    expect(
      selectTemporalRecords(records, now, "next", "start", "end").map(
        (record) => record.id,
      ),
    ).toEqual(["science"]);
    expect(
      selectTemporalRecords(records, now, "upcoming", "start", "end").map(
        (record) => record.id,
      ),
    ).toEqual(["science", "art"]);
  });

  it("falls back to the next record when nothing is current", () => {
    const later = new Date("2026-08-24T14:05:00Z");
    expect(
      selectTemporalRecords(records, later, "current", "start", "end"),
    ).toEqual([]);
    expect(
      selectTemporalRecords(
        records,
        later,
        "current_or_next",
        "start",
        "end",
      ).map((record) => record.id),
    ).toEqual(["science"]);
    expect(
      selectTemporalRecords(
        records,
        now,
        "current_or_next",
        "start",
        "end",
      ).map((record) => record.id),
    ).toEqual(["algebra"]);
  });

  it("excludes records without a valid end instant from current only", () => {
    const openEnded = [
      { id: "assembly", start: "2026-08-24T13:00:00Z", end: "" },
      { id: "practice", start: "2026-08-24T16:30:00Z", end: "not-a-date" },
    ];
    expect(
      selectTemporalRecords(openEnded, now, "current", "start", "end"),
    ).toEqual([]);
    expect(
      selectTemporalRecords(openEnded, now, "upcoming", "start", "end").map(
        (record) => record.id,
      ),
    ).toEqual(["practice"]);
  });

  it("uses the same compact countdown wording as the Player", () => {
    expect(
      formatPresentationValue(
        "2026-08-24T14:10:00Z",
        { source: "repeat", format: "relative-countdown" },
        now,
      ),
    ).toBe("40m 0s");
    expect(
      formatPresentationValue(
        "2026-08-24T13:00:00Z",
        { source: "repeat", format: "relative-countdown" },
        now,
      ),
    ).toBe("Now");
  });

  it("formats numeric values the way the Player does", () => {
    expect(
      formatPresentationValue(
        "42.5",
        { source: "repeat", format: "percent", precision: 1 },
        now,
      ),
    ).toBe("42.5%");
    expect(
      formatPresentationValue(
        "1200",
        { source: "repeat", format: "currency", precision: 2 },
        now,
        "USD",
      ),
    ).toBe("$1,200.00");
    // No currency metadata reaches the preview, so the value stays a plain number.
    expect(
      formatPresentationValue(
        "1200",
        { source: "repeat", format: "currency", precision: 2 },
        now,
      ),
    ).toBe("1,200.00");
  });

  it("formats explicit EUR with organization separators and keeps its currency", () => {
    const rendered = formatPresentationValue(
      "1234.5",
      { source: "repeat", format: "currency", precision: 2 },
      now,
      "EUR",
      "de-DE",
    );
    expect(rendered.replace(/[\u00a0\u202f]/g, " ")).toBe("1.234,50 €");
  });

  it.each([
    ["JPY", 0],
    ["KWD", 3],
  ])(
    "uses %s minor-unit precision from the explicit currency metadata",
    (currency, fractionDigits) => {
      const regional = {
        locale: "en-US",
        timezone: "America/New_York",
        dateFormat: "locale",
        timeFormat: "locale",
      };
      const rendered = formatPresentationValue(
        "1234.5",
        { source: "repeat", format: "currency" },
        now,
        currency,
        undefined,
        undefined,
        regional,
      );
      // Compare to the platform's ISO currency metadata, allowing only
      // inconsequential ICU spacing differences.
      const platformExpected = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
      })
        .format(1234.5)
        .replace(/[\u00a0\u202f]/g, " ");
      expect(
        new Intl.NumberFormat("en-US", {
          style: "currency",
          currency,
        }).resolvedOptions().maximumFractionDigits,
      ).toBe(fractionDigits);
      expect(rendered.replace(/[\u00a0\u202f]/g, " ")).toBe(platformExpected);
    },
  );

  it("uses organization number separators for plain numbers", () => {
    expect(
      formatPresentationValue(
        "1234.5",
        { source: "repeat", format: "number", precision: 2 },
        now,
        undefined,
        "de-DE",
      ),
    ).toBe("1.234,50");
  });

  it("uses the regional profile locale when no Studio locale is supplied", () => {
    expect(
      formatPresentationValue(
        "1234.5",
        { source: "repeat", format: "number", precision: 2 },
        now,
        undefined,
        undefined,
        undefined,
        {
          locale: "de-DE",
          timezone: "Europe/Berlin",
          dateFormat: "locale",
          timeFormat: "locale",
        },
      ),
    ).toBe("1.234,50");
  });
});

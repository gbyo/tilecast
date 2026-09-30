import { describe, expect, it } from "vitest";
import { schedule } from "./fixtures";
import { upcomingChanges } from "./upcoming";

const now = new Date("2026-09-29T10:00:00Z");

describe("upcomingChanges", () => {
  it("returns the next start and end of a weekly window", () => {
    const changes = upcomingChanges([schedule()], now);
    expect(
      changes.map((change) => [change.kind, change.at.toISOString()]),
    ).toEqual([["starts", "2026-09-29T11:00:00.000Z"]]);
  });

  it("reports the end of a window that is running now", () => {
    const changes = upcomingChanges(
      [schedule()],
      new Date("2026-09-29T12:00:00Z"),
    );
    expect(
      changes.map((change) => [change.kind, change.at.toISOString()]),
    ).toEqual([
      ["ends", "2026-09-29T13:00:00.000Z"],
      ["starts", "2026-09-30T11:00:00.000Z"],
    ]);
  });

  it("reads clock times in the schedule's own zone", () => {
    const changes = upcomingChanges(
      [
        schedule({
          timezone: "America/New_York",
          dailyStart: "09:00",
          dailyEnd: undefined,
        }),
      ],
      now,
    );
    // 9:00 in New York is 13:00 UTC while daylight time is in force.
    expect(changes[0]?.at.toISOString()).toBe("2026-09-29T13:00:00.000Z");
  });

  it("stays correct across a daylight-saving change", () => {
    const changes = upcomingChanges(
      [
        schedule({
          timezone: "America/New_York",
          dailyStart: "09:00",
          dailyEnd: undefined,
        }),
      ],
      new Date("2026-11-01T12:00:00Z"),
    );
    // Daylight time ended that morning, so 9:00 is 14:00 UTC.
    expect(changes[0]?.at.toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("skips days outside the schedule's date range", () => {
    const changes = upcomingChanges(
      [schedule({ startDate: "2026-10-05", dailyEnd: undefined })],
      now,
    );
    expect(changes[0]?.at.toISOString()).toBe("2026-10-05T11:00:00.000Z");
  });

  it("returns nothing once the date range has ended", () => {
    expect(upcomingChanges([schedule({ endDate: "2026-09-28" })], now)).toEqual(
      [],
    );
  });

  it("ends an overnight window on the next day", () => {
    const changes = upcomingChanges(
      [schedule({ dailyStart: "22:00", dailyEnd: "02:00" })],
      new Date("2026-09-29T23:00:00Z"),
    );
    expect(changes[0]).toMatchObject({ kind: "ends" });
    expect(changes[0]?.at.toISOString()).toBe("2026-09-30T02:00:00.000Z");
  });

  it("honors the selected days of the week", () => {
    // 2026-09-29 is a Tuesday; only Friday (5) is scheduled.
    const changes = upcomingChanges(
      [schedule({ daysOfWeek: [5], dailyEnd: undefined })],
      now,
    );
    expect(changes[0]?.at.toISOString()).toBe("2026-10-02T11:00:00.000Z");
  });

  it("handles one-time schedules and drops disabled or display-control ones", () => {
    const changes = upcomingChanges(
      [
        schedule({
          id: "once",
          type: "one_time",
          oneTimeStart: "2026-09-29T15:00:00Z",
          oneTimeEnd: "2026-09-29T16:00:00Z",
          daysOfWeek: [],
        }),
        schedule({ id: "off", enabled: false }),
        schedule({ id: "display", presentationType: "display_control" }),
      ],
      now,
    );
    expect(changes.map((change) => [change.schedule.id, change.kind])).toEqual([
      ["once", "starts"],
      ["once", "ends"],
    ]);
  });

  it("falls back when a schedule's zone cannot be read", () => {
    const changes = upcomingChanges(
      [schedule({ timezone: "Not/AZone", dailyEnd: undefined })],
      now,
      "UTC",
    );
    expect(changes[0]?.at.toISOString()).toBe("2026-09-29T11:00:00.000Z");
  });
});

import { describe, expect, it } from "vitest";
import { activeHoursFromConfig, evaluateActiveHours } from "./active-hours";

// Weekdays Mon–Fri, 07:00–19:00 America/New_York.
const weekday: Parameters<typeof evaluateActiveHours>[0] = {
  enabled: true,
  timezone: "America/New_York",
  days: [1, 2, 3, 4, 5],
  start: "07:00",
  end: "19:00",
};

// A Wednesday in July (no DST edge): 2026-07-15.
const wed = (hhmm: string) => new Date(`2026-07-15T${hhmm}:00-04:00`);

describe("evaluateActiveHours", () => {
  it("is active during a weekday window", () => {
    expect(evaluateActiveHours(weekday, wed("09:30")).active).toBe(true);
  });

  it("is inactive before and after the window", () => {
    expect(evaluateActiveHours(weekday, wed("06:59")).active).toBe(false);
    expect(evaluateActiveHours(weekday, wed("19:00")).active).toBe(false); // half-open
    expect(evaluateActiveHours(weekday, wed("23:00")).active).toBe(false);
  });

  it("is inactive on excluded days", () => {
    // 2026-07-18 is a Saturday.
    const sat = new Date("2026-07-18T09:30:00-04:00");
    expect(evaluateActiveHours(weekday, sat).active).toBe(false);
  });

  it("handles overnight windows spanning midnight", () => {
    const overnight = {
      enabled: true,
      timezone: "America/New_York",
      days: [5], // Friday 20:00 -> Saturday 02:00
      start: "20:00",
      end: "02:00",
    };
    // Friday 22:00 active.
    expect(
      evaluateActiveHours(overnight, new Date("2026-07-17T22:00:00-04:00"))
        .active,
    ).toBe(true);
    // Saturday 01:00 still active (belongs to Friday's window).
    expect(
      evaluateActiveHours(overnight, new Date("2026-07-18T01:00:00-04:00"))
        .active,
    ).toBe(true);
    // Saturday 03:00 inactive.
    expect(
      evaluateActiveHours(overnight, new Date("2026-07-18T03:00:00-04:00"))
        .active,
    ).toBe(false);
  });

  it("stays active when disabled or misconfigured (never darks by accident)", () => {
    expect(evaluateActiveHours(null, wed("03:00")).active).toBe(true);
    expect(
      evaluateActiveHours({ ...weekday, enabled: false }, wed("03:00")).active,
    ).toBe(true);
    expect(
      evaluateActiveHours({ ...weekday, start: "bad" }, wed("03:00")).active,
    ).toBe(true);
  });

  it("reports a positive time to the next transition", () => {
    const result = evaluateActiveHours(weekday, wed("09:30"));
    expect(result.msUntilTransition).toBeGreaterThan(0);
  });
});

describe("activeHoursFromConfig", () => {
  it("reads the power config map", () => {
    const config = activeHoursFromConfig({
      activeHoursEnabled: true,
      activeHoursTimezone: "America/Chicago",
      activeHoursDays: [1, 2, 3, 4, 5],
      activeHoursStart: "08:00",
      activeHoursEnd: "17:00",
    });
    expect(config).toMatchObject({
      enabled: true,
      timezone: "America/Chicago",
      days: [1, 2, 3, 4, 5],
      start: "08:00",
      end: "17:00",
    });
  });

  it("rejects fractional weekdays so malformed schedules fail open", () => {
    const config = activeHoursFromConfig({
      activeHoursEnabled: true,
      activeHoursTimezone: "America/New_York",
      activeHoursDays: [1.5],
      activeHoursStart: "07:00",
      activeHoursEnd: "19:00",
    });

    expect(config?.days).toEqual([]);
    expect(evaluateActiveHours(config, wed("09:30")).active).toBe(true);
  });

  it("returns a disabled config when the flag is off", () => {
    expect(activeHoursFromConfig({ activeHoursEnabled: false })?.enabled).toBe(
      false,
    );
    expect(activeHoursFromConfig(undefined)).toBeNull();
  });
});

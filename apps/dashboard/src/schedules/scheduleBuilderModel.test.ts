import { describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import {
  describeDaysCompact,
  describeScheduleTiming,
  describeScheduleWhen,
  displayActionLabel,
  formatClockRange,
  oneTimeDuration,
  priorityPreset,
  type ScheduleTimingFields,
} from "./scheduleBuilderModel";

// Helpers take the English `t` so assertions keep reading the English copy.
// The locale is pinned so clock and date assertions never depend on jsdom's
// default region.
const t = i18n.getFixedT("en", "schedules");
const locale = "en-US";

const weekly = (
  changes: Partial<ScheduleTimingFields> = {},
): ScheduleTimingFields => ({
  type: "weekly",
  timezone: "America/Chicago",
  daysOfWeek: [1, 2, 3, 4, 5],
  dailyStart: "07:15",
  dailyEnd: "08:15",
  ...changes,
});

describe("Schedule vocabulary", () => {
  it("names the priority presets and treats anything else as custom", () => {
    expect(priorityPreset(0)).toBe("normal");
    expect(priorityPreset(100)).toBe("important");
    expect(priorityPreset(500)).toBe("special");
    expect(priorityPreset(40)).toBe("custom");
    expect(priorityPreset(-1)).toBe("custom");
  });

  it("collapses runs of three or more days and lists the rest", () => {
    expect(describeDaysCompact([1, 2, 3, 4, 5], t)).toBe("Mon–Fri");
    expect(describeDaysCompact([1, 3, 5], t)).toBe("Mon, Wed, Fri");
    expect(describeDaysCompact([6, 0], t)).toBe("Sat, Sun");
    expect(describeDaysCompact([0, 1, 2, 3, 4, 5, 6], t)).toBe("Every day");
    expect(describeDaysCompact([5, 6, 0], t)).toBe("Fri–Sun");
    expect(describeDaysCompact([2], t)).toBe("Tue");
    expect(describeDaysCompact([], t)).toBe("no days selected");
  });

  it("reads a time range without repeating the meridiem", () => {
    expect(formatClockRange("07:15", "08:15", t, locale)).toMatch(
      /7:15\s*–\s*8:15\s*AM/,
    );
    expect(formatClockRange("", "08:15", t, locale)).toBe("Not set");
  });

  it("describes a recurring schedule as days, times, and its own timezone", () => {
    const summary = describeScheduleTiming(weekly(), t, locale);
    expect(summary).toMatch(
      /^Mon–Fri · 7:15\s*–\s*8:15\s*AM · America\/Chicago$/,
    );
  });

  it("marks an overnight window as ending the next day", () => {
    const { lines } = describeScheduleWhen(
      weekly({ daysOfWeek: [5], dailyStart: "22:00", dailyEnd: "02:00" }),
      t,
      locale,
    );
    expect(lines[1]).toMatch(/\(next day\)$/);
  });

  it("describes optional date bounds", () => {
    const between = describeScheduleWhen(
      weekly({ startDate: "2026-08-01", endDate: "2026-08-31" }),
      t,
      locale,
    ).lines.at(-1);
    expect(between).toBe("Aug 1, 2026 – Aug 31, 2026");
    expect(
      describeScheduleWhen(
        weekly({ startDate: "2026-08-01" }),
        t,
        locale,
      ).lines.at(-1),
    ).toBe("from Aug 1, 2026");
    expect(
      describeScheduleWhen(
        weekly({ endDate: "2026-08-31" }),
        t,
        locale,
      ).lines.at(-1),
    ).toBe("until Aug 31, 2026");
  });

  it("shows a one-time event in the schedule's timezone, not the browser's", () => {
    // 23:00Z on Oct 31 is 7 PM in New York (EDT, UTC-4) whatever zone the
    // browser is in; the window ends 1 AM Nov 1 (still EDT).
    const text = describeScheduleTiming(
      {
        type: "one_time",
        timezone: "America/New_York",
        daysOfWeek: [],
        oneTimeStart: "2026-10-31T23:00:00Z",
        oneTimeEnd: "2026-11-01T05:00:00Z",
      },
      t,
      locale,
    );
    expect(text).toContain("7:00");
    expect(text).toContain("1:00");
    expect(text).toContain("Oct 31, 2026");
    expect(text).toContain("America/New_York");
  });

  it("reads the same event differently in another timezone", () => {
    const fields: ScheduleTimingFields = {
      type: "one_time",
      timezone: "Asia/Tokyo",
      daysOfWeek: [],
      oneTimeStart: "2026-10-31T23:00:00Z",
      oneTimeEnd: "2026-11-01T05:00:00Z",
    };
    // Tokyo is UTC+9: 08:00 on Nov 1 to 14:00.
    expect(describeScheduleTiming(fields, t, locale)).toContain("Nov 1, 2026");
    expect(describeScheduleTiming(fields, t, locale)).toContain("8:00");
  });

  it("asks for a start and end until a one-time window is chosen", () => {
    expect(
      describeScheduleTiming(
        { type: "one_time", timezone: "UTC", daysOfWeek: [] },
        t,
        locale,
      ),
    ).toBe("Choose a start and end time");
  });

  it("measures a one-time duration", () => {
    const duration = (start: string, end: string) =>
      oneTimeDuration({ oneTimeStart: start, oneTimeEnd: end }, t);
    expect(duration("2026-10-06T10:00:00Z", "2026-10-06T11:30:00Z")).toBe(
      "1 hr 30 min",
    );
    expect(duration("2026-10-06T10:00:00Z", "2026-10-08T10:00:00Z")).toBe(
      "2 days",
    );
    expect(duration("2026-10-06T10:00:00Z", "2026-10-06T10:00:00Z")).toBe(
      "End must be after start",
    );
  });

  it("words every display action with one shared helper", () => {
    expect(displayActionLabel({ type: "display_power_off" }, t)).toBe(
      "Power off display",
    );
    expect(
      displayActionLabel({ type: "display_set_volume", volume: 40 }, t),
    ).toBe("Set display volume to 40");
    expect(displayActionLabel({ type: "display_set_input" }, t)).toBe(
      "Set display input to not set",
    );
  });
});

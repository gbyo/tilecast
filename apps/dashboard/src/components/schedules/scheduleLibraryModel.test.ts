import { describe, expect, it } from "vitest";
import type { Schedule } from "../../api/types";
import { i18n } from "../../i18n";
import {
  activeScheduleFacetCount,
  describeWeekdaysCompact,
  formatScheduleUpdated,
  isScheduleListNarrowed,
  scheduleFacets,
  schedulePresentation,
  scheduleTargetSummary,
  scheduleWhen,
} from "./scheduleLibraryModel";

// English copy and a pinned locale keep assertions independent of the
// machine that runs them.
const t = i18n.getFixedT("en", "schedules");
const locale = "en-US";
const now = new Date("2026-10-06T15:00:00Z");

// Intl output separates times with narrow and thin spaces. The words are
// what matters here, so compare with ordinary spaces.
const plain = (value: string) => value.replace(/\s/g, " ");

const weekly = (changes: Partial<Schedule> = {}) =>
  ({
    type: "weekly",
    timezone: "America/Chicago",
    daysOfWeek: [1, 2, 3, 4, 5],
    dailyStart: "07:15",
    dailyEnd: "08:15",
    ...changes,
  }) as Schedule;

const oneTime = (changes: Partial<Schedule> = {}) =>
  ({
    type: "one_time",
    timezone: "America/New_York",
    daysOfWeek: [],
    oneTimeStart: "2026-11-01T00:00:00Z",
    oneTimeEnd: "2026-11-01T02:00:00Z",
    ...changes,
  }) as Schedule;

const when = (schedule: Schedule) => {
  const result = scheduleWhen(schedule, t, locale, now);
  return {
    summary: plain(result.summary),
    detail: plain(result.detail),
  };
};

describe("weekday summary", () => {
  it.each([
    [[1, 2, 3, 4, 5], "Mon–Fri"],
    [[0, 1, 2, 3, 4, 5, 6], "Every day"],
    [[5], "Fri"],
    [[6, 0], "Sat, Sun"],
    [[1, 3, 5], "Mon, Wed, Fri"],
    [[1, 2, 3, 5], "Mon–Wed, Fri"],
    [[1, 2], "Mon, Tue"],
    // The week starts on Monday, so a Saturday-through-Monday run is
    // Mon plus Sat–Sun listed, never a wrapped range.
    [[6, 0, 1], "Mon, Sat, Sun"],
    [[], "no days selected"],
  ])("%j reads %s", (days, expected) => {
    expect(describeWeekdaysCompact(days, t)).toBe(expected);
  });

  it("ignores the order the server sent", () => {
    expect(describeWeekdaysCompact([5, 3, 4], t)).toBe("Wed–Fri");
  });
});

describe("weekly timing", () => {
  it("shows days, hours, and the IANA zone", () => {
    expect(when(weekly())).toEqual({
      summary: "Mon–Fri · 7:15 – 8:15 AM",
      detail: "America/Chicago",
    });
  });

  it("keeps both meridiems when the range crosses noon", () => {
    expect(
      when(weekly({ dailyStart: "10:30", dailyEnd: "13:30" })).summary,
    ).toBe("Mon–Fri · 10:30 AM – 1:30 PM");
  });

  it("marks an overnight window as ending the next day", () => {
    expect(
      when(weekly({ daysOfWeek: [5], dailyStart: "22:00", dailyEnd: "02:00" })),
    ).toEqual({
      summary: "Fri · 10:00 PM – 2:00 AM next day",
      detail: "America/Chicago",
    });
  });

  it("treats an equal start and end as a full-day overnight window", () => {
    expect(
      when(weekly({ dailyStart: "09:00", dailyEnd: "09:00" })).summary,
    ).toMatch(/next day$/);
  });

  it("adds a date range ahead of the zone", () => {
    expect(
      when(weekly({ startDate: "2026-10-01", endDate: "2026-12-20" })).detail,
    ).toBe("Oct 1 – Dec 20 · America/Chicago");
  });

  it("describes a start date or an end date alone", () => {
    expect(when(weekly({ startDate: "2026-10-01" })).detail).toBe(
      "From Oct 1 · America/Chicago",
    );
    expect(when(weekly({ endDate: "2026-12-20" })).detail).toBe(
      "Until Dec 20 · America/Chicago",
    );
  });

  it("names the year only when a date is outside the current one", () => {
    expect(
      when(weekly({ startDate: "2026-12-18", endDate: "2027-01-04" })).detail,
    ).toBe("Dec 18, 2026 – Jan 4, 2027 · America/Chicago");
    expect(when(weekly({ startDate: "2025-10-01" })).detail).toBe(
      "From Oct 1, 2025 · America/Chicago",
    );
  });
});

describe("one-time timing", () => {
  it("shows a same-day event as a date and an hour range in its own zone", () => {
    // 20:00–23:00 Eastern on Oct 31, which is already Nov 1 in UTC.
    expect(
      when(
        oneTime({
          oneTimeStart: "2026-11-01T00:00:00Z",
          oneTimeEnd: "2026-11-01T02:00:00Z",
        }),
      ),
    ).toEqual({
      summary: "Oct 31 · 8:00 – 10:00 PM",
      detail: "America/New_York",
    });
  });

  it("shows an event crossing midnight with both dates", () => {
    expect(
      when(
        oneTime({
          oneTimeStart: "2026-11-01T00:00:00Z",
          oneTimeEnd: "2026-11-01T05:00:00Z",
        }),
      ).summary,
    ).toBe("Oct 31, 8:00 PM – Nov 1, 1:00 AM");
  });

  it("formats in the schedule zone, not the zone of the process", () => {
    const instant = {
      oneTimeStart: "2026-07-04T01:00:00Z",
      oneTimeEnd: "2026-07-04T03:00:00Z",
    };
    expect(
      when(oneTime({ ...instant, timezone: "America/Los_Angeles" })),
    ).toEqual({
      summary: "Jul 3 · 6:00 – 8:00 PM",
      detail: "America/Los_Angeles",
    });
    expect(when(oneTime({ ...instant, timezone: "Asia/Tokyo" }))).toEqual({
      summary: "Jul 4 · 10:00 AM – 12:00 PM",
      detail: "Asia/Tokyo",
    });
  });

  it("reads wall-clock times across the fall-back change", () => {
    // New York leaves daylight time at 02:00 on Nov 1, 2026.
    expect(
      when(
        oneTime({
          oneTimeStart: "2026-11-01T04:30:00Z",
          oneTimeEnd: "2026-11-01T07:30:00Z",
        }),
      ).summary,
    ).toBe("Nov 1 · 12:30 – 2:30 AM");
  });

  it("reads wall-clock times across the spring-forward change", () => {
    // New York skips 02:00–03:00 on Mar 8, 2026.
    expect(
      when(
        oneTime({
          oneTimeStart: "2026-03-08T06:30:00Z",
          oneTimeEnd: "2026-03-08T07:30:00Z",
        }),
      ).summary,
    ).toBe("Mar 8 · 1:30 – 3:30 AM");
  });

  it("names the year of an event outside the current one", () => {
    expect(
      when(
        oneTime({
          oneTimeStart: "2025-11-01T00:00:00Z",
          oneTimeEnd: "2025-11-01T02:00:00Z",
        }),
      ).summary,
    ).toBe("Oct 31, 2025 · 8:00 – 10:00 PM");
  });

  it("does not throw for a zone the runtime does not know", () => {
    expect(() =>
      when(oneTime({ timezone: "Mars/Olympus_Mons" })),
    ).not.toThrow();
  });
});

describe("presentation", () => {
  const base = {
    playlistName: "",
    layoutName: undefined,
    displayAction: undefined,
  };

  it("names a playlist", () => {
    expect(
      schedulePresentation(
        {
          ...base,
          presentationType: "playlist",
          playlistName: "Lunch Rotation",
        },
        t,
      ),
    ).toEqual({ kind: "playlist", label: "Lunch Rotation" });
  });

  it("names a layout from its own name", () => {
    expect(
      schedulePresentation(
        {
          ...base,
          presentationType: "layout",
          playlistName: "Menu board",
          layoutName: "Menu board",
        },
        t,
      ),
    ).toEqual({ kind: "layout", label: "Menu board" });
  });

  it.each([
    [{ type: "display_power_on" }, "Power on display"],
    [
      { type: "display_set_input", input: "1.0.0.0" },
      "Set display input to 1.0.0.0",
    ],
    [{ type: "display_set_volume", volume: 20 }, "Set display volume to 20"],
  ] as const)(
    "describes the display action %j without the raw enum",
    (action, label) => {
      const result = schedulePresentation(
        { ...base, presentationType: "display_control", displayAction: action },
        t,
      );
      expect(result).toEqual({ kind: "display_control", label });
      expect(result.label).not.toMatch(/display_/);
    },
  );
});

describe("targets", () => {
  const names = (...values: string[]) =>
    values.map((name, index) => ({
      type: "group" as const,
      id: String(index),
      name,
    }));

  it("lists up to two targets", () => {
    expect(scheduleTargetSummary(names("Cafeteria Displays"), t).text).toBe(
      "Cafeteria Displays",
    );
    expect(
      scheduleTargetSummary(names("Libraries", "Front Office"), t).text,
    ).toBe("Libraries, Front Office");
  });

  it("counts the rest and keeps every name", () => {
    const summary = scheduleTargetSummary(
      names("Libraries", "Front Office", "Gym", "Board Room", "Lobby"),
      t,
    );
    expect(summary.text).toBe("Libraries, Front Office +3");
    expect(summary.hidden).toBe(3);
    expect(summary.names).toEqual([
      "Libraries",
      "Front Office",
      "Gym",
      "Board Room",
      "Lobby",
    ]);
  });

  it("falls back for an unnamed target and for none", () => {
    expect(scheduleTargetSummary([{ type: "screen", id: "1" }], t).text).toBe(
      "Selected target",
    );
    expect(scheduleTargetSummary([], t).text).toBe("No targets");
  });
});

describe("updated", () => {
  const ago = (milliseconds: number) =>
    new Date(now.getTime() - milliseconds).toISOString();

  it.each([
    [10_000, "now"],
    [12 * 60_000, "12 min. ago"],
    [2 * 3_600_000, "2 hr. ago"],
    [24 * 3_600_000, "yesterday"],
    [3 * 86_400_000, "3 days ago"],
  ])("%d ms ago reads %s", (elapsed, expected) => {
    expect(formatScheduleUpdated(ago(elapsed), now, locale)).toBe(expected);
  });

  it("falls back to a date after a week, with the year when it differs", () => {
    expect(formatScheduleUpdated("2026-09-06T12:00:00Z", now, locale)).toBe(
      "Sep 6",
    );
    expect(formatScheduleUpdated("2025-09-06T12:00:00Z", now, locale)).toBe(
      "Sep 6, 2025",
    );
  });

  it("never reads as the future when the clock is skewed", () => {
    expect(formatScheduleUpdated("2026-10-06T15:05:00Z", now, locale)).toBe(
      "now",
    );
  });
});

describe("facets", () => {
  const params = {
    search: "",
    enabled: "" as const,
    type: "" as const,
    presentationType: "" as const,
    sort: "updated" as const,
  };

  it("counts only facets, never search or sort", () => {
    expect(
      activeScheduleFacetCount(
        scheduleFacets({ ...params, search: "lunch", sort: "name" }),
      ),
    ).toBe(0);
    expect(
      activeScheduleFacetCount(
        scheduleFacets({ ...params, enabled: "true", type: "weekly" }),
      ),
    ).toBe(2);
  });

  it("treats search or any facet as narrowing, and sort as not", () => {
    expect(isScheduleListNarrowed(params)).toBe(false);
    expect(isScheduleListNarrowed({ ...params, sort: "priority" })).toBe(false);
    expect(isScheduleListNarrowed({ ...params, search: "  " })).toBe(false);
    expect(isScheduleListNarrowed({ ...params, search: "x" })).toBe(true);
    expect(
      isScheduleListNarrowed({ ...params, presentationType: "layout" }),
    ).toBe(true);
  });
});

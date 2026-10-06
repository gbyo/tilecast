import { describe, expect, it } from "vitest";
import type { Schedule } from "../api/types";
import {
  defaultOneTimeWindow,
  draftFromSchedule,
  draftToInput,
  emptyDraft,
  firstProblem,
  instantToWall,
  preflightBody,
  preflightSignature,
  sameDraft,
  scheduleProblems,
  wallToInstant,
  withoutTarget,
  withPresentationMode,
  withScheduleType,
  withTarget,
  withTimezone,
  type ScheduleDraft,
} from "./scheduleEditorModel";

const complete = (changes: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  ...emptyDraft("America/Chicago"),
  name: "Morning Broadcast",
  content: { kind: "playlist", id: "playlist-1", name: "Announcements" },
  targets: [{ type: "group", id: "group-1", name: "Libraries" }],
  ...changes,
});

const saved: Schedule = {
  id: "schedule-1",
  name: "Morning Broadcast",
  description: "Weekday mornings",
  playlistId: "playlist-1",
  playlistName: "Announcements",
  presentationType: "playlist",
  type: "weekly",
  timezone: "America/Chicago",
  priority: 40,
  specificity: 0,
  enabled: true,
  dailyStart: "07:15",
  dailyEnd: "08:15",
  daysOfWeek: [1, 2, 3, 4, 5],
  targets: [{ type: "group", id: "group-1", name: "Libraries" }],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

describe("Schedule draft", () => {
  it("starts a new schedule on weekdays, nine to five, enabled, normal priority", () => {
    const draft = emptyDraft("America/Chicago");
    expect(draft).toMatchObject({
      name: "",
      type: "weekly",
      daysOfWeek: [1, 2, 3, 4, 5],
      dailyStart: "09:00",
      dailyEnd: "17:00",
      priority: 0,
      enabled: true,
      timezone: "America/Chicago",
      targets: [],
      content: null,
      presentationMode: "content",
    });
  });

  it("reads a saved schedule without looking anything up", () => {
    const draft = draftFromSchedule(saved);
    expect(draft.content).toEqual({
      kind: "playlist",
      id: "playlist-1",
      name: "Announcements",
    });
    expect(draft.priority).toBe(40);
    expect(draft.dailyStart).toBe("07:15");
  });

  it("reads a layout schedule by its layout name", () => {
    const draft = draftFromSchedule({
      ...saved,
      presentationType: "layout",
      playlistId: "00000000-0000-0000-0000-000000000000",
      layoutId: "layout-1",
      layoutName: "Cafeteria Board",
      playlistName: "Cafeteria Board",
    });
    expect(draft.content).toEqual({
      kind: "layout",
      id: "layout-1",
      name: "Cafeteria Board",
    });
    expect(draftToInput(draft)).toMatchObject({ layoutId: "layout-1" });
    expect(draftToInput(draft)).not.toHaveProperty("playlistId");
  });

  it("reads a display-control schedule and a one-time schedule with no weekdays", () => {
    const draft = draftFromSchedule({
      ...saved,
      presentationType: "display_control",
      displayAction: { type: "display_set_volume", volume: 30 },
      type: "one_time",
      oneTimeStart: "2026-10-31T23:00:00Z",
      oneTimeEnd: "2026-11-01T05:00:00Z",
      dailyStart: undefined,
      dailyEnd: undefined,
      daysOfWeek: undefined as unknown as number[],
    });
    expect(draft.presentationMode).toBe("display_control");
    expect(draft.displayAction).toEqual({
      type: "display_set_volume",
      volume: 30,
    });
    expect(draft.type).toBe("one_time");
    expect(draft.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("saves only the active branches", () => {
    const weeklyInput = draftToInput(
      complete({
        oneTimeStart: "2026-10-06T10:00:00Z",
        oneTimeEnd: "2026-10-06T11:00:00Z",
      }),
    );
    expect(weeklyInput).not.toHaveProperty("oneTimeStart");
    expect(weeklyInput).toMatchObject({
      playlistId: "playlist-1",
      dailyStart: "09:00",
    });
    expect(weeklyInput.targets).toEqual([{ type: "group", id: "group-1" }]);

    const oneTime = draftToInput(
      complete({
        type: "one_time",
        oneTimeStart: "2026-10-06T10:00:00Z",
        oneTimeEnd: "2026-10-06T11:00:00Z",
        presentationMode: "display_control",
        displayAction: { type: "display_power_off" },
      }),
    );
    expect(oneTime).not.toHaveProperty("dailyStart");
    expect(oneTime).not.toHaveProperty("playlistId");
    expect(oneTime).toMatchObject({
      displayAction: { type: "display_power_off" },
      daysOfWeek: [],
    });
  });

  it("is clean after switching branches and back", () => {
    const base = complete();
    const there = withScheduleType(
      base,
      "one_time",
      new Date("2026-10-06T16:52:00Z"),
    );
    expect(sameDraft(base, there)).toBe(false);
    expect(sameDraft(base, withScheduleType(there, "weekly"))).toBe(true);
    const mode = withPresentationMode(base, "display_control");
    expect(sameDraft(base, mode)).toBe(false);
    expect(sameDraft(base, withPresentationMode(mode, "content"))).toBe(true);
  });

  it("keeps the other branch's values when switching", () => {
    const there = withScheduleType(
      complete(),
      "one_time",
      new Date("2026-10-06T16:52:00Z"),
    );
    const back = withScheduleType(there, "weekly");
    const again = withScheduleType(back, "one_time");
    expect(again.oneTimeStart).toBe(there.oneTimeStart);
  });

  it("adds and removes targets once", () => {
    const group = { type: "group" as const, id: "g", name: "G" };
    const once = withTarget([], group);
    expect(withTarget(once, group)).toHaveLength(1);
    expect(withTarget(once, { type: "screen", id: "g" })).toHaveLength(2);
    expect(withoutTarget(once, group)).toEqual([]);
  });
});

describe("Wall-clock time in a schedule's timezone", () => {
  it("round-trips an instant through its zone", () => {
    expect(instantToWall("2026-10-31T23:00:00Z", "America/New_York")).toBe(
      "2026-10-31T19:00",
    );
    expect(instantToWall("2026-12-01T00:30:00Z", "America/New_York")).toBe(
      "2026-11-30T19:30",
    );
    expect(wallToInstant("2026-10-31T19:00", "America/New_York")).toBe(
      "2026-10-31T23:00:00.000Z",
    );
    expect(wallToInstant("2026-11-30T19:30", "America/New_York")).toBe(
      "2026-12-01T00:30:00.000Z",
    );
  });

  it("takes the earlier instant when a wall time happens twice", () => {
    // Clocks go back at 02:00 EDT on 2026-11-01; 01:30 happens in EDT and EST.
    expect(wallToInstant("2026-11-01T01:30", "America/New_York")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("moves a nonexistent spring-forward time into the new hour", () => {
    // 02:30 never happens on 2026-03-08 in New York.
    expect(wallToInstant("2026-03-08T02:30", "America/New_York")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    // The hour before and after are ordinary.
    expect(wallToInstant("2026-03-08T01:30", "America/New_York")).toBe(
      "2026-03-08T06:30:00.000Z",
    );
    expect(wallToInstant("2026-03-08T03:30", "America/New_York")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
  });

  it("handles a zone ahead of UTC and one with a half-hour offset", () => {
    expect(wallToInstant("2026-10-06T09:00", "Pacific/Auckland")).toBe(
      "2026-10-05T20:00:00.000Z",
    );
    expect(wallToInstant("2026-10-06T09:00", "Asia/Kolkata")).toBe(
      "2026-10-06T03:30:00.000Z",
    );
    expect(instantToWall("2026-10-06T03:30:00Z", "Asia/Kolkata")).toBe(
      "2026-10-06T09:00",
    );
  });

  it("tolerates a name Intl rejects", () => {
    expect(instantToWall("2026-10-06T12:00:00Z", "Not/AZone")).toBe(
      "2026-10-06T12:00",
    );
    expect(wallToInstant("", "UTC")).toBe("");
  });

  it("keeps the wall-clock event when the timezone changes", () => {
    const draft = complete({
      type: "one_time",
      timezone: "America/New_York",
      oneTimeStart: "2026-10-31T23:00:00.000Z", // 7 PM EDT
      oneTimeEnd: "2026-11-01T05:00:00.000Z", // 1 AM EDT
    });
    const moved = withTimezone(draft, "America/Los_Angeles");
    expect(moved.timezone).toBe("America/Los_Angeles");
    expect(instantToWall(moved.oneTimeStart, "America/Los_Angeles")).toBe(
      "2026-10-31T19:00",
    );
    expect(instantToWall(moved.oneTimeEnd, "America/Los_Angeles")).toBe(
      "2026-11-01T01:00",
    );
    // Weekly times are already wall-clock and stay as written.
    expect(withTimezone(complete(), "Asia/Tokyo").dailyStart).toBe("09:00");
  });

  it("starts a first event on the next quarter hour, for an hour", () => {
    // 11:52 CDT -> 12:00 CDT.
    const window = defaultOneTimeWindow(
      new Date("2026-10-06T16:52:00Z"),
      "America/Chicago",
    );
    expect(window).toEqual({
      start: "2026-10-06T17:00:00.000Z",
      end: "2026-10-06T18:00:00.000Z",
    });
    // On the quarter hour exactly, the next one.
    expect(
      defaultOneTimeWindow(new Date("2026-10-06T17:00:00Z"), "America/Chicago")
        .start,
    ).toBe("2026-10-06T17:15:00.000Z");
    // Late evening rolls into the next day in the schedule's zone.
    expect(
      defaultOneTimeWindow(new Date("2026-10-07T04:50:00Z"), "America/Chicago")
        .start,
    ).toBe("2026-10-07T05:00:00.000Z");
  });
});

describe("Schedule validation", () => {
  it("accepts a complete draft", () => {
    expect(scheduleProblems(complete())).toEqual({});
  });

  it("names what is missing, in the order a reader meets it", () => {
    const problems = scheduleProblems(emptyDraft("America/Chicago"));
    expect(problems).toEqual({
      name: "nameRequired",
      presentation: "contentRequired",
      targets: "targetsRequired",
    });
    expect(firstProblem(problems)).toBe("name");
  });

  it("checks the chosen display action's own value", () => {
    const draft = (action: ScheduleDraft["displayAction"]) =>
      complete({ presentationMode: "display_control", displayAction: action });
    expect(scheduleProblems(draft({ type: "display_power_on" }))).toEqual({});
    expect(
      scheduleProblems(draft({ type: "display_set_input", input: " " })),
    ).toEqual({
      displayAction: "inputRequired",
    });
    expect(
      scheduleProblems(draft({ type: "display_set_volume", volume: 101 })),
    ).toEqual({
      displayAction: "volumeRange",
    });
    expect(scheduleProblems(draft({ type: "display_set_brightness" }))).toEqual(
      {
        displayAction: "brightnessRange",
      },
    );
    expect(
      scheduleProblems(
        draft({ type: "display_set_brightness", brightness: 50 }),
      ),
    ).toEqual({});
  });

  it("only complains about content when content is the presentation", () => {
    expect(
      scheduleProblems(
        complete({ content: null, presentationMode: "display_control" }),
      ),
    ).toEqual({});
  });

  it("checks weekly timing", () => {
    expect(scheduleProblems(complete({ daysOfWeek: [] }))).toEqual({
      days: "daysRequired",
    });
    expect(scheduleProblems(complete({ dailyStart: "" }))).toEqual({
      time: "timeRequired",
    });
    expect(
      scheduleProblems(
        complete({ startDate: "2026-09-02", endDate: "2026-09-01" }),
      ),
    ).toEqual({
      dateRange: "dateRangeInvalid",
    });
    // Overnight windows are valid.
    expect(
      scheduleProblems(complete({ dailyStart: "22:00", dailyEnd: "02:00" })),
    ).toEqual({});
  });

  it("checks one-time timing against the instants", () => {
    const base = complete({ type: "one_time" });
    expect(scheduleProblems(base)).toEqual({ oneTime: "oneTimeRequired" });
    expect(
      scheduleProblems({
        ...base,
        oneTimeStart: "2026-10-06T11:00:00Z",
        oneTimeEnd: "2026-10-06T10:00:00Z",
      }),
    ).toEqual({ oneTime: "oneTimeOrder" });
    expect(
      scheduleProblems({
        ...base,
        oneTimeStart: "2026-10-06T10:00:00Z",
        oneTimeEnd: "2026-10-06T11:00:00Z",
      }),
    ).toEqual({});
  });

  it("requires a real timezone and a whole priority in range", () => {
    expect(scheduleProblems(complete({ timezone: "" }))).toEqual({
      timezone: "timezoneRequired",
    });
    expect(scheduleProblems(complete({ priority: 1000 }))).toEqual({
      priority: "priorityRange",
    });
    expect(scheduleProblems(complete({ priority: -999 }))).toEqual({});
    expect(scheduleProblems(complete({ priority: 1.5 }))).toEqual({
      priority: "priorityRange",
    });
    expect(scheduleProblems(complete({ priority: NaN }))).toEqual({
      priority: "priorityRange",
    });
  });
});

describe("Preflight request", () => {
  it("waits for a draft that can be checked, but not for its name", () => {
    expect(preflightBody(emptyDraft("UTC"))).toBeNull();
    expect(preflightBody(complete({ name: "" }))).not.toBeNull();
    expect(preflightBody(complete({ targets: [] }))).toBeNull();
  });

  it("leaves the name and description out, so editing them asks nothing new", () => {
    const base = preflightSignature(complete());
    expect(
      preflightSignature(complete({ name: "Renamed", description: "More" })),
    ).toBe(base);
  });

  it("changes with everything that decides what plays", () => {
    const base = preflightSignature(complete());
    const changes: Partial<ScheduleDraft>[] = [
      { dailyStart: "08:00" },
      { daysOfWeek: [1, 2] },
      { timezone: "America/New_York" },
      { priority: 10 },
      { enabled: false },
      { targets: [{ type: "screen", id: "s1" }] },
      { content: { kind: "layout", id: "layout-1", name: "Board" } },
      { startDate: "2026-11-01" },
    ];
    for (const change of changes)
      expect(
        preflightSignature(complete(change)),
        JSON.stringify(change),
      ).not.toBe(base);
  });
});

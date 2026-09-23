import { describe, expect, it } from "vitest";
import type { ScheduleInput, Screen, ScreenGroup } from "../api/types";
import { i18n } from "../i18n";
import {
  conflictWinnerReason,
  countTargetScreens,
  describeScheduleTiming,
  oneTimeDuration,
  priorityPreset,
  scheduleIsDirty,
  setTargetSelected,
  validateScheduleInput,
} from "./scheduleBuilderModel";

// Helpers take the English `t` so assertions keep reading the English copy.
// The locale is pinned so clock and date assertions never depend on jsdom's
// default region.
const t = i18n.getFixedT("en", "schedules");
const locale = "en-US";

const weekly = (changes: Partial<ScheduleInput> = {}): ScheduleInput => ({
  name: "Morning",
  description: "",
  playlistId: "playlist-1",
  type: "weekly",
  timezone: "America/New_York",
  priority: 0,
  enabled: true,
  dailyStart: "09:00",
  dailyEnd: "17:00",
  daysOfWeek: [1, 2, 3, 4, 5],
  targets: [{ type: "screen", id: "screen-1", name: "Lobby" }],
  ...changes,
});

describe("Schedule Builder model", () => {
  it("describes a recurring weekday schedule", () => {
    expect(describeScheduleTiming(weekly(), t, locale)).toMatch(
      /Monday through Friday/,
    );
    expect(describeScheduleTiming(weekly(), t, locale)).toMatch(/9:00 AM/);
  });

  it("describes overnight windows as ending the following day", () => {
    expect(
      describeScheduleTiming(
        weekly({
          daysOfWeek: [5],
          dailyStart: "22:00",
          dailyEnd: "02:00",
        }),
        t,
        locale,
      ),
    ).toContain("following day");
  });

  it("includes optional weekly date ranges", () => {
    const description = describeScheduleTiming(
      weekly({ startDate: "2026-08-01", endDate: "2026-08-31" }),
      t,
      locale,
    );
    expect(description).toContain("beginning");
    expect(description).toContain("through");
  });

  it("validates and summarizes one-time events", () => {
    const input = weekly({
      type: "one_time",
      oneTimeStart: "2026-08-01T13:00:00Z",
      oneTimeEnd: "2026-08-01T15:30:00Z",
    });
    expect(oneTimeDuration(input, t)).toBe("2 hr 30 min");
    expect(validateScheduleInput(input, t)).toEqual({});
    expect(
      validateScheduleInput({ ...input, oneTimeEnd: input.oneTimeStart }, t),
    ).toHaveProperty("oneTime");
  });

  it("adds and removes targets without duplicates", () => {
    const target = {
      type: "group" as const,
      id: "group-1",
      name: "Library",
    };
    const added = setTargetSelected(weekly().targets, target, true);
    expect(added).toHaveLength(2);
    expect(setTargetSelected(added, target, true)).toHaveLength(2);
    expect(setTargetSelected(added, target, false)).toEqual(weekly().targets);
  });

  it("deduplicates screens selected directly and through groups", () => {
    const screens = [{ id: "screen-1" }, { id: "screen-2" }] as Screen[];
    const groups = [
      {
        id: "group-1",
        screens: [
          { id: "screen-1", name: "Lobby", location: "" },
          { id: "screen-2", name: "Cafe", location: "" },
        ],
      },
    ] as ScreenGroup[];
    expect(
      countTargetScreens(
        [
          { type: "screen", id: "screen-1" },
          { type: "group", id: "group-1" },
        ],
        screens,
        groups,
      ),
    ).toBe(2);
  });

  it("maps priority presets and explains conflict precedence", () => {
    expect(priorityPreset(0)).toBe("normal");
    expect(priorityPreset(100)).toBe("important");
    expect(priorityPreset(500)).toBe("special");
    expect(priorityPreset(42)).toBe("custom");
    expect(
      conflictWinnerReason({ priority: 100, specificity: 0 }, 0, t),
    ).toContain("highest priority");
    expect(
      conflictWinnerReason({ priority: 0, specificity: 1 }, 0, t),
    ).toContain("directly");
  });

  it("requires content, targets, days, and valid dates", () => {
    const errors = validateScheduleInput(
      weekly({
        name: "",
        playlistId: "",
        targets: [],
        daysOfWeek: [],
        startDate: "2026-09-02",
        endDate: "2026-09-01",
      }),
      t,
    );
    for (const key of [
      "name",
      "playlistId",
      "targets",
      "daysOfWeek",
      "dateRange",
    ])
      expect(errors[key]).toBeTypeOf("string");
  });

  it("tracks unsaved changes against the loaded schedule", () => {
    const baseline = weekly();
    expect(scheduleIsDirty(baseline, baseline)).toBe(false);
    expect(scheduleIsDirty({ ...baseline, name: "Changed" }, baseline)).toBe(
      true,
    );
  });
});

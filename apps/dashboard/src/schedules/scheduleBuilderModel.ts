import type { TFunction } from "i18next";
import type {
  ScheduleInput,
  ScheduleTarget,
  Screen,
  ScreenGroup,
} from "../api/types";

export type SchedulesT = TFunction<"schedules", undefined>;

export const scheduleWeekdays = [
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
  { value: 0, short: "Sun", long: "Sunday" },
] as const;

// Translated weekday names live in the schedules namespace. The English
// short/long above stay for plugins pages that have not converted yet.
const weekdayLabelKeys = {
  0: { short: "weekdays.sunday.short", long: "weekdays.sunday.long" },
  1: { short: "weekdays.monday.short", long: "weekdays.monday.long" },
  2: { short: "weekdays.tuesday.short", long: "weekdays.tuesday.long" },
  3: { short: "weekdays.wednesday.short", long: "weekdays.wednesday.long" },
  4: { short: "weekdays.thursday.short", long: "weekdays.thursday.long" },
  5: { short: "weekdays.friday.short", long: "weekdays.friday.long" },
  6: { short: "weekdays.saturday.short", long: "weekdays.saturday.long" },
} as const;

export function scheduleWeekdayLabels(value: number, t: SchedulesT) {
  const keys = weekdayLabelKeys[value as keyof typeof weekdayLabelKeys];
  return { short: t(keys.short), long: t(keys.long) };
}

export type PriorityPreset = "normal" | "important" | "special" | "custom";

export function priorityPreset(priority: number): PriorityPreset {
  if (priority === 0) return "normal";
  if (priority === 100) return "important";
  if (priority === 500) return "special";
  return "custom";
}

export function priorityLabel(priority: number, t: SchedulesT) {
  const preset = priorityPreset(priority);
  if (preset === "normal") return t("priority.presets.normal");
  if (preset === "important") return t("priority.presets.important");
  if (preset === "special") return t("priority.presets.special");
  return t("priority.customValue", { priority });
}

export function scheduleIsDirty(
  current: ScheduleInput,
  baseline: ScheduleInput,
) {
  return JSON.stringify(current) !== JSON.stringify(baseline);
}

export function setTargetSelected(
  targets: ScheduleTarget[],
  target: ScheduleTarget,
  selected: boolean,
) {
  const matches = (current: ScheduleTarget) =>
    current.type === target.type && current.id === target.id;
  if (!selected) return targets.filter((current) => !matches(current));
  return targets.some(matches) ? targets : [...targets, target];
}

export function conflictWinnerReason(
  winner: { priority: number; specificity: number },
  proposedPriority: number,
  t: SchedulesT,
) {
  if (winner.priority !== proposedPriority) return t("summary.reasonHighest");
  if (winner.specificity > 0) return t("summary.reasonDirect");
  return t("summary.reasonLater");
}

export function formatClock(
  value: string | undefined,
  t: SchedulesT,
  locale: string,
) {
  if (!value) return t("timing.clockNotSet");
  const [hour, minute] = value.split(":").map(Number);
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(2020, 0, 1, hour, minute));
}

export function describeWeekdays(days: number[], t: SchedulesT) {
  const ordered = scheduleWeekdays.filter((day) => days.includes(day.value));
  const weekdayValues = [1, 2, 3, 4, 5];
  if (weekdayValues.every((day) => days.includes(day)) && days.length === 5)
    return t("timing.daysSummary.weekdays");
  if (days.length === 7) return t("timing.daysSummary.everyDay");
  if (ordered.length === 1)
    return t("timing.daysSummary.single", {
      day: t(weekdayLabelKeys[ordered[0]!.value].long),
    });
  if (ordered.length === 0) return t("timing.daysSummary.none");
  return ordered.map((day) => t(weekdayLabelKeys[day.value].short)).join(", ");
}

export function describeScheduleTiming(
  input: ScheduleInput,
  t: SchedulesT,
  locale: string,
) {
  if (input.type === "one_time") {
    if (!input.oneTimeStart || !input.oneTimeEnd)
      return t("timing.summary.chooseOneTime");
    const start = new Date(input.oneTimeStart);
    const end = new Date(input.oneTimeEnd);
    return t("timing.summary.oneTimeRange", {
      start: start.toLocaleString(locale),
      end: end.toLocaleString(locale),
    });
  }
  const overnight = (input.dailyEnd ?? "") <= (input.dailyStart ?? "");
  const range = input.startDate
    ? t("timing.summary.rangeStart", {
        start: new Date(`${input.startDate}T00:00:00`).toLocaleDateString(
          locale,
        ),
      }) +
      (input.endDate
        ? t("timing.summary.rangeThrough", {
            end: new Date(`${input.endDate}T00:00:00`).toLocaleDateString(
              locale,
            ),
          })
        : "")
    : "";
  return (
    t("timing.summary.weeklyRange", {
      days: describeWeekdays(input.daysOfWeek, t),
      start: formatClock(input.dailyStart, t, locale),
      end: formatClock(input.dailyEnd, t, locale),
    }) +
    (overnight ? t("timing.summary.overnightSuffix") : "") +
    range
  );
}

export function oneTimeDuration(input: ScheduleInput, t: SchedulesT) {
  if (!input.oneTimeStart || !input.oneTimeEnd)
    return t("duration.unavailable");
  const milliseconds =
    new Date(input.oneTimeEnd).getTime() -
    new Date(input.oneTimeStart).getTime();
  if (milliseconds <= 0) return t("duration.invalidOrder");
  const minutes = Math.round(milliseconds / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remaining = minutes % 60;
  return [
    days ? t("duration.days", { count: days }) : "",
    hours ? t("duration.hours", { count: hours }) : "",
    remaining ? t("duration.minutes", { count: remaining }) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function validateScheduleInput(input: ScheduleInput, t: SchedulesT) {
  const errors: Record<string, string> = {};
  if (!input.name.trim()) errors.name = t("validation.nameRequired");
  if (!input.playlistId && !input.layoutId && !input.displayAction)
    errors.playlistId = t("validation.contentRequired");
  if (
    input.displayAction?.type === "display_set_input" &&
    !input.displayAction.input?.trim()
  )
    errors.playlistId = t("validation.inputRequired");
  if (
    input.displayAction?.type === "display_set_volume" &&
    (input.displayAction.volume == null ||
      input.displayAction.volume < 0 ||
      input.displayAction.volume > 100)
  )
    errors.playlistId = t("validation.volumeRange");
  if (
    input.displayAction?.type === "display_set_brightness" &&
    (input.displayAction.brightness == null ||
      input.displayAction.brightness < 0 ||
      input.displayAction.brightness > 100)
  )
    errors.playlistId = t("validation.brightnessRange");
  if (!input.timezone) errors.timezone = t("validation.timezoneRequired");
  if (!input.targets.length) errors.targets = t("validation.targetsRequired");
  if (input.priority < -999 || input.priority > 999)
    errors.priority = t("validation.priorityRange");
  if (input.type === "weekly") {
    if (!input.daysOfWeek.length)
      errors.daysOfWeek = t("validation.daysRequired");
    if (!input.dailyStart || !input.dailyEnd)
      errors.time = t("validation.timeRequired");
    if (input.startDate && input.endDate && input.endDate < input.startDate)
      errors.dateRange = t("validation.dateRangeInvalid");
  } else if (!input.oneTimeStart || !input.oneTimeEnd) {
    errors.oneTime = t("validation.oneTimeRequired");
  } else if (new Date(input.oneTimeEnd) <= new Date(input.oneTimeStart)) {
    errors.oneTime = t("validation.oneTimeOrder");
  }
  return errors;
}

export function countTargetScreens(
  targets: ScheduleTarget[],
  screens: Screen[],
  groups: ScreenGroup[],
) {
  const ids = new Set<string>();
  for (const target of targets) {
    if (target.type === "screen") ids.add(target.id);
    else
      for (const screen of groups.find((group) => group.id === target.id)
        ?.screens ?? [])
        ids.add(screen.id);
  }
  return (
    ids.size || targets.filter((target) => target.type === "screen").length
  );
}

export function schedulePreviewTimestamp(input: ScheduleInput) {
  if (input.type === "one_time" && input.oneTimeStart)
    return input.oneTimeStart;
  const start = input.dailyStart ?? "09:00";
  const now = new Date();
  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    if (!input.daysOfWeek.includes(candidate.getDay())) continue;
    const [hour = 9, minute = 0] = start.split(":").map(Number);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate >= now || offset > 0) return candidate.toISOString();
  }
  return now.toISOString();
}

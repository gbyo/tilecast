/**
 * Pure scheduling vocabulary shared by the Schedule editor, the Screen
 * schedule card, and plugins: weekdays, priority presets, and the wording of
 * a schedule's timing. Nothing here resolves precedence or recurrence; the
 * server is the only authority for that.
 */
import type { TFunction } from "i18next";
import type { DisplayControlAction } from "../api/types";

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

/** The stored value each named preset writes. Custom has no fixed value. */
export const priorityPresetValues = {
  normal: 0,
  important: 100,
  special: 500,
} as const;

export function priorityPreset(priority: number): PriorityPreset {
  if (priority === priorityPresetValues.normal) return "normal";
  if (priority === priorityPresetValues.important) return "important";
  if (priority === priorityPresetValues.special) return "special";
  return "custom";
}

export function priorityLabel(priority: number, t: SchedulesT) {
  const preset = priorityPreset(priority);
  if (preset === "normal") return t("priority.presets.normal");
  if (preset === "important") return t("priority.presets.important");
  if (preset === "special") return t("priority.presets.special");
  return t("priority.customValue", { priority });
}

/** Wall-clock time of day ("HH:mm") in the reader's language. */
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

/** "7:15 – 8:15 AM": one range so the meridiem is not repeated. */
export function formatClockRange(
  start: string | undefined,
  end: string | undefined,
  t: SchedulesT,
  locale: string,
) {
  if (!start || !end) return t("timing.clockNotSet");
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  const format = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  });
  const first = new Date(2020, 0, 1, startHour, startMinute);
  // An overnight window ends the next day; the range still reads start-end.
  const second = new Date(2020, 0, 1, endHour, endMinute);
  return typeof format.formatRange === "function"
    ? format.formatRange(first, second)
    : `${format.format(first)} – ${format.format(second)}`;
}

/**
 * "Mon–Fri", "Mon, Wed, Fri", "Every day". Runs of three or more consecutive
 * days collapse to a range; Sunday closes the week, as the editor shows it.
 */
export function describeDaysCompact(days: number[], t: SchedulesT) {
  const ordered = scheduleWeekdays.filter((day) => days.includes(day.value));
  if (ordered.length === 0) return t("timing.daysSummary.none");
  if (ordered.length === 7) return t("timing.daysSummary.everyDayShort");
  const runs: (typeof ordered)[number][][] = [];
  for (const day of ordered) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    const position = (value: number) => (value === 0 ? 7 : value);
    if (run && previous && position(day.value) === position(previous.value) + 1)
      run.push(day);
    else runs.push([day]);
  }
  return runs
    .map((run) => {
      const first = t(weekdayLabelKeys[run[0]!.value].short);
      if (run.length < 3) {
        return run
          .map((day) => t(weekdayLabelKeys[day.value].short))
          .join(", ");
      }
      return `${first}–${t(weekdayLabelKeys[run.at(-1)!.value].short)}`;
    })
    .join(", ");
}

/** A date or instant in the schedule's own timezone, never the browser's. */
export function formatInTimezone(
  value: string,
  timezone: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  },
) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: timezone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(date);
  }
}

function formatDateOnly(value: string, locale: string) {
  // A calendar date has no instant: format it as UTC so no timezone shifts it.
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

/**
 * "Oct 31, 2026, 7:00 PM – Nov 1, 2026, 1:00 AM" in the schedule's zone. One
 * range lets the language drop what the two ends share.
 */
export function formatRangeInTimezone(
  start: string,
  end: string,
  timezone: string,
  locale: string,
) {
  const from = new Date(start);
  const to = new Date(end);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  };
  try {
    const format = new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: timezone,
    });
    return typeof format.formatRange === "function"
      ? format.formatRange(from, to)
      : `${format.format(from)} – ${format.format(to)}`;
  } catch {
    const format = new Intl.DateTimeFormat(locale, options);
    return `${format.format(from)} – ${format.format(to)}`;
  }
}

/** The timing fields every description reads. A draft and a saved schedule both fit. */
export type ScheduleTimingFields = {
  type: "weekly" | "one_time";
  timezone: string;
  daysOfWeek: number[];
  dailyStart?: string;
  dailyEnd?: string;
  startDate?: string;
  endDate?: string;
  oneTimeStart?: string;
  oneTimeEnd?: string;
};

export type ScheduleWhenLines = {
  /** The days and times (or the event window). Absent until chosen. */
  lines: string[];
  timezone: string;
};

/**
 * What the schedule says about when it runs, as separate lines so the outcome
 * pane can stack them and the Timing section can join them. The timezone is
 * the schedule's, so a one-time event reads the same from any browser.
 */
export function describeScheduleWhen(
  input: ScheduleTimingFields,
  t: SchedulesT,
  locale: string,
): ScheduleWhenLines {
  if (input.type === "one_time") {
    if (!input.oneTimeStart || !input.oneTimeEnd)
      return { lines: [t("timing.summary.chooseOneTime")], timezone: "" };
    return {
      lines: [
        formatRangeInTimezone(
          input.oneTimeStart,
          input.oneTimeEnd,
          input.timezone,
          locale,
        ),
      ],
      timezone: input.timezone,
    };
  }
  const overnight = (input.dailyEnd ?? "") <= (input.dailyStart ?? "");
  const lines = [
    describeDaysCompact(input.daysOfWeek, t),
    formatClockRange(input.dailyStart, input.dailyEnd, t, locale) +
      (overnight ? t("timing.summary.nextDaySuffix") : ""),
  ];
  if (input.startDate && input.endDate)
    lines.push(
      t("timing.summary.rangeBetween", {
        start: formatDateOnly(input.startDate, locale),
        end: formatDateOnly(input.endDate, locale),
      }),
    );
  else if (input.startDate)
    lines.push(
      t("timing.summary.rangeFrom", {
        start: formatDateOnly(input.startDate, locale),
      }),
    );
  else if (input.endDate)
    lines.push(
      t("timing.summary.rangeUntil", {
        end: formatDateOnly(input.endDate, locale),
      }),
    );
  return { lines, timezone: input.timezone };
}

/** One quiet line: "Mon–Fri · 7:15 – 8:15 AM · America/Chicago". */
export function describeScheduleTiming(
  input: ScheduleTimingFields,
  t: SchedulesT,
  locale: string,
) {
  const { lines, timezone } = describeScheduleWhen(input, t, locale);
  return [...lines, timezone].filter(Boolean).join(" · ");
}

export function oneTimeDuration(
  input: Pick<ScheduleTimingFields, "oneTimeStart" | "oneTimeEnd">,
  t: SchedulesT,
) {
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

export const displayActionOptions: {
  value: DisplayControlAction["type"];
  labelKey:
    | "displayAction.options.powerOn"
    | "displayAction.options.powerOff"
    | "displayAction.options.setInput"
    | "displayAction.options.setVolume"
    | "displayAction.options.mute"
    | "displayAction.options.unmute"
    | "displayAction.options.setBrightness";
}[] = [
  { value: "display_power_on", labelKey: "displayAction.options.powerOn" },
  { value: "display_power_off", labelKey: "displayAction.options.powerOff" },
  { value: "display_set_input", labelKey: "displayAction.options.setInput" },
  { value: "display_set_volume", labelKey: "displayAction.options.setVolume" },
  { value: "display_mute", labelKey: "displayAction.options.mute" },
  { value: "display_unmute", labelKey: "displayAction.options.unmute" },
  {
    value: "display_set_brightness",
    labelKey: "displayAction.options.setBrightness",
  },
];

/** "Set display volume to 40": one sentence per action, shared by every surface. */
export function displayActionLabel(
  action: DisplayControlAction,
  t: SchedulesT,
) {
  const unset = t("displayAction.notSet");
  switch (action.type) {
    case "display_power_on":
      return t("displayAction.summary.powerOn");
    case "display_power_off":
      return t("displayAction.summary.powerOff");
    case "display_set_input":
      return t("displayAction.summary.setInput", {
        value: action.input?.trim() || unset,
      });
    case "display_set_volume":
      return t("displayAction.summary.setVolume", {
        value: action.volume ?? unset,
      });
    case "display_mute":
      return t("displayAction.summary.mute");
    case "display_unmute":
      return t("displayAction.summary.unmute");
    case "display_set_brightness":
      return t("displayAction.summary.setBrightness", {
        value: action.brightness ?? unset,
      });
  }
}

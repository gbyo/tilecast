import type {
  Schedule,
  ScheduleListParams,
  ScheduleTarget,
} from "../../api/types";
import {
  displayActionLabel,
  formatClock,
  scheduleWeekdayLabels,
  type SchedulesT,
} from "../../schedules/scheduleBuilderModel";

/**
 * The Schedules library's discovery controls. Three small facets live behind
 * one Filters surface and show as chips; search and sort stay visible on their
 * own and are never counted as filters. Everything here is presentation of the
 * saved rule: the server decides what a schedule does and when.
 */
export const scheduleFacetKeys = [
  "enabled",
  "type",
  "presentationType",
] as const;

export type ScheduleFacetKey = (typeof scheduleFacetKeys)[number];
export type ScheduleFacetValues = Pick<ScheduleListParams, ScheduleFacetKey>;

export const scheduleSortOptions = [
  { value: "updated", labelKey: "toolbar.sort.updated" },
  { value: "name", labelKey: "toolbar.sort.name" },
  { value: "priority", labelKey: "toolbar.sort.priority" },
] as const;

export const scheduleStatusOptions = [
  { value: "true", labelKey: "page.enabled" },
  { value: "false", labelKey: "page.disabled" },
] as const;

export const scheduleTypeOptions = [
  { value: "weekly", labelKey: "options.type.weekly" },
  { value: "one_time", labelKey: "options.type.oneTime" },
] as const;

export const schedulePresentationOptions = [
  { value: "playlist", labelKey: "options.presentation.playlist" },
  { value: "layout", labelKey: "options.presentation.layout" },
  { value: "display_control", labelKey: "options.presentation.displayControl" },
] as const;

export function scheduleFacets(
  params: ScheduleListParams,
): ScheduleFacetValues {
  return {
    enabled: params.enabled,
    type: params.type,
    presentationType: params.presentationType,
  };
}

export function activeScheduleFacetCount(values: ScheduleFacetValues) {
  return scheduleFacetKeys.filter((key) => values[key] !== "").length;
}

/** Search or any facet narrows the library. Sort only orders it. */
export function isScheduleListNarrowed(params: ScheduleListParams) {
  return (
    params.search.trim() !== "" ||
    activeScheduleFacetCount(scheduleFacets(params)) > 0
  );
}

export function schedulePath(schedule: Pick<Schedule, "id">) {
  return `/schedules/${schedule.id}`;
}

const dash = "–";

/**
 * Weekdays in Monday-first order. Runs of three or more collapse to a range
 * ("Mon–Fri"); shorter runs list their days. Seven days read as every day.
 */
export function describeWeekdaysCompact(
  days: readonly number[],
  t: SchedulesT,
) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const selected = order.filter((day) => days.includes(day));
  if (selected.length === 0) return t("timing.daysSummary.none");
  if (selected.length === 7) return t("page.timing.everyDay");
  const label = (day: number) => scheduleWeekdayLabels(day, t).short;
  const runs: number[][] = [];
  for (const day of selected) {
    const last = runs.at(-1);
    if (last && order.indexOf(day) === order.indexOf(last.at(-1)!) + 1)
      last.push(day);
    else runs.push([day]);
  }
  return runs
    .flatMap((run) =>
      run.length >= 3
        ? [`${label(run[0]!)}${dash}${label(run.at(-1)!)}`]
        : run.map(label),
    )
    .join(", ");
}

// A zone name the runtime does not know must not break the whole library.
function knownTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

function clockInstant(value: string | undefined) {
  const [hour = 0, minute = 0] = (value ?? "").split(":").map(Number);
  return new Date(Date.UTC(2020, 0, 1, hour, minute));
}

function clockRange(start: string, end: string, locale: string) {
  const format = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const from = clockInstant(start);
  const to = clockInstant(end);
  // An overnight window ends earlier on the clock than it starts, which a
  // range formatter would reject or reorder.
  return to > from
    ? format.formatRange(from, to)
    : `${format.format(from)} ${dash} ${format.format(to)}`;
}

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00Z`);
}

function dateRange(
  startDate: string | undefined,
  endDate: string | undefined,
  now: Date,
  locale: string,
  t: SchedulesT,
) {
  if (!startDate && !endDate) return "";
  const start = startDate ? dateOnly(startDate) : undefined;
  const end = endDate ? dateOnly(endDate) : undefined;
  const thisYear = now.getFullYear();
  // The year is shown only when it is not the current one, or the range spans
  // two years, so a recurring rule from last year cannot be misread.
  const showYear = [start, end].some(
    (date) => date && date.getUTCFullYear() !== thisYear,
  );
  const format = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(showYear ? { year: "numeric" as const } : {}),
    timeZone: "UTC",
  });
  if (start && end) return format.formatRange(start, end);
  if (start) return t("page.timing.from", { date: format.format(start) });
  return t("page.timing.until", { date: format.format(end) });
}

/** The calendar day an instant falls on in a zone: a comparable key and its year. */
function calendarDay(date: Date, timeZone: string | undefined) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone,
  }).formatToParts(date);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    key: `${value("year")}-${value("month")}-${value("day")}`,
    year: Number(value("year")),
  };
}

export type ScheduleWhen = {
  /** The rule itself: days and hours, or the event's date and hours. */
  summary: string;
  /** Where the rule applies: an optional date range, then the IANA zone. */
  detail: string;
};

/**
 * A short, comparable reading of when a schedule runs. It formats the saved
 * rule in the schedule's own IANA zone, never the browser's, and does not
 * decide whether the rule is active: the server stays the authority.
 */
export function scheduleWhen(
  schedule: Pick<
    Schedule,
    | "type"
    | "timezone"
    | "daysOfWeek"
    | "dailyStart"
    | "dailyEnd"
    | "startDate"
    | "endDate"
    | "oneTimeStart"
    | "oneTimeEnd"
  >,
  t: SchedulesT,
  locale: string,
  now: Date = new Date(),
): ScheduleWhen {
  const zone = knownTimeZone(schedule.timezone);
  if (schedule.type === "one_time") {
    if (!schedule.oneTimeStart || !schedule.oneTimeEnd)
      return {
        summary: t("timing.summary.chooseOneTime"),
        detail: schedule.timezone,
      };
    const start = new Date(schedule.oneTimeStart);
    const end = new Date(schedule.oneTimeEnd);
    const startDay = calendarDay(start, zone);
    const showYear = startDay.year !== now.getFullYear();
    const yearField = showYear ? { year: "numeric" as const } : {};
    if (startDay.key === calendarDay(end, zone).key) {
      const day = new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        ...yearField,
        timeZone: zone,
      }).format(start);
      const hours = new Intl.DateTimeFormat(locale, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: zone,
      }).formatRange(start, end);
      return { summary: `${day} · ${hours}`, detail: schedule.timezone };
    }
    return {
      summary: new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        ...yearField,
        hour: "numeric",
        minute: "2-digit",
        timeZone: zone,
      }).formatRange(start, end),
      detail: schedule.timezone,
    };
  }
  const start = schedule.dailyStart ?? "";
  const end = schedule.dailyEnd ?? "";
  const overnight = Boolean(start && end) && end <= start;
  const hours =
    start && end
      ? clockRange(start, end, locale)
      : formatClock(start || undefined, t, locale);
  const range = dateRange(schedule.startDate, schedule.endDate, now, locale, t);
  return {
    summary: `${describeWeekdaysCompact(schedule.daysOfWeek, t)} · ${
      overnight ? t("page.timing.overnight", { range: hours }) : hours
    }`,
    detail: range ? `${range} · ${schedule.timezone}` : schedule.timezone,
  };
}

export type SchedulePresentation = {
  kind: Schedule["presentationType"];
  label: string;
};

/** What the schedule does, in words: a name, or a localized display action. */
export function schedulePresentation(
  schedule: Pick<
    Schedule,
    "presentationType" | "playlistName" | "layoutName" | "displayAction"
  >,
  t: SchedulesT,
): SchedulePresentation {
  if (schedule.presentationType === "display_control")
    return {
      kind: "display_control",
      label: schedule.displayAction
        ? displayActionLabel(schedule.displayAction, t)
        : t("options.presentation.displayControl"),
    };
  if (schedule.presentationType === "layout")
    return {
      kind: "layout",
      label:
        schedule.layoutName ||
        schedule.playlistName ||
        t("editor.presentationLayoutFallback"),
    };
  return {
    kind: "playlist",
    label: schedule.playlistName || t("editor.presentationPlaylistFallback"),
  };
}

const visibleTargets = 2;

export type ScheduleTargetSummary = {
  /** The short text: up to two names, then a count of the rest. */
  text: string;
  /** Every target name, for a tooltip and assistive technology. */
  names: string[];
  hidden: number;
};

export function scheduleTargetSummary(
  targets: readonly ScheduleTarget[],
  t: SchedulesT,
): ScheduleTargetSummary {
  const names = targets.map(
    (target) => target.name || t("targets.unknownTarget"),
  );
  if (names.length === 0)
    return { text: t("page.noTargets"), names, hidden: 0 };
  const shown = names.slice(0, visibleTargets);
  const text = shown.join(", ");
  const hidden = names.length - shown.length;
  return {
    text:
      hidden > 0 ? t("page.targetsMore", { names: text, count: hidden }) : text,
    names,
    hidden,
  };
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/**
 * How long ago a schedule changed, in the reader's language and without any
 * translation strings of its own. Older than a week reads as a date.
 */
export function formatScheduleUpdated(
  value: string,
  now: Date,
  locale: string,
) {
  const at = new Date(value);
  const elapsed = Math.max(0, now.getTime() - at.getTime());
  const relative = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "short",
  });
  if (elapsed < minute) return relative.format(0, "second");
  if (elapsed < hour)
    return relative.format(-Math.floor(elapsed / minute), "minute");
  if (elapsed < day)
    return relative.format(-Math.floor(elapsed / hour), "hour");
  if (elapsed < 7 * day)
    return relative.format(-Math.floor(elapsed / day), "day");
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear()
      ? {}
      : { year: "numeric" as const }),
  }).format(at);
}

export type ScheduleRow = {
  schedule: Schedule;
  when: ScheduleWhen;
  presentation: SchedulePresentation;
  targets: ScheduleTargetSummary;
  updated: string;
};

/** Every derived display value, computed once per render of the loaded rows. */
export function scheduleRows(
  items: readonly Schedule[],
  t: SchedulesT,
  locale: string,
  now: Date,
): ScheduleRow[] {
  return items.map((schedule) => ({
    schedule,
    when: scheduleWhen(schedule, t, locale, now),
    presentation: schedulePresentation(schedule, t),
    targets: scheduleTargetSummary(schedule.targets, t),
    updated: formatScheduleUpdated(schedule.updatedAt, now, locale),
  }));
}

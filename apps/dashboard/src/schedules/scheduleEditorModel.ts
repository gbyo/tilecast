/**
 * The Schedule editor's draft: what an administrator is composing, how it
 * becomes a saved ScheduleInput, and what stops it from saving.
 *
 * The draft keeps both timing branches and both presentation branches so
 * switching and switching back loses nothing, but only the active branch is
 * ever sent. Whether anything changed is therefore decided on what would be
 * saved (draftToInput), so an untouched inactive branch never counts.
 *
 * Nothing here resolves recurrence or precedence. The server is the authority;
 * the editor only describes the rule and asks the server how it will behave.
 */
import type {
  DisplayControlAction,
  Schedule,
  ScheduleInput,
  ScheduleTarget,
} from "../api/types";
import { isTimezoneIdentifier } from "../settings/settingValues";
import type { SchedulesT } from "./scheduleBuilderModel";

export type PresentationMode = "content" | "display_control";
export type PresentationChoice = {
  kind: "playlist" | "layout";
  id: string;
  name: string;
};

export type ScheduleDraft = {
  name: string;
  description: string;
  enabled: boolean;
  presentationMode: PresentationMode;
  content: PresentationChoice | null;
  displayAction: DisplayControlAction;
  type: "weekly" | "one_time";
  timezone: string;
  daysOfWeek: number[];
  dailyStart: string;
  dailyEnd: string;
  /** "" when the weekly schedule has no date bound. */
  startDate: string;
  endDate: string;
  /** Instants (ISO 8601); "" until chosen. Shown in the schedule's timezone. */
  oneTimeStart: string;
  oneTimeEnd: string;
  /** NaN while the custom field holds something that is not a whole number. */
  priority: number;
  targets: ScheduleTarget[];
};

export const DEFAULT_DISPLAY_ACTION: DisplayControlAction = {
  type: "display_power_on",
};

export const SCHEDULE_NAME_MAX = 180;
export const SCHEDULE_DESCRIPTION_MAX = 2000;
export const DISPLAY_INPUT_MAX = 32;

/** A new schedule: weekdays, nine to five, normal priority, enabled. */
export function emptyDraft(timezone: string): ScheduleDraft {
  return {
    name: "",
    description: "",
    enabled: true,
    presentationMode: "content",
    content: null,
    displayAction: DEFAULT_DISPLAY_ACTION,
    type: "weekly",
    timezone,
    daysOfWeek: [1, 2, 3, 4, 5],
    dailyStart: "09:00",
    dailyEnd: "17:00",
    startDate: "",
    endDate: "",
    oneTimeStart: "",
    oneTimeEnd: "",
    priority: 0,
    targets: [],
  };
}

/**
 * The saved schedule as a draft. The detail response already names its
 * presentation, so the editor needs no library lookup to show it.
 */
export function draftFromSchedule(schedule: Schedule): ScheduleDraft {
  const base = emptyDraft(schedule.timezone);
  let content: PresentationChoice | null = null;
  if (schedule.presentationType === "layout" && schedule.layoutId)
    content = {
      kind: "layout",
      id: schedule.layoutId,
      name: schedule.layoutName ?? schedule.playlistName,
    };
  else if (schedule.presentationType === "playlist" && schedule.playlistId)
    content = {
      kind: "playlist",
      id: schedule.playlistId,
      name: schedule.playlistName,
    };
  const weekly = schedule.type === "weekly";
  return {
    ...base,
    name: schedule.name,
    description: schedule.description ?? "",
    enabled: schedule.enabled,
    presentationMode: schedule.displayAction ? "display_control" : "content",
    content,
    displayAction: schedule.displayAction ?? DEFAULT_DISPLAY_ACTION,
    type: schedule.type,
    // The server omits an empty list, and a one-time schedule has none.
    daysOfWeek:
      weekly && schedule.daysOfWeek?.length
        ? schedule.daysOfWeek
        : base.daysOfWeek,
    dailyStart: schedule.dailyStart ?? base.dailyStart,
    dailyEnd: schedule.dailyEnd ?? base.dailyEnd,
    startDate: schedule.startDate ?? "",
    endDate: schedule.endDate ?? "",
    oneTimeStart: schedule.oneTimeStart ?? "",
    oneTimeEnd: schedule.oneTimeEnd ?? "",
    priority: schedule.priority,
    targets: schedule.targets.map(({ type, id, name }) => ({ type, id, name })),
  };
}

/** Exactly what a save sends: only the active branches, targets as type and id. */
export function draftToInput(draft: ScheduleDraft): ScheduleInput {
  const common = {
    name: draft.name,
    description: draft.description,
    type: draft.type,
    timezone: draft.timezone,
    priority: draft.priority,
    enabled: draft.enabled,
    targets: draft.targets.map(({ type, id }) => ({ type, id })),
  };
  const presentation =
    draft.presentationMode === "display_control"
      ? { displayAction: normalizedAction(draft.displayAction) }
      : draft.content?.kind === "layout"
        ? { layoutId: draft.content.id }
        : draft.content
          ? { playlistId: draft.content.id }
          : {};
  const timing =
    draft.type === "weekly"
      ? {
          daysOfWeek: [...draft.daysOfWeek].sort((a, b) => a - b),
          dailyStart: draft.dailyStart,
          dailyEnd: draft.dailyEnd,
          startDate: draft.startDate || undefined,
          endDate: draft.endDate || undefined,
        }
      : {
          daysOfWeek: [],
          oneTimeStart: draft.oneTimeStart || undefined,
          oneTimeEnd: draft.oneTimeEnd || undefined,
        };
  return { ...common, ...presentation, ...timing };
}

function normalizedAction(action: DisplayControlAction): DisplayControlAction {
  switch (action.type) {
    case "display_set_input":
      return { type: action.type, input: action.input?.trim() ?? "" };
    case "display_set_volume":
      return { type: action.type, volume: action.volume };
    case "display_set_brightness":
      return { type: action.type, brightness: action.brightness };
    default:
      return { type: action.type };
  }
}

/** Whether two drafts would save the same schedule. */
export function sameDraft(a: ScheduleDraft, b: ScheduleDraft) {
  return JSON.stringify(draftToInput(a)) === JSON.stringify(draftToInput(b));
}

// ---------------------------------------------------------------------------
// Wall-clock time in a named timezone. One-time schedules store an instant,
// but an administrator thinks "7 PM in the schedule's timezone".
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/** Falls back to UTC for a name Intl rejects, so a half-typed zone never throws. */
function usableZone(timezone: string) {
  try {
    zoneFormatter(timezone);
    return timezone;
  } catch {
    return "UTC";
  }
}

function zoneFields(ms: number, timezone: string) {
  const fields: Record<string, number> = {};
  for (const part of zoneFormatter(timezone).formatToParts(new Date(ms)))
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  return fields as Record<
    "year" | "month" | "day" | "hour" | "minute" | "second",
    number
  >;
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function zoneOffset(ms: number, timezone: string) {
  const whole = Math.floor(ms / 1000) * 1000;
  const f = zoneFields(whole, timezone);
  return (
    Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - whole
  );
}

const pad = (value: number) => String(value).padStart(2, "0");

/** An instant as the "YYYY-MM-DDTHH:mm" wall time it shows in the zone. */
export function instantToWall(instant: string, timezone: string) {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return "";
  const f = zoneFields(ms, usableZone(timezone));
  return `${f.year}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}`;
}

/**
 * The instant a zone's wall time names. A time that happens twice when the
 * clocks go back takes the earlier one; a time that never happens when they
 * go forward lands an hour later, like the engine's own advance.
 */
export function wallToInstant(wall: string, timezone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!match) return "";
  const zone = usableZone(timezone);
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const local = Date.UTC(year, month - 1, day, hour, minute);
  const first = zoneOffset(local, zone);
  let guess = local - first;
  const second = zoneOffset(guess, zone);
  if (second !== first) {
    guess -= second - first;
    const third = zoneOffset(guess, zone);
    if (third !== second) guess = local - Math.min(second, third);
  }
  return new Date(guess).toISOString();
}

/** Keep the same wall-clock event when the schedule's timezone changes. */
export function withTimezone(
  draft: ScheduleDraft,
  timezone: string,
): ScheduleDraft {
  const move = (instant: string) =>
    instant
      ? wallToInstant(instantToWall(instant, draft.timezone), timezone)
      : "";
  return {
    ...draft,
    timezone,
    oneTimeStart: move(draft.oneTimeStart),
    oneTimeEnd: move(draft.oneTimeEnd),
  };
}

/** The next quarter hour in the zone, for an hour: a sensible first event. */
export function defaultOneTimeWindow(now: Date, timezone: string) {
  const wall = instantToWall(now.toISOString(), timezone);
  const [datePart, timePart] = wall.split("T") as [string, string];
  const [year, month, day] = datePart.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const [hour, minute] = timePart.split(":").map(Number) as [number, number];
  // Strictly after now, so a schedule never opens in the past.
  const rounded = (Math.floor((hour * 60 + minute) / 15) + 1) * 15;
  const date = new Date(
    Date.UTC(year, month - 1, day + Math.floor(rounded / 1440)),
  )
    .toISOString()
    .slice(0, 10);
  const minutes = rounded % 1440;
  const start = wallToInstant(
    `${date}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`,
    timezone,
  );
  return {
    start,
    end: new Date(Date.parse(start) + 60 * 60 * 1000).toISOString(),
  };
}

/** Switch weekly/one-time, starting an event window the first time only. */
export function withScheduleType(
  draft: ScheduleDraft,
  type: ScheduleDraft["type"],
  now: Date = new Date(),
): ScheduleDraft {
  if (type === draft.type) return draft;
  if (type === "one_time" && !draft.oneTimeStart) {
    const window = defaultOneTimeWindow(now, draft.timezone);
    return {
      ...draft,
      type,
      oneTimeStart: window.start,
      oneTimeEnd: window.end,
    };
  }
  return { ...draft, type };
}

/** Switch content/display control. Each branch keeps its own choice. */
export function withPresentationMode(
  draft: ScheduleDraft,
  presentationMode: PresentationMode,
): ScheduleDraft {
  return presentationMode === draft.presentationMode
    ? draft
    : { ...draft, presentationMode };
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export const targetKey = (target: Pick<ScheduleTarget, "type" | "id">) =>
  `${target.type}:${target.id}`;

/**
 * Adds a target once. The picker only offers a grouped screen through its
 * Display Group, matching how the server normalizes targets, so the draft never
 * holds a target the server would silently replace.
 */
export function withTarget(
  targets: ScheduleTarget[],
  target: ScheduleTarget,
): ScheduleTarget[] {
  return targets.some((current) => targetKey(current) === targetKey(target))
    ? targets
    : [...targets, target];
}

export function withoutTarget(
  targets: ScheduleTarget[],
  target: Pick<ScheduleTarget, "type" | "id">,
): ScheduleTarget[] {
  return targets.filter((current) => targetKey(current) !== targetKey(target));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ScheduleField =
  | "name"
  | "presentation"
  | "displayAction"
  | "days"
  | "time"
  | "dateRange"
  | "oneTime"
  | "timezone"
  | "targets"
  | "priority";

/** Document order, so the first problem is the first one a reader meets. */
export const scheduleFieldOrder: readonly ScheduleField[] = [
  "name",
  "presentation",
  "displayAction",
  "days",
  "time",
  "dateRange",
  "oneTime",
  "timezone",
  "targets",
  "priority",
];

/** The focusable control that carries each field's problem. */
export const scheduleFieldTargets: Record<ScheduleField, string> = {
  name: "schedule-name",
  presentation: "schedule-presentation-choose",
  displayAction: "schedule-display-value",
  days: "schedule-day-1",
  time: "schedule-daily-start",
  dateRange: "schedule-start-date",
  oneTime: "schedule-onetime-start",
  timezone: "schedule-timezone",
  targets: "schedule-targets-add",
  priority: "schedule-custom-priority",
};

export type ScheduleProblemCode =
  | "nameRequired"
  | "contentRequired"
  | "inputRequired"
  | "volumeRange"
  | "brightnessRange"
  | "timezoneRequired"
  | "targetsRequired"
  | "priorityRange"
  | "daysRequired"
  | "timeRequired"
  | "dateRangeInvalid"
  | "oneTimeRequired"
  | "oneTimeOrder";

export type ScheduleProblems = Partial<
  Record<ScheduleField, ScheduleProblemCode>
>;

const wholeBetween = (value: number | undefined, min: number, max: number) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;

/** What stops a save, by field. The server still has the last word. */
export function scheduleProblems(draft: ScheduleDraft): ScheduleProblems {
  const problems: ScheduleProblems = {};
  if (!draft.name.trim()) problems.name = "nameRequired";
  if (draft.presentationMode === "content") {
    if (!draft.content) problems.presentation = "contentRequired";
  } else {
    const action = draft.displayAction;
    if (action.type === "display_set_input" && !action.input?.trim())
      problems.displayAction = "inputRequired";
    else if (
      action.type === "display_set_volume" &&
      !wholeBetween(action.volume, 0, 100)
    )
      problems.displayAction = "volumeRange";
    else if (
      action.type === "display_set_brightness" &&
      !wholeBetween(action.brightness, 0, 100)
    )
      problems.displayAction = "brightnessRange";
  }
  if (draft.type === "weekly") {
    if (!draft.daysOfWeek.length) problems.days = "daysRequired";
    if (!draft.dailyStart || !draft.dailyEnd) problems.time = "timeRequired";
    if (draft.startDate && draft.endDate && draft.endDate < draft.startDate)
      problems.dateRange = "dateRangeInvalid";
  } else if (!draft.oneTimeStart || !draft.oneTimeEnd) {
    problems.oneTime = "oneTimeRequired";
  } else if (Date.parse(draft.oneTimeEnd) <= Date.parse(draft.oneTimeStart)) {
    problems.oneTime = "oneTimeOrder";
  }
  if (!draft.timezone || !isTimezoneIdentifier(draft.timezone))
    problems.timezone = "timezoneRequired";
  if (!draft.targets.length) problems.targets = "targetsRequired";
  if (!wholeBetween(draft.priority, -999, 999))
    problems.priority = "priorityRange";
  return problems;
}

export function problemMessage(code: ScheduleProblemCode, t: SchedulesT) {
  return t(`validation.${code}`);
}

export function firstProblem(problems: ScheduleProblems) {
  return scheduleFieldOrder.find((field) => problems[field] !== undefined);
}

/**
 * The scheduling-relevant draft as the server's preflight reads it, or null
 * while the draft is too incomplete to check. The name and description do not
 * change what plays, so they are left out and never trigger a new check.
 */
export function preflightBody(draft: ScheduleDraft): ScheduleInput | null {
  const problems = scheduleProblems(draft);
  delete problems.name;
  if (Object.keys(problems).length) return null;
  return { ...draftToInput(draft), name: "", description: "" };
}

/** A stable identity for the preflight's inputs: equal drafts share one check. */
export function preflightSignature(draft: ScheduleDraft) {
  const body = preflightBody(draft);
  return body ? JSON.stringify(body) : null;
}

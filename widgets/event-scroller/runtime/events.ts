import {
  empty,
  failure,
  firstRecordsDataset,
  parseHexColor,
  ready,
  type ConfigResult,
  type WidgetContext,
  type WidgetField,
  type WidgetResources,
  type WidgetResolution,
  type WidgetValue,
} from "@tilecast/widget-sdk";
import {
  boundText,
  fieldRef,
  fieldsByKey,
  localDayKey,
  optionalBoolean,
} from "@tilecast/widget-kit";

export interface EventScrollerConfig {
  readonly dataSourceId: string;
  readonly titleField: string;
  readonly startField: string;
  readonly endField: string;
  readonly locationField: string;
  readonly categoryField: string;
  readonly heading: string;
  readonly emptyText: string;
  readonly maximumItems: number;
  readonly hideEnded: boolean;
  readonly showWeekday: boolean;
  readonly showDate: boolean;
  readonly showTime: boolean;
  readonly showLocation: boolean;
  readonly showCategory: boolean;
  readonly showDividers: boolean;
  readonly scrolling: boolean;
  readonly flow: "auto" | "vertical" | "horizontal";
  readonly verticalDirection: "up" | "down";
  readonly horizontalDirection: "left" | "right";
  readonly scrollSpeed: number;
  readonly density: "compact" | "comfortable" | "spacious";
  readonly rowLayout: "fill" | "natural";
  readonly textScale: number;
  readonly headingScale: number;
  readonly rowSpacing: number;
  readonly contentPadding: number;
  readonly headingSpacing: number;
  readonly dateStyle: "short" | "day" | "numeric";
  readonly background: string | null;
  readonly foreground: string | null;
  readonly accent: string | null;
}

export function parseEventScrollerConfig(
  value: unknown,
): ConfigResult<EventScrollerConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const mappings = {} as Record<
    | "dataSourceId"
    | "titleField"
    | "startField"
    | "endField"
    | "locationField"
    | "categoryField",
    string
  >;
  for (const key of [
    "dataSourceId",
    "titleField",
    "startField",
    "endField",
    "locationField",
    "categoryField",
  ] as const) {
    const field = fieldRef(raw[key], key === "dataSourceId" ? 200 : 120);
    if (field === null)
      return { ok: false, problem: `${key} must be a field reference` };
    mappings[key] = field;
  }
  const choices = {
    flow: ["auto", "vertical", "horizontal"],
    verticalDirection: ["up", "down"],
    horizontalDirection: ["left", "right"],
    density: ["comfortable", "compact", "spacious"],
    rowLayout: ["fill", "natural"],
    dateStyle: ["short", "day", "numeric"],
  } as const;
  const selected: Record<string, string> = {};
  for (const [key, options] of Object.entries(choices)) {
    const choice = raw[key] ?? options[0];
    if (
      typeof choice !== "string" ||
      !(options as readonly string[]).includes(choice)
    ) {
      return { ok: false, problem: `${key} is not a supported choice` };
    }
    selected[key] = choice;
  }
  const flags = {} as Record<
    | "hideEnded"
    | "showWeekday"
    | "showDate"
    | "showTime"
    | "showLocation"
    | "showCategory"
    | "showDividers"
    | "scrolling",
    boolean
  >;
  for (const key of [
    "hideEnded",
    "showWeekday",
    "showDate",
    "showTime",
    "showLocation",
    "showCategory",
    "showDividers",
    "scrolling",
  ] as const) {
    const flag = optionalBoolean(raw[key], key !== "showCategory");
    if (flag === null)
      return { ok: false, problem: `${key} must be a boolean` };
    flags[key] = flag;
  }
  const maximumItems = raw["maximumItems"] ?? 20;
  const scrollSpeed = raw["scrollSpeed"] ?? 3;
  const sizing = {} as Record<
    | "textScale"
    | "headingScale"
    | "rowSpacing"
    | "contentPadding"
    | "headingSpacing",
    number
  >;
  for (const [key, minimum, maximum] of [
    ["textScale", 50, 300],
    ["headingScale", 50, 200],
    ["rowSpacing", 0, 200],
    ["contentPadding", 0, 200],
    ["headingSpacing", 0, 200],
  ] as const) {
    const amount = raw[key] ?? 100;
    if (
      !Number.isInteger(amount) ||
      typeof amount !== "number" ||
      amount < minimum ||
      amount > maximum
    ) {
      return {
        ok: false,
        problem: `${key} must be an integer from ${minimum} to ${maximum}`,
      };
    }
    sizing[key] = amount;
  }
  if (
    typeof maximumItems !== "number" ||
    !Number.isInteger(maximumItems) ||
    maximumItems < 1 ||
    maximumItems > 100
  ) {
    return {
      ok: false,
      problem: "maximumItems must be an integer from 1 to 100",
    };
  }
  if (
    typeof scrollSpeed !== "number" ||
    !Number.isFinite(scrollSpeed) ||
    scrollSpeed < 1 ||
    scrollSpeed > 10
  ) {
    return { ok: false, problem: "scrollSpeed must be from 1 to 10" };
  }
  return {
    ok: true,
    config: {
      ...mappings,
      ...flags,
      ...sizing,
      ...(selected as Pick<EventScrollerConfig, keyof typeof choices>),
      heading: boundText(raw["heading"] ?? "", 120),
      emptyText: boundText(raw["emptyText"] ?? "", 200),
      maximumItems,
      scrollSpeed,
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
      accent: parseHexColor(raw["accent"]),
    },
  };
}

interface EventTime {
  /** Bare dates keep their calendar identity; datetime values name instants. */
  readonly day: string | null;
  readonly ms: number;
}

function eventTime(value: WidgetValue | undefined): EventTime | null {
  if (typeof value?.datetime === "string") {
    const ms = Date.parse(value.datetime);
    return Number.isFinite(ms) ? { ms, day: null } : null;
  }
  if (
    typeof value?.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.date)
  )
    return null;
  const ms = Date.parse(`${value.date}T00:00:00Z`);
  return Number.isFinite(ms) &&
    new Date(ms).toISOString().slice(0, 10) === value.date
    ? { ms, day: value.date }
    : null;
}

export interface ScrollerEvent {
  readonly id: string;
  readonly values: Readonly<Record<string, WidgetValue>>;
  readonly start: EventTime;
  readonly end: EventTime | null;
}
export interface EventScrollerData {
  readonly events: readonly ScrollerEvent[];
  readonly fields: Readonly<Record<string, WidgetField>>;
}

export function resolveEventScrollerData(
  config: EventScrollerConfig,
  resources: WidgetResources,
): WidgetResolution<EventScrollerData> {
  const document = config.dataSourceId
    ? resources.dataDocument(config.dataSourceId)
    : null;
  if (!document) return empty("no_source");
  const dataset = firstRecordsDataset(document);
  if (!dataset) return failure("incompatible_source");
  const events: ScrollerEvent[] = [];
  for (const record of dataset.records ?? []) {
    const title = record.values[config.titleField];
    const start = eventTime(record.values[config.startField]);
    if (!start || typeof title?.text !== "string" || !title.text.trim())
      continue;
    events.push({
      id: record.id,
      values: record.values,
      start,
      end: eventTime(record.values[config.endField]),
    });
  }
  // Keep all usable events: time-dependent filtering and the cap belong together.
  return events.length
    ? ready({ events, fields: fieldsByKey(dataset) })
    : empty("no_records");
}

/** Resolve a bare date to its first local instant, including DST midnight shifts. */
function startInstant(time: EventTime, timeZone: string): number {
  if (time.day === null) return time.ms;
  let before = time.ms - 36 * 3_600_000;
  let after = time.ms + 36 * 3_600_000;
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);
    if (localDayKey(middle, timeZone) >= time.day) after = middle;
    else before = middle;
  }
  return after;
}

export function visibleScrollerEvents(
  data: EventScrollerData,
  config: EventScrollerConfig,
  now: number,
  timeZone: string,
): readonly ScrollerEvent[] {
  const today = localDayKey(now, timeZone);
  return data.events
    .filter((event) => {
      if (!config.hideEnded) return true;
      if (event.end) {
        // Generic date-only ends include that date. ICS sources give exclusive datetime ends.
        return event.end.day !== null
          ? event.end.day >= today
          : event.end.ms > now;
      }
      return (
        (event.start.day ?? localDayKey(event.start.ms, timeZone)) >= today
      );
    })
    .map((event, index) => ({
      event,
      index,
      at: startInstant(event.start, timeZone),
    }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .slice(0, config.maximumItems)
    .map(({ event }) => event);
}

/** Reading pace, not measured pixels: at least one calm viewport traversal. */
export function scrollDurationSeconds(
  eventCount: number,
  speed: number,
): number {
  const count = Number.isFinite(eventCount)
    ? Math.min(100, Math.max(1, Math.floor(eventCount)))
    : 1;
  const pace = Number.isFinite(speed) ? Math.min(10, Math.max(1, speed)) : 3;
  return Math.max(6, count) * (14 - pace);
}

export function scrollerDate(
  event: ScrollerEvent,
  config: EventScrollerConfig,
  context: Pick<WidgetContext, "locale" | "timeZone">,
): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: event.start.day !== null ? "UTC" : context.timeZone,
    ...(config.showWeekday ? { weekday: "short" } : {}),
    ...(config.showDate
      ? {
          day: "numeric",
          ...(config.dateStyle === "day"
            ? {}
            : { month: config.dateStyle === "numeric" ? "numeric" : "short" }),
        }
      : {}),
  };
  if (!config.showWeekday && !config.showDate) return "";
  try {
    return new Intl.DateTimeFormat(context.locale, options).format(
      event.start.ms,
    );
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: "UTC",
    }).format(event.start.ms);
  }
}

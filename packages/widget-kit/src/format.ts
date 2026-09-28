/**
 * Formatting helpers for display. Everything is locale- and time-zone
 * explicit (from the Widget context or configuration), and Intl formatters
 * are cached because constructing one costs far more than formatting.
 */

import type { WidgetField, WidgetValue } from "@tilecast/widget-sdk";

const CACHE_LIMIT = 64;
const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>();

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat>(
  key: string,
  create: () => T,
): T {
  const hit = cache.get(key);
  if (hit) return hit as T;
  if (cache.size >= CACHE_LIMIT) cache.clear();
  const made = create();
  cache.set(key, made);
  return made;
}

function dateFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  return cached(`d|${locale}|${JSON.stringify(options)}`, () => {
    try {
      return new Intl.DateTimeFormat(locale, options);
    } catch {
      return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
    }
  });
}

/** "locale" follows the locale's convention; "h12"/"h23" force one. */
export type HourCycle = "locale" | "h12" | "h23";

export interface TimeParts {
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
  /** Localized AM/PM marker, or "" for a 24-hour presentation. */
  readonly dayPeriod: string;
  /** The locale's hour/minute separator, usually ":". */
  readonly separator: string;
  /** Hours (0–23), minutes and seconds in the zone, for analog faces. */
  readonly clock: { hours: number; minutes: number; seconds: number };
}

export function timeParts(
  epochMs: number,
  options: { locale: string; timeZone: string; hourCycle: HourCycle },
): TimeParts {
  const cycle =
    options.hourCycle === "locale" ? {} : { hourCycle: options.hourCycle };
  const parts = dateFormat(options.locale, {
    timeZone: options.timeZone,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    ...cycle,
  }).formatToParts(epochMs);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const separatorIndex = parts.findIndex((part) => part.type === "hour") + 1;
  const separator =
    parts[separatorIndex]?.type === "literal"
      ? parts[separatorIndex]!.value.trim() || ":"
      : ":";
  const numeric = dateFormat("en-US", {
    timeZone: options.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(epochMs);
  const number = (type: Intl.DateTimeFormatPartTypes) =>
    Number(numeric.find((part) => part.type === type)?.value ?? 0);
  return {
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
    dayPeriod: pick("dayPeriod"),
    separator,
    clock: {
      // Some engines write midnight as "24" in the h23 cycle.
      hours: number("hour") % 24,
      minutes: number("minute"),
      seconds: number("second"),
    },
  };
}

export type DateStyle =
  | "full"
  | "long"
  | "medium"
  | "weekday"
  | "day-month"
  | "year"
  | "medium-year"
  | "numeric";

const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  full: { weekday: "long", month: "long", day: "numeric", year: "numeric" },
  long: { weekday: "long", month: "long", day: "numeric" },
  medium: { weekday: "short", month: "short", day: "numeric" },
  weekday: { weekday: "long" },
  "day-month": { month: "long", day: "numeric" },
  year: { year: "numeric" },
  "medium-year": { month: "short", day: "numeric", year: "numeric" },
  numeric: { month: "numeric", day: "numeric", year: "2-digit" },
};

export function formatDate(
  epochMs: number,
  options: { locale: string; timeZone: string; style: DateStyle },
): string {
  return dateFormat(options.locale, {
    timeZone: options.timeZone,
    ...DATE_OPTIONS[options.style],
  }).format(epochMs);
}

/**
 * The local wall time of one instant ("2:30 PM"), for agenda rows and
 * other places where the date already has its own label. Like every
 * display format it is locale- and time-zone explicit.
 */
export function formatTime(
  epochMs: number,
  options: { locale: string; timeZone: string; hourCycle: HourCycle },
): string {
  return dateFormat(options.locale, {
    timeZone: options.timeZone,
    hour: "numeric",
    minute: "2-digit",
    ...(options.hourCycle === "locale" ? {} : { hourCycle: options.hourCycle }),
  }).format(epochMs);
}

/** A key that changes exactly when the local calendar day changes. */
export function localDayKey(epochMs: number, timeZone: string): string {
  return dateFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(epochMs);
}

/**
 * Whole local calendar days from `referenceZone`'s date to `timeZone`'s
 * date at one instant: 1 when the other zone is already on the next day.
 */
export function localDayDifference(
  epochMs: number,
  timeZone: string,
  referenceZone: string,
): number {
  const day = (zone: string) =>
    Date.parse(`${localDayKey(epochMs, zone)}T00:00:00Z`);
  return Math.round((day(timeZone) - day(referenceZone)) / 86_400_000);
}

/**
 * A relative day in the screen locale ("tomorrow", "yesterday",
 * "mañana"), or "" for the same day. Never a hard-coded English word.
 */
export function relativeDayLabel(days: number, locale: string): string {
  if (days === 0 || !Number.isFinite(days)) return "";
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
      days,
      "day",
    );
  } catch {
    return new Intl.RelativeTimeFormat("en-US", { numeric: "auto" }).format(
      days,
      "day",
    );
  }
}

/** "America/New_York" → "New York"; "Etc/UTC" → "UTC". */
export function zoneCity(timeZone: string): string {
  const last = timeZone.split("/").pop() ?? timeZone;
  return last.replace(/_/g, " ");
}

/** The zone's short name at an instant, for example "CDT" or "GMT+2". */
export function zoneAbbreviation(
  epochMs: number,
  options: { locale: string; timeZone: string },
): string {
  return (
    dateFormat(options.locale, {
      timeZone: options.timeZone,
      timeZoneName: "short",
    })
      .formatToParts(epochMs)
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  );
}

export interface NumberOptions {
  locale: string;
  style?: "decimal" | "percent" | "currency";
  currency?: string;
  maximumFractionDigits?: number;
  compact?: boolean;
}

export function formatNumber(value: number, options: NumberOptions): string {
  if (!Number.isFinite(value)) return "—";
  // Percent values arrive as whole units (62 means 62%), matching the
  // record convention the legacy renderer already uses; Intl formats
  // fractions, so the conversion happens here, once, for every Widget.
  if (options.style === "percent") value /= 100;
  const format = cached(
    `n|${options.locale}|${JSON.stringify(options)}`,
    () => {
      const intl: Intl.NumberFormatOptions = {
        style: options.style ?? "decimal",
        notation: options.compact ? "compact" : "standard",
      };
      // Currencies keep their own minor units unless a Widget overrides them.
      if (options.maximumFractionDigits !== undefined) {
        intl.maximumFractionDigits = options.maximumFractionDigits;
        intl.minimumFractionDigits = Math.min(
          intl.minimumFractionDigits ?? 0,
          options.maximumFractionDigits,
        );
      } else if (options.style !== "currency") {
        intl.maximumFractionDigits = 1;
      }
      if (options.style === "currency") {
        intl.currency = /^[A-Z]{3}$/.test(options.currency ?? "")
          ? options.currency
          : "USD";
      }
      try {
        return new Intl.NumberFormat(options.locale, intl);
      } catch {
        return new Intl.NumberFormat("en-US", intl);
      }
    },
  );
  return format.format(value);
}

/**
 * Render one prepared Data Document value as display text, following the
 * field's typed metadata and the Widget locale. Raw format strings are
 * never exposed: numbers, currencies, dates and durations format through
 * Intl, and every string is bounded as untrusted display data.
 */
export interface DisplayValueOptions {
  readonly locale: string;
  readonly timeZone?: string;
  /** Per-value display bound; defaults to 280 characters. */
  readonly maximum?: number;
}

export function formatWidgetValue(
  value: WidgetValue | null | undefined,
  field: Pick<WidgetField, "type" | "currency"> | undefined,
  options: DisplayValueOptions,
): string {
  const maximum = options.maximum ?? 280;
  if (!value) return "";
  if (typeof value.text === "string") return boundText(value.text, maximum);
  if (typeof value.url === "string") return boundText(value.url, maximum);
  const numeric =
    typeof value.number === "number"
      ? value.number
      : typeof value.integer === "number"
        ? value.integer
        : null;
  if (numeric !== null) {
    const currency = field?.type === "currency" ? field.currency : undefined;
    return formatNumber(numeric, {
      locale: options.locale,
      style:
        field?.type === "percent"
          ? "percent"
          : currency
            ? "currency"
            : "decimal",
      currency,
    });
  }
  if (typeof value.boolean === "boolean") return value.boolean ? "Yes" : "No";
  if (typeof value.date === "string" || typeof value.datetime === "string") {
    const at = Date.parse(value.datetime ?? value.date ?? "");
    if (Number.isNaN(at)) return "";
    // A bare date names no zone, so it formats in UTC; otherwise screens
    // west of Greenwich would show the previous day.
    const timeZone = value.datetime !== undefined ? options.timeZone : "UTC";
    return dateFormat(options.locale, {
      dateStyle: "medium",
      ...(value.datetime !== undefined && { timeStyle: "short" }),
      ...(timeZone !== undefined && { timeZone }),
    }).format(at);
  }
  if (typeof value.durationSeconds === "number") {
    const total = Math.max(0, Math.floor(value.durationSeconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${total % 60}s`;
  }
  return "";
}

/** Truncate untrusted display text to a bound, on a code-point boundary. */
export function boundText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  const points = Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " "));
  return points.length > maximum
    ? `${points
        .slice(0, maximum - 1)
        .join("")
        .trimEnd()}…`
    : points.join("");
}

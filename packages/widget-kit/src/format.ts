/**
 * Formatting helpers for display. Everything is locale- and time-zone
 * explicit (from the Widget context or configuration), and Intl formatters
 * are cached because constructing one costs far more than formatting.
 */

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
    Number(numeric.find((part) => part.type === type)?.value ?? 0) % 24;
  return {
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
    dayPeriod: pick("dayPeriod"),
    separator,
    clock: {
      hours: number("hour"),
      minutes: number("minute"),
      seconds: number("second"),
    },
  };
}

export type DateStyle = "full" | "long" | "medium" | "weekday" | "day-month";

const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  full: { weekday: "long", month: "long", day: "numeric", year: "numeric" },
  long: { weekday: "long", month: "long", day: "numeric" },
  medium: { weekday: "short", month: "short", day: "numeric" },
  weekday: { weekday: "long" },
  "day-month": { month: "long", day: "numeric" },
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

/** A key that changes exactly when the local calendar day changes. */
export function localDayKey(epochMs: number, timeZone: string): string {
  return dateFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(epochMs);
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

/**
 * Typed value formatting.
 *
 * Shared by widgets, layout bindings, and declarative presentation so a
 * number/currency/percent/date renders identically wherever it appears —
 * matching the Android formatters. Locale is fixed to en-US to keep output
 * deterministic and testable; timezone is explicit where dates are involved.
 */

export type ValueFormat =
  | "text"
  | "number"
  | "integer"
  | "percent"
  | "currency"
  | "boolean"
  | "date"
  | "datetime"
  | "time"
  | "date-short"
  | "date-long"
  | "url"
  | "duration";

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n =
    typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function formatNumber(n: number, precision: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

function formatDateValue(
  value: string,
  timezone: string,
  style: "short" | "long" | "datetime" | "time",
): string {
  // ECMAScript parses YYYY-MM-DD as midnight UTC. Formatting that instant in a
  // timezone west of UTC can move a calendar-only value to the previous day, so
  // recognize date-only input before Date.parse and keep it timezone-neutral.
  const trimmed = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return value;
    }
    return formatInstant(date, "UTC", style);
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return formatInstant(new Date(parsed), timezone, style);
}

function formatInstant(
  date: Date,
  timezone: string,
  style: "short" | "long" | "datetime" | "time",
): string {
  const opts: Intl.DateTimeFormatOptions =
    style === "short"
      ? { month: "short", day: "numeric" }
      : style === "long"
        ? { weekday: "long", month: "long", day: "numeric", year: "numeric" }
        : style === "time"
          ? { hour: "numeric", minute: "2-digit" }
          : {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            };
  try {
    return new Intl.DateTimeFormat("en-US", {
      ...opts,
      timeZone: timezone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", opts).format(date);
  }
}

export interface FormatOptions {
  format: ValueFormat | string;
  precision?: number | null;
  prefix?: string;
  suffix?: string;
  timezone?: string;
}

/** Format a raw value (string or number) per the requested typed format. */
export function formatValue(
  raw: string | number | boolean | null | undefined,
  options: FormatOptions,
): string {
  const precision = options.precision ?? 0;
  const timezone = options.timezone ?? "UTC";
  let body: string;

  switch (options.format) {
    case "number":
    case "integer": {
      const n = toNumber(raw as string);
      body =
        n === null
          ? ""
          : formatNumber(n, options.format === "integer" ? 0 : precision);
      break;
    }
    case "percent": {
      const n = toNumber(raw as string);
      body = n === null ? "" : `${formatNumber(n, precision)}%`;
      break;
    }
    case "currency": {
      const n = toNumber(raw as string);
      body =
        n === null
          ? ""
          : n.toLocaleString("en-US", {
              style: "currency",
              currency: "USD",
              minimumFractionDigits: precision,
              maximumFractionDigits: precision,
            });
      break;
    }
    case "boolean":
      body =
        raw === true || raw === "true" || raw === "1"
          ? "Yes"
          : raw === false || raw === "false" || raw === "0" || raw === ""
            ? "No"
            : String(raw);
      break;
    case "date":
    case "date-short":
      body = raw ? formatDateValue(String(raw), timezone, "short") : "";
      break;
    case "date-long":
      body = raw ? formatDateValue(String(raw), timezone, "long") : "";
      break;
    case "datetime":
      body = raw ? formatDateValue(String(raw), timezone, "datetime") : "";
      break;
    case "time":
      body = raw ? formatDateValue(String(raw), timezone, "time") : "";
      break;
    case "duration": {
      const secs = toNumber(raw as string);
      body = secs === null ? "" : formatDuration(secs);
      break;
    }
    case "url":
    case "text":
    default:
      body = raw === null || raw === undefined ? "" : String(raw);
      break;
  }

  if (body === "") {
    return "";
  }
  return `${options.prefix ?? ""}${body}${options.suffix ?? ""}`;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const seconds = s % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  // Seconds only matter at fine granularity; a multi-hour countdown ticking
  // its seconds field is visual noise on signage.
  if (seconds > 0 && days === 0 && hours === 0) parts.push(`${seconds}s`);
  return parts.length > 0 ? parts.join(" ") : "0s";
}

const HEX_COLOR = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

/** Return the color if valid, else the fallback — never emit invalid CSS. */
export function safeColor(value: string | undefined, fallback: string): string {
  return value && HEX_COLOR.test(value) ? value : fallback;
}

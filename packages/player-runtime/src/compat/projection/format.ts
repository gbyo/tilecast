/**
 * Typed value formatting.
 *
 * Shared by widgets, layout bindings, and declarative presentation so a
 * number/currency/percent/date renders identically wherever it appears —
 * matching the Android formatters. New Servers provide the organization's
 * regional profile; the legacy profile is used only when an older Server
 * omits it.
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
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

export interface RegionalFormatting {
  locale: string;
  timezone: string;
  dateFormat: "locale" | "yyyy-MM-dd" | "MM/dd/yyyy" | "dd/MM/yyyy";
  timeFormat: "locale" | "12-hour" | "24-hour";
  firstDayOfWeek:
    | "sunday"
    | "monday"
    | "tuesday"
    | "wednesday"
    | "thursday"
    | "friday"
    | "saturday";
}

const LEGACY_REGIONAL_FORMAT: RegionalFormatting = {
  // player-config-v1's original Linux formatter was fixed to en-US. Retain
  // that output only for old Servers that cannot provide an organization
  // profile; do not derive signage formatting from the host locale.
  locale: "en-US",
  timezone: "UTC",
  dateFormat: "locale",
  timeFormat: "locale",
  firstDayOfWeek: "monday",
};

export function resolveRegionalFormatting(value: unknown): RegionalFormatting {
  if (!value || typeof value !== "object") return LEGACY_REGIONAL_FORMAT;
  const candidate = value as Partial<RegionalFormatting>;
  try {
    const locale = Intl.getCanonicalLocales(candidate.locale ?? "")[0];
    const timezone = candidate.timezone ?? "";
    new Intl.DateTimeFormat(locale, { timeZone: timezone });
    if (
      !locale ||
      !["locale", "yyyy-MM-dd", "MM/dd/yyyy", "dd/MM/yyyy"].includes(
        candidate.dateFormat ?? "",
      ) ||
      !["locale", "12-hour", "24-hour"].includes(candidate.timeFormat ?? "") ||
      ![
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ].includes(candidate.firstDayOfWeek ?? "")
    ) {
      return LEGACY_REGIONAL_FORMAT;
    }
    return candidate as RegionalFormatting;
  } catch {
    return LEGACY_REGIONAL_FORMAT;
  }
}

function formatNumber(n: number, locale: string, precision: number): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(n);
}

function formatDateValue(
  value: string,
  regional: RegionalFormatting,
  timezone: string,
  style: "locale" | "short" | "long" | "datetime" | "time",
): string {
  // Keep date-only values as calendar dates instead of letting Date.parse
  // reinterpret them in the host timezone. Other human dates stay unchanged;
  // only ISO/RFC 3339 instants are parsed here.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (dateOnly) {
    const d = new Date(
      Date.UTC(
        Number(dateOnly[1]),
        Number(dateOnly[2]) - 1,
        Number(dateOnly[3]),
      ),
    );
    return formatInstant(d, regional, "UTC", style);
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value.trim())) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? formatInstant(new Date(parsed), regional, timezone, style)
    : value;
}

function formatInstant(
  date: Date,
  regional: RegionalFormatting,
  timezone: string,
  style: "locale" | "short" | "long" | "datetime" | "time",
): string {
  const explicitDateFormat =
    regional.dateFormat !== "locale" &&
    (style === "locale" || style === "datetime");
  const dateOptions: Intl.DateTimeFormatOptions = explicitDateFormat
    ? { year: "numeric", month: "2-digit", day: "2-digit" }
    : style === "short" || style === "locale"
      ? { dateStyle: "short" }
      : style === "long"
        ? { dateStyle: "full" }
        : style === "datetime"
          ? { dateStyle: "medium" }
          : {};
  const timeOptions: Intl.DateTimeFormatOptions =
    style === "time" || style === "datetime"
      ? {
          timeStyle: "short",
          ...(regional.timeFormat === "locale"
            ? {}
            : { hour12: regional.timeFormat === "12-hour" }),
        }
      : {};
  if (explicitDateFormat) {
    const parts = new Intl.DateTimeFormat(regional.locale, {
      ...dateOptions,
      timeZone: timezone,
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    if (regional.dateFormat === "yyyy-MM-dd") {
      return [get("year"), get("month"), get("day")].join("-");
    }
    const ordered =
      regional.dateFormat === "MM/dd/yyyy"
        ? [get("month"), get("day"), get("year")]
        : [get("day"), get("month"), get("year")];
    const formattedDate = ordered.join("/");
    if (style === "datetime") {
      return `${formattedDate}, ${new Intl.DateTimeFormat(regional.locale, {
        ...timeOptions,
        timeZone: timezone,
      }).format(date)}`;
    }
    return formattedDate;
  }
  const opts: Intl.DateTimeFormatOptions = { ...dateOptions, ...timeOptions };
  try {
    return new Intl.DateTimeFormat(regional.locale, {
      ...opts,
      timeZone: timezone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(regional.locale, opts).format(date);
  }
}

export interface FormatOptions {
  format: ValueFormat | string;
  precision?: number | null;
  prefix?: string;
  suffix?: string;
  timezone?: string;
  locale?: string;
  currency?: string;
  regionalFormat?: RegionalFormatting | null;
}

/** Format a raw value (string or number) per the requested typed format. */
export function formatValue(
  raw: string | number | boolean | null | undefined,
  options: FormatOptions,
): string {
  const regional = options.regionalFormat ?? LEGACY_REGIONAL_FORMAT;
  const locale = options.locale ?? regional.locale;
  const precision = options.precision ?? 0;
  const timezone = options.timezone ?? regional.timezone;
  let body: string;

  switch (options.format) {
    case "number":
    case "integer": {
      const n = toNumber(raw as string);
      body =
        n === null
          ? ""
          : formatNumber(
              n,
              locale,
              options.format === "integer" ? 0 : precision,
            );
      break;
    }
    case "percent": {
      const n = toNumber(raw as string);
      body =
        n === null
          ? ""
          : new Intl.NumberFormat(locale, {
              style: "percent",
              minimumFractionDigits: precision,
              maximumFractionDigits: precision,
            }).format(n / 100);
      break;
    }
    case "currency": {
      const n = toNumber(raw as string);
      if (n === null) {
        body = "";
        break;
      }
      if (!options.currency) {
        // Legacy currency-typed values without semantic currency metadata are
        // shown as localized numbers rather than mislabeled as any currency.
        const numberOptions: Intl.NumberFormatOptions = {};
        if (options.precision != null) {
          numberOptions.minimumFractionDigits = precision;
          numberOptions.maximumFractionDigits = precision;
        }
        body = new Intl.NumberFormat(locale, numberOptions).format(n);
        break;
      }
      try {
        const currencyOptions: Intl.NumberFormatOptions = {
          style: "currency",
          currency: options.currency.toUpperCase(),
        };
        if (options.precision != null) {
          currencyOptions.minimumFractionDigits = precision;
          currencyOptions.maximumFractionDigits = precision;
        }
        body = new Intl.NumberFormat(locale, currencyOptions).format(n);
      } catch {
        body = new Intl.NumberFormat(locale, {
          minimumFractionDigits: precision,
          maximumFractionDigits: precision,
        }).format(n);
      }
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
      body = raw
        ? formatDateValue(String(raw), regional, timezone, "locale")
        : "";
      break;
    case "date-short":
      body = raw
        ? formatDateValue(String(raw), regional, timezone, "short")
        : "";
      break;
    case "date-long":
      body = raw
        ? formatDateValue(String(raw), regional, timezone, "long")
        : "";
      break;
    case "datetime":
      body = raw
        ? formatDateValue(String(raw), regional, timezone, "datetime")
        : "";
      break;
    case "time":
      body = raw
        ? formatDateValue(String(raw), regional, timezone, "time")
        : "";
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

import type { OrganizationRegionalProfile } from "./regionalProfile";

export type RegionalDateTimeKind =
  "date" | "date-short" | "date-long" | "datetime" | "time";

type ParsedDateTime = {
  date: Date;
  dateOnly: boolean;
};

export function parseISODateTime(value: string): ParsedDateTime | undefined {
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]);
    const day = Number(dateOnlyMatch[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return { date, dateOnly: true };
    }
    return undefined;
  }

  // Parse only ISO date-times. Date.parse is never used as a locale parser for
  // human-entered slash dates or named-month strings.
  const dateTimeMatch =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|([+-])(\d{2}):(\d{2}))?$/i.exec(
      value.trim(),
    );
  if (!dateTimeMatch) return undefined;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = dateTimeMatch;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? 0);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    Number(offsetHourText ?? 0) > 23 ||
    Number(offsetMinuteText ?? 0) > 59
  )
    return undefined;
  const iso = value.trim().replace(" ", "T");
  const withZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(iso) ? iso : `${iso}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? undefined : { date, dateOnly: false };
}

function explicitDateParts(
  date: Date,
  locale: string,
  timezone: string,
): Record<Intl.DateTimeFormatPartTypes, string> {
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  ) as Record<Intl.DateTimeFormatPartTypes, string>;
}

function formatDate(
  date: Date,
  kind: RegionalDateTimeKind,
  profile: OrganizationRegionalProfile,
  timezone: string,
): string {
  const locale = profile.locale ?? "en-US";
  const explicitFormat =
    (kind === "date" || kind === "datetime") &&
    profile.dateFormat &&
    profile.dateFormat !== "locale"
      ? profile.dateFormat
      : undefined;
  if (explicitFormat) {
    const parts = explicitDateParts(date, locale, timezone);
    if (explicitFormat === "yyyy-MM-dd") {
      return [parts.year, parts.month, parts.day].join("-");
    }
    const order =
      explicitFormat === "MM/dd/yyyy"
        ? [parts.month, parts.day, parts.year]
        : [parts.day, parts.month, parts.year];
    return order.join("/");
  }
  const dateStyle =
    kind === "date-long" ? "long" : kind === "datetime" ? "medium" : "short";
  return new Intl.DateTimeFormat(locale, {
    dateStyle,
    timeZone: timezone,
  }).format(date);
}

function formatTime(
  date: Date,
  profile: OrganizationRegionalProfile,
  timezone: string,
): string {
  const locale = profile.locale ?? "en-US";
  const hour12 =
    profile.timeFormat === "12-hour"
      ? true
      : profile.timeFormat === "24-hour"
        ? false
        : undefined;
  return new Intl.DateTimeFormat(locale, {
    timeStyle: "short",
    timeZone: timezone,
    ...(hour12 === undefined ? {} : { hour12 }),
  }).format(date);
}

export function formatRegionalDateTimeValue(
  value: string,
  kind: RegionalDateTimeKind,
  profile: OrganizationRegionalProfile,
): string {
  const parsed = parseISODateTime(value);
  if (!parsed) return value;
  const timezone = parsed.dateOnly ? "UTC" : profile.timezone;
  if (kind === "time") return formatTime(parsed.date, profile, timezone);
  const date = formatDate(parsed.date, kind, profile, timezone);
  if (kind !== "datetime" || parsed.dateOnly) return date;
  return `${date}, ${formatTime(parsed.date, profile, timezone)}`;
}

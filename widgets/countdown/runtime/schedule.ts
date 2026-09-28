/**
 * Countdown target resolution: the one place a Countdown turns its saved
 * wall-clock target into an instant.
 *
 * A target is a local date and time in the Countdown's zone
 * ("2026-12-01T09:00"), or an RFC 3339 instant saved by an older release.
 * A recurring target keeps its local wall time: a weekly 9:00 countdown
 * stays at 9:00 across a daylight-saving change, and a monthly or yearly
 * one clamps the 31st or February 29 to the last valid day. The result is
 * the next occurrence strictly after `now`.
 */
export type CountdownRecurrence =
  "none" | "daily" | "weekly" | "monthly" | "yearly";

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The instant of a saved target, or null when it cannot be read. */
export function targetInstant(target: string, timezone: string): number | null {
  return parseTarget(target, validTimezone(timezone));
}

export function resolveCountdownTarget(
  target: string,
  timezone: string,
  recurrence: CountdownRecurrence,
  now: Date,
): number | null {
  const zone = validTimezone(timezone);
  const original = parseTarget(target, zone);
  if (original === null || recurrence === "none") return original;

  const seed = partsAt(original, zone);
  const current = partsAt(now.getTime(), zone);
  let date = recurringDate(seed, current, recurrence);
  let candidate = zonedEpoch({ ...date, ...timeParts(seed) }, zone);
  if (candidate <= now.getTime()) {
    date = advanceDate(date, seed, recurrence);
    candidate = zonedEpoch({ ...date, ...timeParts(seed) }, zone);
  }
  return candidate;
}

function validTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    return "UTC";
  }
}

function parseTarget(target: string, timezone: string): number | null {
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(target)) {
    const parsed = Date.parse(target);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(
      target,
    );
  if (!match) {
    return null;
  }
  return zonedEpoch(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6] ?? 0),
    },
    timezone,
  );
}

const partFormats = new Map<string, Intl.DateTimeFormat>();

/** Formatters are cached: a ticking Countdown resolves once a second. */
function partFormat(timezone: string): Intl.DateTimeFormat {
  let format = partFormats.get(timezone);
  if (!format) {
    if (partFormats.size >= 16) partFormats.clear();
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partFormats.set(timezone, format);
  }
  return format;
}

function partsAt(epochMs: number, timezone: string): DateParts {
  const values: Record<string, number> = {};
  for (const part of partFormat(timezone).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }
  return {
    year: values["year"]!,
    month: values["month"]!,
    day: values["day"]!,
    // Some engines write midnight as "24" in the h23 cycle.
    hour: values["hour"]! % 24,
    minute: values["minute"]!,
    second: values["second"]!,
  };
}

function zonedEpoch(parts: DateParts, timezone: string): number {
  const desired = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = partsAt(candidate, timezone);
    const rendered = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const adjustment = desired - rendered;
    if (adjustment === 0) {
      break;
    }
    candidate += adjustment;
  }
  return candidate;
}

function recurringDate(
  seed: DateParts,
  current: DateParts,
  recurrence: Exclude<CountdownRecurrence, "none">,
): Pick<DateParts, "year" | "month" | "day"> {
  if (recurrence === "daily") {
    return dateParts(current.year, current.month, current.day);
  }
  if (recurrence === "weekly") {
    const currentDay = utcDate(current).getUTCDay();
    const seedDay = utcDate(seed).getUTCDay();
    return addDays(
      dateParts(current.year, current.month, current.day),
      (seedDay - currentDay + 7) % 7,
    );
  }
  if (recurrence === "monthly") {
    return dateParts(
      current.year,
      current.month,
      Math.min(seed.day, daysInMonth(current.year, current.month)),
    );
  }
  return dateParts(
    current.year,
    seed.month,
    Math.min(seed.day, daysInMonth(current.year, seed.month)),
  );
}

function advanceDate(
  date: Pick<DateParts, "year" | "month" | "day">,
  seed: DateParts,
  recurrence: Exclude<CountdownRecurrence, "none">,
): Pick<DateParts, "year" | "month" | "day"> {
  if (recurrence === "daily") {
    return addDays(date, 1);
  }
  if (recurrence === "weekly") {
    return addDays(date, 7);
  }
  if (recurrence === "monthly") {
    const next = new Date(Date.UTC(date.year, date.month, 1));
    return dateParts(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      Math.min(
        seed.day,
        daysInMonth(next.getUTCFullYear(), next.getUTCMonth() + 1),
      ),
    );
  }
  return dateParts(
    date.year + 1,
    seed.month,
    Math.min(seed.day, daysInMonth(date.year + 1, seed.month)),
  );
}

function dateParts(
  year: number,
  month: number,
  day: number,
): Pick<DateParts, "year" | "month" | "day"> {
  return { year, month, day };
}

function timeParts(
  parts: DateParts,
): Pick<DateParts, "hour" | "minute" | "second"> {
  return { hour: parts.hour, minute: parts.minute, second: parts.second };
}

function addDays(
  parts: Pick<DateParts, "year" | "month" | "day">,
  days: number,
): Pick<DateParts, "year" | "month" | "day"> {
  const value = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days),
  );
  return dateParts(
    value.getUTCFullYear(),
    value.getUTCMonth() + 1,
    value.getUTCDate(),
  );
}

function utcDate(parts: Pick<DateParts, "year" | "month" | "day">): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export type CountdownRecurrence =
  "none" | "daily" | "weekly" | "monthly" | "yearly";

export interface CountdownFormat {
  target: string;
  timezone: string;
  mode: "countdown" | "count_up";
  recurrence: CountdownRecurrence;
  completionAction: "completed_text" | "hide" | "count_up";
  visibleUnits: string;
  completionText: string;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const RECURRENCES = new Set<CountdownRecurrence>([
  "none",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

export function parseCountdownFormat(format: string): CountdownFormat | null {
  const parts = format.split(":");
  if (parts[0] !== "countdown" || parts[1] !== "v2") {
    return null;
  }
  const recurrence = parts[5] as CountdownRecurrence;
  const completionAction = parts[6];
  return {
    target: decode(parts[2]),
    timezone: decode(parts[3]) || "UTC",
    mode: parts[4] === "count_up" ? "count_up" : "countdown",
    recurrence: RECURRENCES.has(recurrence) ? recurrence : "none",
    completionAction:
      completionAction === "hide" || completionAction === "count_up"
        ? completionAction
        : "completed_text",
    visibleUnits: /^[01]{4}$/.test(parts[7] ?? "") ? parts[7]! : "1111",
    completionText: decode(parts[8]) || "Complete",
  };
}

export function resolveCountdownTarget(
  target: string,
  timezone: string,
  recurrence: CountdownRecurrence,
  now: Date,
): number {
  const zone = validTimezone(timezone);
  const original = parseTarget(target, zone);
  if (original === null || recurrence === "none") {
    return original ?? now.getTime();
  }

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

function decode(value: string | undefined): string {
  try {
    return decodeURIComponent((value ?? "").replace(/\+/g, " "));
  } catch {
    return value ?? "";
  }
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

function partsAt(epochMs: number, timezone: string): DateParts {
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }
  return {
    year: values["year"]!,
    month: values["month"]!,
    day: values["day"]!,
    hour: values["hour"]!,
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

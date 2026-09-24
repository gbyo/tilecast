/**
 * Offline, timezone-aware record and event selection.
 *
 * Structured sources, calendars, and DataDocument date-selection all pick
 * which cached records to show based on the device clock and an explicit
 * timezone — no server round-trip, so selection keeps working offline and
 * re-evaluates correctly across midnight, DST, and reboots. Half-open date
 * intervals throughout.
 */

export type SelectionMode =
  "today" | "tomorrow" | "next_available" | "current_week" | "custom_range";

export type NoMatchBehavior =
  "fallback_text" | "next_available" | "empty" | "hide" | "last_known_good";

export type FirstDayOfWeek =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

/** Local calendar date (YYYY-MM-DD) for an instant in a timezone. */
export function localDate(timezone: string, at: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** ISO weekday 1..7 (Mon..Sun) for a YYYY-MM-DD date. */
function isoWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0=Sun
  return dow === 0 ? 7 : dow;
}

function daysBackToWeekStart(date: string, firstDay: FirstDayOfWeek): number {
  const firstDayNumber: Record<FirstDayOfWeek, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  return ((isoWeekday(date) % 7) - firstDayNumber[firstDay] + 7) % 7;
}

/** Half-open [start, end) date window for a selection mode. */
export function windowForMode(
  mode: SelectionMode,
  timezone: string,
  at: Date,
  customStart?: string,
  customEnd?: string,
  firstDayOfWeek: FirstDayOfWeek = "monday",
): { start: string; end: string } {
  const today = localDate(timezone, at);
  switch (mode) {
    case "today":
      return { start: today, end: addDays(today, 1) };
    case "tomorrow": {
      const t = addDays(today, 1);
      return { start: t, end: addDays(t, 1) };
    }
    case "current_week": {
      const back = daysBackToWeekStart(today, firstDayOfWeek);
      const start = addDays(today, -back);
      return { start, end: addDays(start, 7) };
    }
    case "custom_range":
      return {
        start: customStart || today,
        end: customEnd ? addDays(customEnd, 1) : addDays(today, 1),
      };
    case "next_available":
    default:
      // Open-ended forward window; caller picks the earliest matching date.
      return { start: today, end: "9999-12-31" };
  }
}

export interface DatedRecord {
  date: string; // extracted YYYY-MM-DD (may be empty)
}

/**
 * Select records by date. Returns the matching subset plus a resolution note
 * describing how a no-match was handled.
 */
export function selectByDate<T extends DatedRecord>(
  records: T[],
  opts: {
    mode: SelectionMode;
    timezone: string;
    at: Date;
    customStart?: string;
    customEnd?: string;
    excludePast?: boolean;
    noMatchBehavior?: NoMatchBehavior;
    firstDayOfWeek?: FirstDayOfWeek;
  },
): { records: T[]; usedFallback: boolean; hidden: boolean } {
  const dated = records.filter(
    (r) => r.date && /^\d{4}-\d{2}-\d{2}/.test(r.date),
  );
  const today = localDate(opts.timezone, opts.at);

  if (opts.mode === "next_available") {
    const upcoming = dated
      .filter((r) => r.date.slice(0, 10) >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
    const firstDate = upcoming[0]?.date.slice(0, 10);
    const matched = firstDate
      ? upcoming.filter((r) => r.date.slice(0, 10) === firstDate)
      : [];
    return resolveNoMatch(matched, records, opts);
  }

  const { start, end } = windowForMode(
    opts.mode,
    opts.timezone,
    opts.at,
    opts.customStart,
    opts.customEnd,
    opts.firstDayOfWeek,
  );
  let matched = dated.filter((r) => {
    const d = r.date.slice(0, 10);
    return d >= start && d < end;
  });
  if (opts.excludePast) {
    matched = matched.filter((r) => r.date.slice(0, 10) >= today);
  }
  matched.sort((a, b) => a.date.localeCompare(b.date));
  return resolveNoMatch(matched, records, opts);
}

function resolveNoMatch<T extends DatedRecord>(
  matched: T[],
  all: T[],
  opts: { timezone: string; at: Date; noMatchBehavior?: NoMatchBehavior },
): { records: T[]; usedFallback: boolean; hidden: boolean } {
  if (matched.length > 0) {
    return { records: matched, usedFallback: false, hidden: false };
  }
  switch (opts.noMatchBehavior) {
    case "next_available": {
      const today = localDate(opts.timezone, opts.at);
      const upcoming = all
        .filter((r) => r.date && r.date.slice(0, 10) >= today)
        .sort((a, b) => a.date.localeCompare(b.date));
      const firstDate = upcoming[0]?.date.slice(0, 10);
      const next = firstDate
        ? upcoming.filter((r) => r.date.slice(0, 10) === firstDate)
        : [];
      return { records: next, usedFallback: false, hidden: false };
    }
    case "last_known_good":
      // Keep whatever the caller last showed; signal empty here and let the
      // caller retain prior content.
      return { records: [], usedFallback: false, hidden: false };
    case "hide":
      return { records: [], usedFallback: false, hidden: true };
    case "fallback_text":
      return { records: [], usedFallback: true, hidden: false };
    case "empty":
    default:
      return { records: [], usedFallback: false, hidden: false };
  }
}

// ---------------------------------------------------------------------------
// Calendar windowing

export type CalendarDisplayMode = "today" | "upcoming" | "this_week" | "agenda";

export interface CalendarLike {
  start: string;
  end: string;
}

export function selectCalendarEvents<T extends CalendarLike>(
  events: T[],
  mode: CalendarDisplayMode,
  timezone: string,
  at: Date,
  maxEvents: number,
  firstDayOfWeek: FirstDayOfWeek = "monday",
): T[] {
  const today = localDate(timezone, at);
  const now = at.getTime();
  const upcoming = events
    .filter((e) => {
      const end = Date.parse(e.end);
      return !Number.isFinite(end) || end >= now;
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  let filtered: T[];
  switch (mode) {
    case "today":
      filtered = upcoming.filter(
        (e) => localDate(timezone, new Date(e.start)) === today,
      );
      break;
    case "this_week": {
      const back = daysBackToWeekStart(today, firstDayOfWeek);
      const weekStart = addDays(today, -back);
      const weekEnd = addDays(weekStart, 7);
      filtered = upcoming.filter((e) => {
        const d = localDate(timezone, new Date(e.start));
        return d >= weekStart && d < weekEnd;
      });
      break;
    }
    case "agenda":
    case "upcoming":
    default:
      filtered = upcoming;
      break;
  }
  return filtered.slice(0, Math.max(1, maxEvents));
}

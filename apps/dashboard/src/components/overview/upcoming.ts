import type { Schedule } from "../../api/types";

export type UpcomingChange = {
  schedule: Schedule;
  at: Date;
  /** A schedule taking over the screen, or handing it back to the fallback. */
  kind: "starts" | "ends";
};

type Wall = { year: number; month: number; day: number };

const DAY_MS = 86_400_000;
/** Enough days ahead to reach any weekly schedule's next occurrence. */
const LOOKAHEAD_DAYS = 8;

function safeZone(timeZone: string, fallback: string) {
  for (const candidate of [timeZone, fallback, "UTC"]) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: candidate });
      return candidate;
    } catch {
      // Try the next candidate: an unreadable zone must not blank the card.
    }
  }
  return "UTC";
}

function wallParts(utc: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(utc);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function zoneOffsetMs(utc: Date, timeZone: string) {
  const wall = wallParts(utc, timeZone);
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return asUtc - Math.floor(utc.getTime() / 1000) * 1000;
}

/**
 * The instant at which a clock in `timeZone` reads the given date and time.
 * The offset is measured twice so a time just after a daylight-saving change
 * uses the offset in force at that time rather than at the first guess.
 */
function wallToUtc(
  wall: Wall,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, hour, minute);
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - zoneOffsetMs(new Date(first), timeZone));
}

function addDays(wall: Wall, days: number): Wall {
  const shifted = new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day) + days * DAY_MS,
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function weekday(wall: Wall) {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

function isoDate(wall: Wall) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

function clock(value: string): [number, number] | undefined {
  const [hour, minute = 0] = value.split(":").map(Number);
  if (
    hour === undefined ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return undefined;
  }
  return [hour, minute];
}

/**
 * Upcoming playback changes from enabled schedules, soonest first, in the
 * schedule's own time zone and inside its date range. Display-control
 * schedules send a command rather than change what plays, so they are not
 * playback changes and are left out.
 *
 * This reads schedule definitions, not the player's evaluation: it does not
 * resolve priority between overlapping schedules, so it lists when a schedule
 * begins or ends, not which schedule wins at that moment.
 */
export function upcomingChanges(
  schedules: Schedule[],
  now: Date = new Date(),
  defaultTimezone = "UTC",
  limit = 3,
): UpcomingChange[] {
  const changes: UpcomingChange[] = [];
  for (const schedule of schedules) {
    if (!schedule.enabled || schedule.presentationType === "display_control") {
      continue;
    }
    if (schedule.type === "one_time") {
      const starts = schedule.oneTimeStart
        ? new Date(schedule.oneTimeStart)
        : undefined;
      const ends = schedule.oneTimeEnd
        ? new Date(schedule.oneTimeEnd)
        : undefined;
      if (starts && starts > now)
        changes.push({ schedule, at: starts, kind: "starts" });
      if (ends && ends > now)
        changes.push({ schedule, at: ends, kind: "ends" });
      continue;
    }
    const start = schedule.dailyStart ? clock(schedule.dailyStart) : undefined;
    if (!start || schedule.daysOfWeek.length === 0) continue;
    const end = schedule.dailyEnd ? clock(schedule.dailyEnd) : undefined;
    const timeZone = safeZone(schedule.timezone, defaultTimezone);
    const today = wallParts(now, timeZone);
    let nextStart: Date | undefined;
    let nextEnd: Date | undefined;
    // Start one day back: an overnight window that began yesterday still
    // ends today.
    for (let offset = -1; offset <= LOOKAHEAD_DAYS; offset += 1) {
      const day = addDays(today, offset);
      if (!schedule.daysOfWeek.includes(weekday(day))) continue;
      const date = isoDate(day);
      if (schedule.startDate && date < schedule.startDate) continue;
      if (schedule.endDate && date > schedule.endDate) continue;
      const startsAt = wallToUtc(day, start[0], start[1], timeZone);
      if (!nextStart && startsAt > now) nextStart = startsAt;
      if (end) {
        const overnight =
          end[0] < start[0] || (end[0] === start[0] && end[1] <= start[1]);
        const endsAt = wallToUtc(
          overnight ? addDays(day, 1) : day,
          end[0],
          end[1],
          timeZone,
        );
        if (!nextEnd && endsAt > now) nextEnd = endsAt;
      }
      if (nextStart && (nextEnd || !end)) break;
    }
    if (nextStart) changes.push({ schedule, at: nextStart, kind: "starts" });
    // An end that falls after the same schedule's next start belongs to a
    // window that is not running yet, so it is not the next change.
    if (nextEnd && (!nextStart || nextEnd < nextStart)) {
      changes.push({ schedule, at: nextEnd, kind: "ends" });
    }
  }
  return changes
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, limit);
}

/** Zone of the schedule for display, or undefined when it is unreadable. */
export function displayZone(schedule: Schedule, defaultTimezone: string) {
  return safeZone(schedule.timezone, defaultTimezone);
}

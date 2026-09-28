/**
 * Active-hours evaluation.
 *
 * Outside configured active hours a signage screen should rest — stop
 * decoding, release keep-awake, and show true black (or sleep the display if
 * the platform allows) — then wake itself at the next window with no operator
 * involvement. This is a core "never touch it" behavior: screens that dark
 * themselves overnight and light up in the morning on their own.
 *
 * Windows are half-open [start, end) in an explicit IANA timezone. An end at
 * or before the start denotes an overnight window belonging to the start day.
 * Evaluation is pure and clock-injected so DST transitions and the
 * next-transition computation are unit-testable; the caller re-evaluates on a
 * short timer and on system clock/timezone changes rather than trusting a
 * single far-future wake.
 */

export interface ActiveHoursConfig {
  enabled: boolean;
  timezone: string;
  /** ISO weekdays the window may start on: 1 = Monday .. 7 = Sunday. */
  days: number[];
  /** "HH:MM" local start. */
  start: string;
  /** "HH:MM" local end; <= start means overnight. */
  end: string;
}

export interface ActiveHoursResult {
  /** True when the screen should be presenting content. */
  active: boolean;
  /** Approx ms until the state next flips; caller clamps its own timer. */
  msUntilTransition: number | null;
}

interface LocalNow {
  isoWeekday: number; // 1..7
  minutes: number; // minutes since local midnight
}

function localNow(timezone: string, at: Date): LocalNow | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
  } catch {
    return null;
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const isoByName: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  const isoWeekday = isoByName[get("weekday")];
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  if (
    isoWeekday === undefined ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null;
  }
  return { isoWeekday, minutes: hour * 60 + minute };
}

function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) {
    return null;
  }
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return h * 60 + min;
}

/**
 * Is the screen within an active window right now? When active hours are
 * disabled or misconfigured the screen is always considered active — a
 * broken schedule must never dark a screen that should be showing content.
 */
export function evaluateActiveHours(
  config: ActiveHoursConfig | null,
  at: Date,
): ActiveHoursResult {
  if (!config || !config.enabled) {
    return { active: true, msUntilTransition: null };
  }
  const now = localNow(config.timezone, at);
  const start = parseHHMM(config.start);
  const end = parseHHMM(config.end);
  const days = new Set(config.days ?? []);
  if (!now || start === null || end === null || days.size === 0) {
    return { active: true, msUntilTransition: null };
  }

  const previousIso = ((now.isoWeekday + 5) % 7) + 1; // yesterday's ISO weekday
  const overnight = end <= start;

  let active: boolean;
  if (!overnight) {
    active =
      days.has(now.isoWeekday) && now.minutes >= start && now.minutes < end;
  } else {
    // From start..24:00 on a selected day, and 00:00..end on the next day.
    const afterStartToday = days.has(now.isoWeekday) && now.minutes >= start;
    const beforeEndFromYesterday = days.has(previousIso) && now.minutes < end;
    active = afterStartToday || beforeEndFromYesterday;
  }

  // Approximate ms to the next boundary using the nearest same-day edge; the
  // caller only uses this to bound its poll, so minute precision is enough.
  const msUntil = nextBoundaryMs(now.minutes, start, end, overnight);
  return { active, msUntilTransition: msUntil };
}

function nextBoundaryMs(
  nowMin: number,
  start: number,
  end: number,
  overnight: boolean,
): number {
  const dayMin = 24 * 60;
  const edges = overnight ? [end, start] : [start, end];
  let best = Infinity;
  for (const edge of edges) {
    let delta = edge - nowMin;
    if (delta <= 0) {
      delta += dayMin;
    }
    best = Math.min(best, delta);
  }
  return best === Infinity ? dayMin * 60_000 : best * 60_000;
}

/** Extract an ActiveHoursConfig from a PlayerConfig `power` map, if present. */
export function activeHoursFromConfig(
  power: Record<string, unknown> | undefined,
): ActiveHoursConfig | null {
  if (!power) {
    return null;
  }
  const enabled = power["activeHoursEnabled"] === true;
  if (!enabled) {
    return {
      enabled: false,
      timezone: "UTC",
      days: [],
      start: "00:00",
      end: "00:00",
    };
  }
  const days = Array.isArray(power["activeHoursDays"])
    ? (power["activeHoursDays"] as unknown[])
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
    : [];
  return {
    enabled: true,
    timezone: String(power["activeHoursTimezone"] ?? "UTC"),
    days,
    start: String(power["activeHoursStart"] ?? "00:00"),
    end: String(power["activeHoursEnd"] ?? "00:00"),
  };
}

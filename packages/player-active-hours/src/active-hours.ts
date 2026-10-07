/**
 * Active-hours evaluation.
 *
 * Outside configured active hours a signage screen should rest: stop decoding,
 * release keep-awake, and show a quiet surface, then wake itself at the next
 * window with no operator involvement.
 *
 * Windows are half-open [start, end) in an explicit IANA timezone. An end at
 * or before the start denotes an overnight window that belongs to the start
 * day. Evaluation is pure and takes the instant as input. It reads the local
 * weekday and the minute of the day in the configured timezone, so a daylight
 * saving change needs no special case: a skipped minute never appears on the
 * local clock, and a repeated minute is active in both passes.
 *
 * This is not a content schedule. It chooses between "show the selected
 * content" and "rest", never between two pieces of content. Player Core's
 * `evaluate_active_hours` follows the same rules, and both run the cases in
 * `packages/settings-schema/active-hours-fixtures.json`.
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

export type ActiveHoursState = "active" | "off_hours";

export interface ActiveHoursResult {
  /** True when the screen should be presenting content. */
  active: boolean;
  /** The value a Player reports as `activeHoursState`. */
  state: ActiveHoursState;
  /**
   * Milliseconds until the state may next change, or null when it never will.
   * It counts minutes of the local clock, so across a daylight saving change
   * it can be an hour away from the real transition. The caller evaluates
   * again when it expires and on every other wake.
   */
  msUntilTransition: number | null;
  /** `at` plus `msUntilTransition`, in epoch milliseconds. */
  nextTransitionAtMs: number | null;
}

interface LocalNow {
  isoWeekday: number; // 1..7
  minutes: number; // minutes since local midnight
}

const WEEKDAYS: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};
const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;
const MIN_WAIT_MS = 1_000;
const FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timezone: string): Intl.DateTimeFormat | null {
  const cached = FORMATTERS.get(timezone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    formatter = null;
  }
  if (FORMATTERS.size >= 32) FORMATTERS.clear();
  FORMATTERS.set(timezone, formatter);
  return formatter;
}

function localNow(timezone: string, atMs: number): LocalNow | null {
  const formatter = formatterFor(timezone);
  if (!formatter) return null;
  const parts = formatter.formatToParts(new Date(atMs));
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const isoWeekday = WEEKDAYS[get("weekday")];
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

/** `H:MM` or `HH:MM`, 00:00 to 23:59. Anything else is not a time. */
export function parseClockMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
}

const ALWAYS_ACTIVE: ActiveHoursResult = {
  active: true,
  state: "active",
  msUntilTransition: null,
  nextTransitionAtMs: null,
};

/**
 * Is the screen within an active window at `at`? Disabled or misconfigured
 * active hours are always active: a broken schedule must never darken a
 * screen that should show content.
 */
export function evaluateActiveHours(
  config: ActiveHoursConfig | null,
  at: Date | number,
): ActiveHoursResult {
  if (!config || !config.enabled) return ALWAYS_ACTIVE;
  const atMs = typeof at === "number" ? at : at.getTime();
  const start = parseClockMinutes(config.start);
  const end = parseClockMinutes(config.end);
  const days = new Set(config.days ?? []);
  const now = Number.isFinite(atMs) ? localNow(config.timezone, atMs) : null;
  if (!now || start === null || end === null || days.size === 0) {
    return ALWAYS_ACTIVE;
  }

  const previous = ((now.isoWeekday + 5) % 7) + 1; // yesterday's ISO weekday
  const active =
    end <= start
      ? // From start to midnight on a listed day, and midnight to end on the next.
        (days.has(now.isoWeekday) && now.minutes >= start) ||
        (days.has(previous) && now.minutes < end)
      : days.has(now.isoWeekday) && now.minutes >= start && now.minutes < end;

  const nearest = Math.min(
    ...[start, end].map((edge) => {
      const delta = edge - now.minutes;
      return delta <= 0 ? delta + DAY_MINUTES : delta;
    }),
  );
  // Minute precision is enough: the caller evaluates again at this point.
  const intoMinute = ((atMs % MINUTE_MS) + MINUTE_MS) % MINUTE_MS;
  const msUntilTransition = Math.max(
    MIN_WAIT_MS,
    nearest * MINUTE_MS - intoMinute,
  );
  return {
    active,
    state: active ? "active" : "off_hours",
    msUntilTransition,
    nextTransitionAtMs: atMs + msUntilTransition,
  };
}

/**
 * Reads the active-hours settings of a Player configuration's `power`
 * section. Unreadable values fall back the way Player Core's parser does:
 * the timezone is trimmed and bounded, weekdays are integers 1 to 7, and an
 * unreadable time disables the window instead of guessing.
 */
export function activeHoursFromConfig(
  power: Record<string, unknown> | undefined,
): ActiveHoursConfig | null {
  if (!power) return null;
  if (power["activeHoursEnabled"] !== true) {
    return {
      enabled: false,
      timezone: "UTC",
      days: [],
      start: "00:00",
      end: "00:00",
    };
  }
  const rawDays = power["activeHoursDays"];
  const days = Array.isArray(rawDays)
    ? rawDays
        .filter(
          (day): day is number =>
            typeof day === "number" &&
            Number.isInteger(day) &&
            day >= 1 &&
            day <= 7,
        )
        .slice(0, 7)
    : [];
  const timezone = power["activeHoursTimezone"];
  const start = power["activeHoursStart"];
  const end = power["activeHoursEnd"];
  return {
    enabled: true,
    timezone:
      typeof timezone === "string" ? timezone.trim().slice(0, 64) : "UTC",
    days,
    start: typeof start === "string" ? start : "",
    end: typeof end === "string" ? end : "",
  };
}

/**
 * Only an operator action outranks rest. A Takeover or a Quick Present shows
 * outside active hours; a schedule or a direct assignment does not.
 */
export function overridesActiveHours(
  source: string | null | undefined,
): boolean {
  return source === "takeover" || source === "quick_present";
}

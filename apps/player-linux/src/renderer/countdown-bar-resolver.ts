/**
 * Countdown Bar schedule resolution: which configured bar — if any — should be
 * on screen right now. Kept as a tiny global beside the countdown display
 * because renderer scripts run directly in the sandboxed page without module
 * imports, and shared so the renderer surface and its tests evaluate the exact
 * same weekly, one-time, DST, completion, and priority behavior.
 */
/**
 * One entry of the manifest's plugin array as it arrives, before any resolver
 * has claimed it. A resolver narrows by `type` and `version` and then reads its
 * own configuration shape, so an entry belonging to another plugin — or to a
 * plugin this Player predates — travels through untouched.
 */
interface TilecastManifestPluginEntry {
  id: string;
  type: string;
  version: number;
  config: unknown;
}

interface TilecastCountdownBarPlugin {
  id: string;
  type: string;
  version: number;
  config: {
    message: string;
    scheduleType: "weekly" | "one_time";
    targetTime?: string | null;
    daysOfWeek?: number[];
    oneTimeAt?: string | null;
    timezone: string;
    leadTimeSeconds: number;
    completionText?: string;
    showConfetti?: boolean;
    displayMode: "overlay" | "push";
    heightPx: number;
    progressFill?: "none" | "drain" | null;
    contentPadding?: number | null;
    textScale?: number | null;
    urgencyEnabled?: boolean;
    startingSoonSeconds?: number | null;
    urgentSeconds?: number | null;
    pulseSeconds?: number | null;
    priority: number;
  };
}

interface TilecastActiveCountdownBar {
  id: string;
  message: string;
  value: string;
  displayMode: "overlay" | "push";
  heightPx: number;
  priority: number;
  targetAt: string;
  completed: boolean;
  showBar: boolean;
  showConfetti: boolean;
  urgencyStage: "normal" | "starting_soon" | "urgent" | "final";
  urgencyLabel: string;
  pulse: boolean;
  /**
   * Share of the lead window still to run, 1 when the bar first appears and 0 at
   * the target. Always 0 while completion text shows. `null` when the instance
   * asks for no fill, so the surface can leave the background alone rather than
   * paint a full-width tint.
   */
  remainingFraction: number | null;
  /** Gutter on each side, as a percentage of the bar width. */
  contentPadding: number;
  /** Type size in pixels, already scaled. */
  fontSizePx: number;
}

interface TilecastCountdownBarResolver {
  resolve(
    plugins: TilecastManifestPluginEntry[] | null | undefined,
    localNow: Date,
    clockOffsetMs?: number,
  ): TilecastActiveCountdownBar | null;
}

const tilecastCountdownBar: TilecastCountdownBarResolver = (() => {
  const COMPLETION_DISPLAY_MS = 60_000;
  const CONFETTI_DISPLAY_MS = 12_000;
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // One formatter per zone: a bar re-resolves every second on hardware where
  // rebuilding Intl formatters is the most expensive part of the tick.
  const formatters = new Map<string, Intl.DateTimeFormat>();

  function formatter(timezone: string): Intl.DateTimeFormat {
    let cached = formatters.get(timezone);
    if (!cached) {
      cached = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        weekday: "short",
      });
      formatters.set(timezone, cached);
    }
    return cached;
  }

  function zonedParts(at: Date, timezone: string) {
    const parts = formatter(timezone).formatToParts(at);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    return {
      year: Number(value("year")),
      month: Number(value("month")),
      day: Number(value("day")),
      hour: Number(value("hour")),
      minute: Number(value("minute")),
      second: Number(value("second")),
      weekday: WEEKDAYS.indexOf(value("weekday")),
    };
  }

  /** Convert a calendar wall time in an IANA zone to an absolute instant. */
  function zonedInstant(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    timezone: string,
  ): number {
    const desired = Date.UTC(year, month - 1, day, hour, minute, second);
    let guess = desired;
    // Two passes cover ordinary offsets and DST boundary corrections without a
    // heavy timezone dependency. Intl remains the source of timezone truth.
    for (let pass = 0; pass < 3; pass += 1) {
      const actual = zonedParts(new Date(guess), timezone);
      const represented = Date.UTC(
        actual.year,
        actual.month - 1,
        actual.day,
        actual.hour,
        actual.minute,
        actual.second,
      );
      const correction = desired - represented;
      guess += correction;
      if (correction === 0) break;
    }
    return guess;
  }

  /** Manifests may omit these, and a hand-edited one may be out of range. */
  function clampNumber(
    value: number | null | undefined,
    fallback: number,
    lowest: number,
    highest: number,
  ): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(highest, Math.max(lowest, value));
  }

  /**
   * Type size follows the bar height, clamped the way the stylesheet used to
   * clamp it, then scaled. The scale multiplies the clamped result so a bar can
   * exceed the original 72px ceiling deliberately rather than by accident.
   */
  function countdownFontSizePx(heightPx: number, scalePercent: number): number {
    const base = Math.min(72, Math.max(22, heightPx * 0.42));
    return Math.round(base * (scalePercent / 100) * 100) / 100;
  }

  function candidateTargets(
    plugin: TilecastCountdownBarPlugin,
    now: Date,
  ): number[] {
    const config = plugin.config;
    if (config.scheduleType === "one_time") {
      const instant = Date.parse(config.oneTimeAt ?? "");
      return Number.isFinite(instant) ? [instant] : [];
    }
    const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
      config.targetTime ?? "",
    );
    if (!match) return [];
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] ?? 0);
    if (hour > 23 || minute > 59 || second > 59) return [];
    const current = zonedParts(now, config.timezone);
    const dateAnchor = Date.UTC(current.year, current.month - 1, current.day);
    const days = new Set(config.daysOfWeek ?? []);
    const targets: number[] = [];
    // A lead window may begin up to 30 days before its target. Looking in both
    // directions also retains completion text around the preceding occurrence.
    for (let offset = -31; offset <= 31; offset += 1) {
      const date = new Date(dateAnchor + offset * 86_400_000);
      if (!days.has(date.getUTCDay())) continue;
      targets.push(
        zonedInstant(
          date.getUTCFullYear(),
          date.getUTCMonth() + 1,
          date.getUTCDate(),
          hour,
          minute,
          second,
          config.timezone,
        ),
      );
    }
    return targets;
  }

  return Object.freeze({
    resolve(
      plugins: TilecastManifestPluginEntry[] | null | undefined,
      localNow: Date,
      clockOffsetMs = 0,
    ): TilecastActiveCountdownBar | null {
      const now = localNow.getTime() + clockOffsetMs;
      const active: TilecastActiveCountdownBar[] = [];
      for (const entry of plugins ?? []) {
        if (entry.type !== "countdown_bar" || entry.version !== 1) continue;
        const plugin = entry as TilecastCountdownBarPlugin;
        for (const target of candidateTargets(plugin, new Date(now))) {
          const remaining = target - now;
          const completionText = plugin.config.completionText?.trim() ?? "";
          const completionVisible =
            remaining <= 0 &&
            remaining >= -COMPLETION_DISPLAY_MS &&
            completionText.length > 0;
          const confettiVisible =
            remaining <= 0 &&
            remaining >= -CONFETTI_DISPLAY_MS &&
            plugin.config.showConfetti === true;
          if (
            remaining > plugin.config.leadTimeSeconds * 1_000 ||
            (remaining <= 0 && !completionVisible && !confettiVisible)
          ) {
            continue;
          }
          // A non-positive lead window would divide by zero; treat it as spent
          // rather than emitting NaN into a CSS width.
          const leadMs = plugin.config.leadTimeSeconds * 1_000;
          const fraction =
            leadMs > 0 ? Math.min(1, Math.max(0, remaining / leadMs)) : 0;
          const startingSoonMs =
            clampNumber(plugin.config.startingSoonSeconds, 300, 2, 86_400) *
            1_000;
          const urgentMs =
            clampNumber(plugin.config.urgentSeconds, 60, 2, 3_600) * 1_000;
          const pulseMs =
            clampNumber(plugin.config.pulseSeconds, 10, 1, 60) * 1_000;
          const urgencyStage =
            plugin.config.urgencyEnabled !== true || remaining <= 0
              ? "normal"
              : remaining <= pulseMs
                ? "final"
                : remaining <= urgentMs
                  ? "urgent"
                  : remaining <= startingSoonMs
                    ? "starting_soon"
                    : "normal";
          const finalScale = urgencyStage === "final" ? 1.25 : 1;
          const baseHeight = Math.min(
            Math.max(plugin.config.heightPx, 40),
            320,
          );
          active.push({
            id: plugin.id,
            // Completion text is the whole ending message, not a replacement
            // for only the numeric value. Keeping the normal prefix here would
            // produce phrases such as "Lunch ends in Lunch is over".
            message: remaining <= 0 ? "" : plugin.config.message,
            value: completionVisible
              ? completionText
              : remaining > 0
                ? tilecastCountdownDisplay.compact(remaining)
                : "",
            displayMode: plugin.config.displayMode,
            heightPx: Math.round(baseHeight * finalScale),
            priority: plugin.config.priority,
            targetAt: new Date(target).toISOString(),
            completed: remaining <= 0,
            showBar: remaining > 0 || completionVisible,
            showConfetti: confettiVisible,
            urgencyStage,
            urgencyLabel:
              urgencyStage === "starting_soon"
                ? "Starting soon"
                : urgencyStage === "urgent" || urgencyStage === "final"
                  ? "Urgent"
                  : "",
            pulse: urgencyStage === "final",
            remainingFraction:
              plugin.config.progressFill === "drain" ? fraction : null,
            contentPadding: clampNumber(plugin.config.contentPadding, 4, 0, 40),
            fontSizePx:
              countdownFontSizePx(
                plugin.config.heightPx,
                clampNumber(plugin.config.textScale, 100, 25, 500),
              ) * finalScale,
          });
        }
      }
      active.sort(
        (left, right) =>
          right.priority - left.priority ||
          Date.parse(left.targetAt) - Date.parse(right.targetAt) ||
          left.id.localeCompare(right.id),
      );
      return active[0] ?? null;
    },
  });
})();

// Exposed for unit tests only. In the player this is a plain global shared
// between the renderer scripts, which have no module loader.
(
  globalThis as typeof globalThis & {
    tilecastCountdownBar: TilecastCountdownBarResolver;
  }
).tilecastCountdownBar = tilecastCountdownBar;

import type { RuntimeManifestEntry as TilecastManifestPluginEntry } from "@tilecast/plugin-sdk/runtime";
/**
 * Noise Meter: room level measurement for the Linux Player, kept out of the
 * renderer so the parts that decide *whether* a bar should be on screen can be
 * tested without a microphone, an AudioContext, or a DOM.
 *
 * Four separable concerns live here, in this order:
 *
 *   1. `resolve`        — which configured instance applies, with every bound
 *                         clamped defensively.
 *   2. `levelFromRms`   — one waveform RMS to the normalized 0-100 Tilecast
 *                         noise scale.
 *   3. `createSmoother` — jitter removal that still reacts to a real rise.
 *   4. `createStateMachine` — the hysteresis that keeps a bar from flapping.
 *
 * The microphone itself belongs to the runtime host (plugins/microphone.ts):
 * this module only turns RMS levels into readings.
 *
 * What this module never does: record, store, or transmit audio. It never
 * sees audio at all, only one RMS number per sampling window.
 *
 * The published value is relative to whatever microphone happens to be plugged
 * into this player. It is not dB, dBA, or SPL, and nothing here should present
 * it as a calibrated physical measurement.
 */
export interface TilecastNoiseMeterPlugin {
  id: string;
  type: string;
  version: number;
  config: {
    name?: string;
    message?: string;
    warningLevel: number;
    loudLevel: number;
    sensitivity: number;
    triggerHoldMs: number;
    clearHoldMs: number;
    displayMode: "overlay" | "push";
    heightPx: number;
    historyEnabled?: boolean;
    historyRetentionDays?: number;
    historyActiveHoursOnly?: boolean;
    scheduleEnabled?: boolean;
    scheduleDaysOfWeek?: number[];
    scheduleStartTime?: string | null;
    scheduleEndTime?: string | null;
    scheduleTimezone?: string;
  };
}

/** One applicable instance, with every value already clamped into range. */
export interface TilecastNoiseMeterSettings {
  id: string;
  name: string;
  /** Shown in place of the bar's own TOO LOUD label when non-empty. */
  message: string;
  warningLevel: number;
  loudLevel: number;
  sensitivity: number;
  triggerHoldMs: number;
  clearHoldMs: number;
  displayMode: "overlay" | "push";
  heightPx: number;
  /** Whether completed ten-second aggregates should be kept at all. */
  historyEnabled: boolean;
  /** How long unsent aggregates may wait locally, in days. */
  historyRetentionDays: number;
  /** Stop listening outside active hours rather than discarding what is heard. */
  historyActiveHoursOnly: boolean;
  /**
   * The optional window during which the bar may appear. It governs the bar
   * alone: measurement and history keep their own rules, so a room can be
   * monitored all day while the bar is only wanted during class.
   */
  scheduleEnabled: boolean;
  /** Days the window may start on, Sunday 0 through Saturday 6. */
  scheduleDaysOfWeek: number[];
  /** "HH:MM" local start, or null when there is no window. */
  scheduleStartTime: string | null;
  /** "HH:MM" local end; at or before the start means the window runs overnight. */
  scheduleEndTime: string | null;
  scheduleTimezone: string;
}

export type TilecastNoiseMeterState =
  "normal" | "triggering" | "loud" | "recovering" | "unavailable";

export interface TilecastNoiseMeterReading {
  state: TilecastNoiseMeterState;
  /** Whether the bar should hold the bottom strip right now. */
  visible: boolean;
  /** The smoothed level behind this reading, 0-100. */
  level: number;
}

export interface TilecastNoiseMeterMachine {
  update(level: number | null, nowMs: number): TilecastNoiseMeterReading;
  reset(): void;
}

export interface TilecastNoiseMeterSmoother {
  push(level: number, nowMs: number): number;
  reset(): void;
}

/**
 * One completed ten-second aggregate. This is the only thing about a room that
 * is ever written down: an average, a peak, three durations, and how many times
 * the meter tripped. No sample, no waveform, and nothing that could be replayed.
 */
export interface TilecastNoiseHistoryBucket {
  /** Start of the fixed ten-second grid slot, as an ISO instant. */
  startedAt: string;
  averageLevel: number;
  peakLevel: number;
  /** How much of the ten seconds the microphone actually covered. */
  monitoredMs: number;
  warningMs: number;
  loudMs: number;
  /** Times the state machine entered its loud state inside this bucket. */
  triggerCount: number;
}

export interface TilecastNoiseHistoryAggregator {
  /**
   * Feed one live reading. Returns a bucket when this reading closed the
   * previous one, so the caller hands completed aggregates onward and keeps
   * nothing else.
   */
  push(
    level: number | null,
    atMs: number,
    enteredLoud?: boolean,
  ): TilecastNoiseHistoryBucket | null;
  /** Close the open bucket early, on teardown or when history is disabled. */
  flush(): TilecastNoiseHistoryBucket | null;
  reset(): void;
}

export interface TilecastNoiseMeterModule {
  resolve(
    plugins: readonly TilecastManifestPluginEntry[] | null | undefined,
  ): TilecastNoiseMeterSettings | null;
  levelFromRms(rms: number, sensitivity: number): number;
  createSmoother(options?: {
    attackMs?: number;
    releaseMs?: number;
  }): TilecastNoiseMeterSmoother;
  createStateMachine(
    settings: Pick<
      TilecastNoiseMeterSettings,
      "warningLevel" | "loudLevel" | "triggerHoldMs" | "clearHoldMs"
    >,
  ): TilecastNoiseMeterMachine;
  createHistoryAggregator(settings: {
    warningLevel: number;
    loudLevel: number;
  }): TilecastNoiseHistoryAggregator;
  scheduleOpen(
    settings: Pick<
      TilecastNoiseMeterSettings,
      | "scheduleEnabled"
      | "scheduleDaysOfWeek"
      | "scheduleStartTime"
      | "scheduleEndTime"
      | "scheduleTimezone"
    >,
    at: Date,
  ): boolean;
  /** The meter's own update rate, well above the one-second plugin tick. */
  readonly sampleIntervalMs: number;
  /** The fixed history resolution. Not configurable, on purpose. */
  readonly historyBucketMs: number;
}

export const tilecastNoiseMeter: TilecastNoiseMeterModule = (() => {
  // ~16 updates a second: fast enough to read as live movement, slow enough to
  // stay invisible on the low-end mini PCs these players run on.
  const SAMPLE_INTERVAL_MS = 60;
  // The history resolution. Fixed rather than configurable: the Player, the
  // stored records, and every chart aggregation have to agree about what one
  // record means, and per-installation resolution would break that quietly.
  const HISTORY_BUCKET_MS = 10_000;
  // Everything quieter than this is the bottom of the scale. A room that is
  // genuinely silent must land near 0 rather than at negative infinity.
  const FLOOR_DBFS = -60;

  function clampInteger(
    value: number | null | undefined,
    fallback: number,
    lowest: number,
    highest: number,
  ): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(highest, Math.max(lowest, Math.round(value)));
  }

  function clampLevel(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(100, Math.max(0, value));
  }

  /** "HH:MM" to minutes since local midnight, or null when unreadable. */
  function parseClockMinutes(value: string | null | undefined): number | null {
    const match = /^(\d{2}):(\d{2})/.exec(value ?? "");
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  // One formatter per zone: the window is evaluated on every plugin tick, and
  // rebuilding Intl formatters is the expensive part of that tick on the
  // hardware these players run on.
  const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function zonedWeekdayMinutes(
    timezone: string,
    at: Date,
  ): { weekday: number; minutes: number } | null {
    let formatter = zoneFormatters.get(timezone);
    if (!formatter) {
      try {
        formatter = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        });
      } catch {
        return null;
      }
      zoneFormatters.set(timezone, formatter);
    }
    const parts = formatter.formatToParts(at);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    const weekday = WEEKDAYS.indexOf(value("weekday"));
    const hours = Number(value("hour"));
    const minutes = Number(value("minute"));
    if (weekday < 0 || !Number.isFinite(hours) || !Number.isFinite(minutes)) {
      return null;
    }
    return { weekday, minutes: hours * 60 + minutes };
  }

  return Object.freeze({
    sampleIntervalMs: SAMPLE_INTERVAL_MS,

    resolve(
      plugins: readonly TilecastManifestPluginEntry[] | null | undefined,
    ): TilecastNoiseMeterSettings | null {
      const candidates: TilecastNoiseMeterSettings[] = [];
      for (const entry of plugins ?? []) {
        if (entry.type !== "noise_meter" || entry.version !== 1) continue;
        const config = (entry as TilecastNoiseMeterPlugin).config;
        if (!config) continue;
        const loudLevel = clampInteger(config.loudLevel, 80, 2, 100);
        // The warning level is also the clear threshold, so it has to stay
        // strictly below the loud level: one value for both directions is what
        // makes a bar flap while a room hovers around it.
        const warningLevel = Math.min(
          clampInteger(config.warningLevel, 60, 1, 99),
          loudLevel - 1,
        );
        candidates.push({
          id: entry.id,
          name: config.name?.trim() ?? "",
          message: config.message?.trim() ?? "",
          warningLevel,
          loudLevel,
          sensitivity: clampInteger(config.sensitivity, 100, 25, 300),
          triggerHoldMs: clampInteger(config.triggerHoldMs, 1_000, 100, 10_000),
          clearHoldMs: clampInteger(config.clearHoldMs, 3_000, 500, 30_000),
          displayMode: config.displayMode === "push" ? "push" : "overlay",
          heightPx: clampInteger(config.heightPx, 96, 40, 320),
          // A manifest that predates history says nothing about it, which is
          // not the same as asking for it: history stays off.
          historyEnabled: config.historyEnabled === true,
          historyRetentionDays: clampInteger(
            config.historyRetentionDays,
            7,
            1,
            30,
          ),
          historyActiveHoursOnly: config.historyActiveHoursOnly !== false,
          // A window is only a window when it can actually open. Anything
          // half-configured is treated as no window at all, which shows the bar
          // whenever the room is too loud rather than hiding it forever.
          scheduleEnabled:
            config.scheduleEnabled === true &&
            typeof config.scheduleStartTime === "string" &&
            typeof config.scheduleEndTime === "string" &&
            Array.isArray(config.scheduleDaysOfWeek) &&
            config.scheduleDaysOfWeek.length > 0,
          scheduleDaysOfWeek: (config.scheduleDaysOfWeek ?? []).filter(
            (day) => Number.isInteger(day) && day >= 0 && day <= 6,
          ),
          scheduleStartTime: config.scheduleStartTime ?? null,
          scheduleEndTime: config.scheduleEndTime ?? null,
          scheduleTimezone: config.scheduleTimezone?.trim() || "UTC",
        });
      }
      // A screen has one microphone, so two applicable instances cannot both
      // run. The lowest stable instance ID wins, which matches what the server
      // projects and keeps two players in a group in agreement.
      candidates.sort((left, right) => left.id.localeCompare(right.id));
      return candidates[0] ?? null;
    },

    /**
     * One window's RMS as a point on the 0-100 scale. dBFS is the internal
     * representation because it is what makes quiet rooms distinguishable at
     * all; it is never published, and 0-100 is never described as decibels.
     */
    levelFromRms(rms: number, sensitivity: number): number {
      if (typeof rms !== "number" || !Number.isFinite(rms) || rms <= 0) {
        return 0;
      }
      const gain = clampInteger(sensitivity, 100, 25, 300) / 100;
      const dbfs = 20 * Math.log10(rms * gain);
      if (!Number.isFinite(dbfs)) return 0;
      return clampLevel(((dbfs - FLOOR_DBFS) / -FLOOR_DBFS) * 100);
    },

    /**
     * An exponential moving average with separate rise and fall constants. A
     * room getting loud has to reach the bar quickly, while a momentary dip in
     * a loud room must not drag the marker back down.
     */
    createSmoother(
      options: { attackMs?: number; releaseMs?: number } = {},
    ): TilecastNoiseMeterSmoother {
      const attackMs = options.attackMs ?? 90;
      const releaseMs = options.releaseMs ?? 380;
      let current: number | null = null;
      let lastAt = 0;
      return {
        push(level: number, nowMs: number): number {
          const target = clampLevel(level);
          if (current === null || !Number.isFinite(nowMs)) {
            current = target;
            lastAt = Number.isFinite(nowMs) ? nowMs : 0;
            return current;
          }
          // A clamped step keeps a paused renderer or a clock jump from
          // collapsing the average into one sample.
          const elapsed = Math.min(1_000, Math.max(0, nowMs - lastAt));
          lastAt = nowMs;
          const constant = target > current ? attackMs : releaseMs;
          const alpha =
            constant <= 0 ? 1 : 1 - Math.exp(-elapsed / Math.max(1, constant));
          const next = current + (target - current) * alpha;
          current = Number.isFinite(next) ? clampLevel(next) : target;
          return current;
        },
        reset(): void {
          current = null;
          lastAt = 0;
        },
      };
    },

    /**
     * The hysteresis. Two thresholds and two holds, so a shout does not raise
     * the bar and a pause in a loud room does not drop it:
     *
     *   normal      → triggering once the level reaches the loud threshold
     *   triggering  → loud after triggerHoldMs, or back to normal on a dip
     *   loud        → recovering once the level falls below the warning level
     *   recovering  → normal after clearHoldMs, or back to loud on a rise
     *   unavailable → whenever there is no usable input at all
     */
    createStateMachine(
      settings: Pick<
        TilecastNoiseMeterSettings,
        "warningLevel" | "loudLevel" | "triggerHoldMs" | "clearHoldMs"
      >,
    ): TilecastNoiseMeterMachine {
      const loudLevel = clampInteger(settings.loudLevel, 80, 2, 100);
      const clearLevel = Math.min(
        clampInteger(settings.warningLevel, 60, 1, 99),
        loudLevel - 1,
      );
      const triggerHoldMs = clampInteger(
        settings.triggerHoldMs,
        1_000,
        100,
        10_000,
      );
      const clearHoldMs = clampInteger(
        settings.clearHoldMs,
        3_000,
        500,
        30_000,
      );
      let state: TilecastNoiseMeterState = "normal";
      let since = 0;
      return {
        update(level: number | null, nowMs: number): TilecastNoiseMeterReading {
          if (typeof level !== "number" || !Number.isFinite(level)) {
            // No microphone, no permission, or a disappeared input: the bar
            // comes down and playback continues untouched.
            state = "unavailable";
            since = nowMs;
            return { state, visible: false, level: 0 };
          }
          const value = clampLevel(level);
          if (state === "unavailable") {
            state = "normal";
            since = nowMs;
          }
          switch (state) {
            case "normal":
              if (value >= loudLevel) {
                state = "triggering";
                since = nowMs;
              }
              break;
            case "triggering":
              if (value < loudLevel) {
                state = "normal";
              } else if (nowMs - since >= triggerHoldMs) {
                state = "loud";
                since = nowMs;
              }
              break;
            case "loud":
              if (value < clearLevel) {
                state = "recovering";
                since = nowMs;
              }
              break;
            case "recovering":
              if (value >= clearLevel) {
                // Still loud enough to matter: cancel the hide timer rather
                // than blinking the bar off and straight back on.
                state = "loud";
                since = nowMs;
              } else if (nowMs - since >= clearHoldMs) {
                state = "normal";
                since = nowMs;
              }
              break;
            default:
              break;
          }
          return {
            state,
            visible: state === "loud" || state === "recovering",
            level: value,
          };
        },
        reset(): void {
          state = "normal";
          since = 0;
        },
      };
    },

    /**
     * Live readings in, ten-second aggregates out.
     *
     * Boundaries are a fixed grid — floor(now / 10s) — rather than "ten seconds
     * after the last one", so a Player that restarts, reconnects, or retries
     * produces the same slots it would have produced anyway instead of a set of
     * overlapping windows the server has to reconcile.
     *
     * Durations are accumulated from the live readings as they happen. They are
     * never inferred afterwards from an average: an average of 70 says nothing
     * about whether a room spent ten seconds at 70 or five at 40 and five at
     * 100, and the difference is the whole point of the two duration fields.
     */
    createHistoryAggregator(settings: {
      warningLevel: number;
      loudLevel: number;
    }): TilecastNoiseHistoryAggregator {
      const loudLevel = clampInteger(settings.loudLevel, 80, 2, 100);
      const warningLevel = Math.min(
        clampInteger(settings.warningLevel, 60, 1, 99),
        loudLevel - 1,
      );
      let startMs = 0;
      let open = false;
      let weightedSum = 0;
      let monitoredMs = 0;
      let warningMs = 0;
      let loudMs = 0;
      let peak = 0;
      let triggerCount = 0;
      let lastLevel: number | null = null;
      let lastAt = 0;

      function slot(atMs: number): number {
        return Math.floor(atMs / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
      }

      function close(): TilecastNoiseHistoryBucket | null {
        if (!open) return null;
        open = false;
        // A slot the microphone never actually covered is not a quiet ten
        // seconds; it is an absence, and it must not be written down as data.
        if (monitoredMs <= 0) {
          reset();
          return null;
        }
        const bucket: TilecastNoiseHistoryBucket = {
          startedAt: new Date(startMs).toISOString(),
          averageLevel: round(weightedSum / monitoredMs),
          peakLevel: round(peak),
          monitoredMs: Math.round(monitoredMs),
          warningMs: Math.round(warningMs),
          loudMs: Math.round(loudMs),
          triggerCount,
        };
        reset();
        return bucket;
      }

      function reset(): void {
        weightedSum = 0;
        monitoredMs = 0;
        warningMs = 0;
        loudMs = 0;
        peak = 0;
        triggerCount = 0;
        lastLevel = null;
      }

      function round(value: number): number {
        if (!Number.isFinite(value)) return 0;
        return Math.round(clampLevel(value) * 10) / 10;
      }

      return {
        push(
          level: number | null,
          atMs: number,
          enteredLoud = false,
        ): TilecastNoiseHistoryBucket | null {
          if (!Number.isFinite(atMs)) return null;
          // An unusable reading ends the current coverage rather than
          // contributing a fabricated value. The bucket keeps whatever real
          // time it did cover.
          if (typeof level !== "number" || !Number.isFinite(level)) {
            lastLevel = null;
            return null;
          }
          const value = clampLevel(level);
          const current = slot(atMs);
          let completed: TilecastNoiseHistoryBucket | null = null;
          if (open && current !== startMs) {
            completed = close();
          }
          if (!open) {
            open = true;
            startMs = current;
            reset();
          }
          if (lastLevel !== null) {
            // Attributed to the reading that held for this interval, and capped
            // so a paused renderer or a suspended machine cannot backfill a
            // whole bucket from one sample.
            const elapsed = Math.min(1_000, Math.max(0, atMs - lastAt));
            if (elapsed > 0) {
              weightedSum += lastLevel * elapsed;
              monitoredMs += elapsed;
              if (lastLevel >= loudLevel) {
                loudMs += elapsed;
              } else if (lastLevel >= warningLevel) {
                warningMs += elapsed;
              }
            }
          }
          peak = Math.max(peak, value);
          if (enteredLoud) triggerCount += 1;
          lastLevel = value;
          lastAt = atMs;
          return completed;
        },
        flush(): TilecastNoiseHistoryBucket | null {
          return close();
        },
        reset(): void {
          open = false;
          reset();
        },
      };
    },

    /**
     * Whether the bar is allowed on screen right now.
     *
     * Half-open [start, end) in the configured zone, and an end at or before
     * the start is an overnight window belonging to the start day — the same
     * daily-window semantics active hours and content schedules use, so an
     * operator who has configured one of those already knows this one.
     *
     * Evaluated locally against the Player's own clock, so a server outage
     * cannot leave the bar showing outside its window or suppressed inside it.
     */
    scheduleOpen(
      settings: Pick<
        TilecastNoiseMeterSettings,
        | "scheduleEnabled"
        | "scheduleDaysOfWeek"
        | "scheduleStartTime"
        | "scheduleEndTime"
        | "scheduleTimezone"
      >,
      at: Date,
    ): boolean {
      // No window means no restriction: the bar shows whenever it is too loud.
      if (!settings.scheduleEnabled) return true;
      const start = parseClockMinutes(settings.scheduleStartTime);
      const end = parseClockMinutes(settings.scheduleEndTime);
      const days = settings.scheduleDaysOfWeek ?? [];
      // An unreadable window fails toward the bar working. A room that is too
      // loud is the condition this plugin exists to show.
      if (start === null || end === null || days.length === 0) return true;
      const local = zonedWeekdayMinutes(settings.scheduleTimezone, at);
      if (!local) return true;
      if (end > start) {
        return (
          days.includes(local.weekday) &&
          local.minutes >= start &&
          local.minutes < end
        );
      }
      // Overnight: the evening part belongs to its own day, and the morning
      // part belongs to the day before it.
      const previousDay = (local.weekday + 6) % 7;
      return (
        (days.includes(local.weekday) && local.minutes >= start) ||
        (days.includes(previousDay) && local.minutes < end)
      );
    },

    historyBucketMs: HISTORY_BUCKET_MS,
  });
})();

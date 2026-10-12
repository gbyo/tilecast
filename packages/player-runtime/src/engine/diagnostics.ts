/**
 * Bounded playback diagnostics.
 *
 * Decoder creation and reuse, occurrence boundaries, seeks and their
 * settlement, drift and unexpected remounts are the facts that explain a
 * grouped video that judders. They are cheap to count and expensive to log, so
 * everything here is a fixed-size counter, a small ring of recent entries, or
 * a rate-limited log line. Nothing grows with uptime and nothing runs per
 * frame. Counters are read through the probe (`describe().engine`); log lines
 * go to whatever sink the host gave the runtime, which in production is the
 * renderer console.
 */
import type { RuntimeClock } from "../clock/scheduler";

export const DIAGNOSTIC_COUNTERS = [
  /** Presentation actors started: one per host presentation. */
  "presentation-actors",
  /** Shared occurrence boundaries handled without replacing the actor. */
  "occurrence-boundaries",
  "decoders-created",
  "decoders-reused",
  /** A decoder was created for media the screen was already showing. */
  "unexpected-remounts",
  "seeks-correction",
  "seeks-occurrence",
  "seeks-settled",
  "seek-timeouts",
  "settle-timeouts",
  "rate-changes",
  "stale-readings",
  "stalls",
  "reuse-failures",
] as const;

export type DiagnosticCounter = (typeof DIAGNOSTIC_COUNTERS)[number];

export interface DiagnosticEntry {
  /** Monotonic milliseconds when it was recorded. */
  atMs: number;
  kind: DiagnosticCounter;
  detail: string;
}

export interface DriftStats {
  samples: number;
  maxAbsMs: number;
  lastMs: number;
  /** Evaluations whose drift exceeded the rate band (80 ms). */
  overRateBand: number;
  /** Evaluations whose drift exceeded the seek band (250 ms). */
  overSeekBand: number;
}

export interface DiagnosticsSnapshot {
  counters: Record<DiagnosticCounter, number>;
  /** Why a decoder could not be reused, by rejection reason. */
  reuseRejected: Record<string, number>;
  drift: DriftStats;
  recent: DiagnosticEntry[];
  /** Log lines dropped by the rate limit. */
  suppressedLogs: number;
}

export interface DiagnosticsOptions {
  clock: RuntimeClock;
  /** Receives rate-limited lines. Absent, nothing is logged. */
  log?: (line: string) => void;
  /** Entries kept for the probe. */
  ringSize?: number;
  /** A given kind is logged at most this often. */
  minLogIntervalMs?: number;
  /** All kinds together are logged at most this many times a minute. */
  logsPerMinute?: number;
}

const DEFAULT_RING = 32;
const DEFAULT_MIN_LOG_MS = 5_000;
const DEFAULT_LOGS_PER_MINUTE = 12;
/** Rejection reasons are a closed set; this bounds the map regardless. */
const MAX_REJECTION_KINDS = 32;

function emptyCounters(): Record<DiagnosticCounter, number> {
  const counters = {} as Record<DiagnosticCounter, number>;
  for (const name of DIAGNOSTIC_COUNTERS) counters[name] = 0;
  return counters;
}

export class PlaybackDiagnostics {
  private counters = emptyCounters();
  private rejected = new Map<string, number>();
  private drifts: DriftStats = {
    samples: 0,
    maxAbsMs: 0,
    lastMs: 0,
    overRateBand: 0,
    overSeekBand: 0,
  };
  private ring: DiagnosticEntry[] = [];
  private readonly lastLoggedAt = new Map<string, number>();
  private windowStartMs = Number.NEGATIVE_INFINITY;
  private windowLogs = 0;
  private suppressed = 0;
  private readonly ringSize: number;
  private readonly minLogIntervalMs: number;
  private readonly logsPerMinute: number;

  constructor(private readonly options: DiagnosticsOptions) {
    this.ringSize = options.ringSize ?? DEFAULT_RING;
    this.minLogIntervalMs = options.minLogIntervalMs ?? DEFAULT_MIN_LOG_MS;
    this.logsPerMinute = options.logsPerMinute ?? DEFAULT_LOGS_PER_MINUTE;
  }

  /** Count an occurrence of something. Never logs. */
  count(counter: DiagnosticCounter, by = 1): void {
    this.counters[counter] += by;
  }

  /**
   * Count and record something worth reading later. It is kept in the ring and
   * logged, subject to the rate limits.
   */
  note(
    counter: DiagnosticCounter,
    detail: Record<string, string | number | boolean | null>,
  ): void {
    this.count(counter);
    const text = Object.entries(detail)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    this.record({
      atMs: this.options.clock.monotonicNow(),
      kind: counter,
      detail: text,
    });
    this.log(counter, `playback ${counter} ${text}`);
  }

  /** A decoder could not be reused, and why. Counted, never logged here. */
  reuseRejected(reason: string): void {
    if (this.rejected.has(reason) || this.rejected.size < MAX_REJECTION_KINDS) {
      this.rejected.set(reason, (this.rejected.get(reason) ?? 0) + 1);
    }
  }

  /** One drift evaluation. Aggregated only; it is never logged. */
  drift(driftMs: number): void {
    const abs = Math.abs(driftMs);
    this.drifts.samples += 1;
    this.drifts.lastMs = driftMs;
    this.drifts.maxAbsMs = Math.max(this.drifts.maxAbsMs, abs);
    if (abs > 80) this.drifts.overRateBand += 1;
    if (abs > 250) this.drifts.overSeekBand += 1;
  }

  snapshot(): DiagnosticsSnapshot {
    return {
      counters: { ...this.counters },
      reuseRejected: Object.fromEntries(this.rejected),
      drift: { ...this.drifts },
      recent: [...this.ring],
      suppressedLogs: this.suppressed,
    };
  }

  private record(entry: DiagnosticEntry): void {
    this.ring.push(entry);
    if (this.ring.length > this.ringSize) this.ring.shift();
  }

  private log(kind: string, line: string): void {
    const sink = this.options.log;
    if (!sink) return;
    const now = this.options.clock.monotonicNow();
    const last = this.lastLoggedAt.get(kind);
    if (last !== undefined && now - last < this.minLogIntervalMs) {
      this.suppressed += 1;
      return;
    }
    if (now - this.windowStartMs >= 60_000) {
      this.windowStartMs = now;
      this.windowLogs = 0;
    }
    if (this.windowLogs >= this.logsPerMinute) {
      this.suppressed += 1;
      return;
    }
    this.windowLogs += 1;
    this.lastLoggedAt.set(kind, now);
    sink(line);
  }
}

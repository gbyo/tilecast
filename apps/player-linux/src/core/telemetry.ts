/**
 * Bounded telemetry reporting.
 *
 * The player measures continuously but reports on a fixed cadence, sending the
 * latest value of each gauge and the accumulated delta of each counter since
 * the previous sample. Raw high-frequency samples are never uploaded and never
 * stored: the server keeps one snapshot row per screen and five-minute
 * rollups, and both are bounded.
 *
 * Threshold events are the server's job. The player reports measurements; the
 * server owns the hysteresis and cooldowns, so a player that restarts cannot
 * re-announce every condition it was already in.
 *
 * A measurement this player cannot make is omitted, never sent as zero. The
 * server distinguishes the two, and the difference is the whole reason a screen
 * that cannot read its own luminance is not reported as a black screen.
 */

import type { ApiClient } from "./api";
import { logger } from "./log";

const log = logger("telemetry");

/** Matches the server's rollup bucket. */
export const TELEMETRY_INTERVAL_MS = 60_000;

export interface TelemetryGauges {
  currentItemId?: string;
  itemStartedAt?: string;
  lastMeaningfulProgressAt?: string;
  playbackStallDurationMs?: number;
  stallReason?: string;
  rendererState?: string;
  rendererResponding?: boolean;
  expectedMotion?: boolean;
  serverRoundTripMs?: number;
  downloadQueueCount?: number;
  bytesRemaining?: number;
  cacheUsedBytes?: number;
  cacheLimitBytes?: number;
  freeStorageBytes?: number;
  processUptimeSeconds?: number;
  deviceUptimeSeconds?: number;
  syncGroupDriftMs?: number;
  frameFingerprint?: string;
  averageLuminance?: number;
  thermalState?: string;
  memoryPressureState?: string;

  /**
   * Network path. Deliberately the link and not the network: no SSID, host,
   * address, or URL is reported, because a fleet-wide table is the wrong place
   * for any of them and the server rejects them anyway.
   */
  networkLinkType?: "ethernet" | "wifi" | "cellular" | "other" | "unknown";
  wifiSignalDbm?: number;
  wifiLinkSpeedMbps?: number;
  gatewayReachable?: boolean;
  captivePortalSuspected?: boolean;
  lastDisconnectReason?: DisconnectReason;

  /** Display and power: how a dark panel is told apart from a dead player. */
  displayConnected?: boolean;
  displayResolution?: string;
  displayRefreshHz?: number;
  displayPowerState?: "on" | "standby" | "off" | "unknown";
  lastShutdownReason?: ShutdownReason;
  powerSource?: "mains" | "battery" | "ups" | "unknown";
  batteryPercent?: number;

  /** Offline scheduling runs on the device clock, so drift is a real fault. */
  clockOffsetSeconds?: number;
  timeSyncState?: "synchronized" | "unsynchronized" | "unknown";

  /** One set per boot, so a slow recovery is attributable to a phase. */
  startupTotalMs?: number;
  startupConfigMs?: number;
  startupManifestMs?: number;
  startupAssetVerifyMs?: number;
  startupFirstFrameMs?: number;

  videoDecoderPath?: "hardware" | "software" | "mixed" | "unknown";
  videoDecodedResolution?: string;
}

/**
 * The categories the server accepts. They are categories rather than messages
 * on purpose: an operator needs to know which class of failure happened, and
 * the text that produced it belongs in this player's own log.
 */
export type DisconnectReason =
  | "network_lost"
  | "server_unreachable"
  | "timeout"
  | "tls_failure"
  | "credential_rejected"
  | "server_closed"
  | "client_closed"
  | "process_restart"
  | "unknown";

export type ShutdownReason =
  | "clean"
  | "power_loss"
  | "kernel_panic"
  | "thermal"
  | "watchdog"
  | "update"
  | "unknown";

/** Counters accumulated between samples, then reset. */
interface Counters {
  connectedSeconds: number;
  disconnectedSeconds: number;
  healthyPlaybackSeconds: number;
  stalledPlaybackSeconds: number;
  blackOutputSeconds: number;
  droppedFrames: number;
  frameChangeCount: number;
  downloadedBytes: number;
  cacheHits: number;
  cacheMisses: number;
  consecutiveDownloadFailures: number;
  httpRequestCount: number;
  httpFailureCount: number;
  httpClientErrorCount: number;
  httpServerErrorCount: number;
  requestRetryCount: number;
  socketReconnectCount: number;
  networkInterfaceChangeCount: number;
  jankFrameCount: number;
  rendererCrashCount: number;
  surfaceLostCount: number;
  decoderInitFailureCount: number;
  cacheEvictionCount: number;
  cacheEvictedBytes: number;
  integrityFailureCount: number;
  downloadResumeCount: number;
  downloadFailureCount: number;
  unexpectedRebootCount: number;
  displaySleepCount: number;
  displayWakeCount: number;
  thermalSeconds: Record<string, number>;
  syncDriftSamples: number[];
  memorySamples: number[];
  cpuSamples: number[];
  timeToFirstByteSamples: number[];
  throughputSamples: number[];
  frameTimeSamples: number[];
}

/** The sample sets, named so a caller cannot record into the wrong one. */
export type TelemetrySampleKind =
  | "syncDrift"
  | "memory"
  | "cpu"
  | "timeToFirstByte"
  | "throughput"
  | "frameTime";

const SAMPLE_SETS: Record<TelemetrySampleKind, keyof Counters> = {
  syncDrift: "syncDriftSamples",
  memory: "memorySamples",
  cpu: "cpuSamples",
  timeToFirstByte: "timeToFirstByteSamples",
  throughput: "throughputSamples",
  frameTime: "frameTimeSamples",
};

function emptyCounters(): Counters {
  return {
    connectedSeconds: 0,
    disconnectedSeconds: 0,
    healthyPlaybackSeconds: 0,
    stalledPlaybackSeconds: 0,
    blackOutputSeconds: 0,
    droppedFrames: 0,
    frameChangeCount: 0,
    downloadedBytes: 0,
    cacheHits: 0,
    cacheMisses: 0,
    consecutiveDownloadFailures: 0,
    httpRequestCount: 0,
    httpFailureCount: 0,
    httpClientErrorCount: 0,
    httpServerErrorCount: 0,
    requestRetryCount: 0,
    socketReconnectCount: 0,
    networkInterfaceChangeCount: 0,
    jankFrameCount: 0,
    rendererCrashCount: 0,
    surfaceLostCount: 0,
    decoderInitFailureCount: 0,
    cacheEvictionCount: 0,
    cacheEvictedBytes: 0,
    integrityFailureCount: 0,
    downloadResumeCount: 0,
    downloadFailureCount: 0,
    unexpectedRebootCount: 0,
    displaySleepCount: 0,
    displayWakeCount: 0,
    thermalSeconds: {},
    syncDriftSamples: [],
    memorySamples: [],
    cpuSamples: [],
    timeToFirstByteSamples: [],
    throughputSamples: [],
    frameTimeSamples: [],
  };
}

/** Percentile from an unsorted sample set; the caller may pass an empty one. */
export function percentile(
  values: number[],
  fraction: number,
): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index];
}

function mean(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function maximum(values: number[]): number | undefined {
  return values.length > 0 ? Math.max(...values) : undefined;
}

/** One request's outcome, as the HTTP client sees it. */
export interface RequestOutcome {
  /** Absent when the request never got a response at all. */
  status?: number;
  /** Milliseconds until the response headers arrived. */
  timeToFirstByteMs?: number;
  /** Body size and elapsed time, for throughput. Both or neither. */
  bytes?: number;
  durationMs?: number;
  /** True when this attempt followed a previous failed one. */
  retry?: boolean;
}

export class TelemetryReporter {
  private counters = emptyCounters();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private flushing = false;
  private lastFlushMs: number;
  /** Bounded so a long outage cannot grow the in-memory sample sets. */
  private static readonly MAX_SAMPLES = 600;

  constructor(
    private readonly client: ApiClient,
    private readonly gauges: () => TelemetryGauges,
    private readonly now: () => number,
  ) {
    this.lastFlushMs = now();
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.flush(), TELEMETRY_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Adds elapsed seconds to a counter. Called by the player's own tick. */
  addSeconds(counter: keyof Counters, seconds: number): void {
    if (seconds <= 0) return;
    const current = this.counters[counter];
    if (typeof current === "number") {
      (this.counters[counter] as number) = current + seconds;
    }
  }

  addCount(counter: keyof Counters, amount: number): void {
    this.addSeconds(counter, amount);
  }

  recordThermalSeconds(state: string, seconds: number): void {
    if (!state || seconds <= 0) return;
    this.counters.thermalSeconds[state] =
      (this.counters.thermalSeconds[state] ?? 0) + seconds;
  }

  recordSample(kind: TelemetrySampleKind, value: number): void {
    if (!Number.isFinite(value)) return;
    const target = this.counters[SAMPLE_SETS[kind]] as number[];
    if (target.length >= TelemetryReporter.MAX_SAMPLES) {
      // Drop the oldest rather than grow without bound; the percentiles stay
      // representative and memory stays flat.
      target.shift();
    }
    target.push(value);
  }

  /**
   * One HTTP request's outcome. Kept in one place so the counters cannot
   * disagree with each other: every request counts once, and a request that
   * failed counts as a failure exactly once whether it failed at the socket or
   * with a status code.
   */
  recordRequest(outcome: RequestOutcome): void {
    this.counters.httpRequestCount += 1;
    if (outcome.retry) {
      this.counters.requestRetryCount += 1;
    }
    const status = outcome.status;
    if (status === undefined) {
      // No response at all: a network failure, with no class to attribute it to.
      this.counters.httpFailureCount += 1;
    } else {
      if (status >= 400) {
        this.counters.httpFailureCount += 1;
      }
      if (status >= 400 && status < 500) {
        this.counters.httpClientErrorCount += 1;
      } else if (status >= 500) {
        this.counters.httpServerErrorCount += 1;
      }
    }
    if (outcome.timeToFirstByteMs !== undefined) {
      this.recordSample("timeToFirstByte", outcome.timeToFirstByteMs);
    }
    // Throughput needs both terms, and a duration of zero would divide by it.
    if (
      outcome.bytes !== undefined &&
      outcome.durationMs !== undefined &&
      outcome.durationMs > 0 &&
      outcome.bytes > 0
    ) {
      this.recordSample(
        "throughput",
        (outcome.bytes / outcome.durationMs) * 1_000,
      );
    }
  }

  setConsecutiveDownloadFailures(count: number): void {
    this.counters.consecutiveDownloadFailures = Math.max(0, count);
  }

  /** Sends one sample and resets the counters. Failures drop the sample. */
  async flush(): Promise<void> {
    if (this.stopped || this.flushing) return;
    this.flushing = true;
    try {
      const now = this.now();
      const elapsedSeconds = Math.max(
        0,
        Math.round((now - this.lastFlushMs) / 1000),
      );
      const counters = this.counters;
      this.counters = emptyCounters();
      this.lastFlushMs = now;

      const drift = counters.syncDriftSamples.map(Math.abs);
      const sample = {
        observedAt: new Date(now).toISOString(),
        ...this.gauges(),
        interval: {
          seconds: elapsedSeconds,
          connectedSeconds: Math.round(counters.connectedSeconds),
          disconnectedSeconds: Math.round(counters.disconnectedSeconds),
          healthyPlaybackSeconds: Math.round(counters.healthyPlaybackSeconds),
          stalledPlaybackSeconds: Math.round(counters.stalledPlaybackSeconds),
          blackOutputSeconds: Math.round(counters.blackOutputSeconds),
          droppedFrames: counters.droppedFrames,
          frameChangeCount: counters.frameChangeCount,
          downloadedBytes: counters.downloadedBytes,
          cacheHits: counters.cacheHits,
          cacheMisses: counters.cacheMisses,
          consecutiveDownloadFailures: counters.consecutiveDownloadFailures,
          averageMemoryBytes: mean(counters.memorySamples),
          peakMemoryBytes: maximum(counters.memorySamples),
          averageCpuPercent: mean(counters.cpuSamples),
          thermalSeconds: counters.thermalSeconds,
          syncDriftP50Ms: percentile(drift, 0.5),
          syncDriftP95Ms: percentile(drift, 0.95),
          syncDriftMaxMs: maximum(drift),

          httpRequestCount: counters.httpRequestCount,
          httpFailureCount: counters.httpFailureCount,
          httpClientErrorCount: counters.httpClientErrorCount,
          httpServerErrorCount: counters.httpServerErrorCount,
          requestRetryCount: counters.requestRetryCount,
          socketReconnectCount: counters.socketReconnectCount,
          networkInterfaceChangeCount: counters.networkInterfaceChangeCount,
          timeToFirstByteP95Ms: percentile(counters.timeToFirstByteSamples, 0.95),
          averageThroughputBytesPerSecond: mean(counters.throughputSamples),

          frameTimeP95Ms: percentile(counters.frameTimeSamples, 0.95),
          frameTimeP99Ms: percentile(counters.frameTimeSamples, 0.99),
          jankFrameCount: counters.jankFrameCount,
          rendererCrashCount: counters.rendererCrashCount,
          surfaceLostCount: counters.surfaceLostCount,
          decoderInitFailureCount: counters.decoderInitFailureCount,

          cacheEvictionCount: counters.cacheEvictionCount,
          cacheEvictedBytes: counters.cacheEvictedBytes,
          integrityFailureCount: counters.integrityFailureCount,
          downloadResumeCount: counters.downloadResumeCount,
          downloadFailureCount: counters.downloadFailureCount,

          unexpectedRebootCount: counters.unexpectedRebootCount,
          displaySleepCount: counters.displaySleepCount,
          displayWakeCount: counters.displayWakeCount,
        },
      };

      try {
        await this.client.postTelemetry(sample);
      } catch {
        // Telemetry is not proof of play. A dropped sample loses a minute of
        // detail; buffering it would trade that for unbounded memory on a
        // player that has been offline for hours.
        log.debug("telemetry sample dropped");
      }
    } finally {
      this.flushing = false;
    }
  }
}

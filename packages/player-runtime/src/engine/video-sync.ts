/**
 * Drift correction for a video held on a group's shared timeline, with none of
 * the DOM.
 *
 * The playback policy bands a drift reading (`videoSyncCorrection`). That is
 * enough only when the reading can be trusted and a correction takes effect at
 * once. On a slow media pipeline neither is true: a seek takes hundreds of
 * milliseconds, `currentTime` then sits at the seek target until the pipeline
 * has prerolled and restarted its clock, and the value itself can be coarse or
 * stale. A corrector that reads drift during that time sees the gap growing,
 * decides the previous correction failed and seeks again, which restarts the
 * very delay it is measuring. Measured against a model of such a pipeline, the
 * previous cooldown-only loop issued a seek every second for a minute and left
 * the picture frozen for all but a quarter of a second of it.
 *
 * This corrector keeps the same thresholds and adds what a correction needs to
 * be safe to repeat:
 *
 *  - a seek is a state, not a moment: nothing is measured until the element
 *    has finished seeking and its media time has been seen to advance;
 *  - a reading that has not changed is stale, not drift, and is never acted on;
 *  - a correction needs two agreeing readings, so one coarse sample cannot
 *    trigger it;
 *  - the playback-rate nudge has hysteresis and a dwell, so a reading that
 *    hovers at a band edge does not flip the rate on every evaluation (on a
 *    GStreamer pipeline a rate change can flush the pipeline);
 *  - seeks back off when they do not converge, and aim a measured seek latency
 *    ahead so they can land.
 *
 * Time comes in through the observation. The caller applies the decision.
 */
import {
  SYNC_FAST_RATE,
  SYNC_IGNORE_DRIFT_MS,
  SYNC_RATE_DRIFT_MS,
  SYNC_SEEK_COOLDOWN_MS,
  SYNC_SLOW_RATE,
} from "./playback-policy";

/** A nudge ends when drift falls below this, so it does not chatter. */
export const SYNC_RATE_EXIT_DRIFT_MS = 40;
/** The playback rate changes at most this often. */
export const SYNC_RATE_DWELL_MS = 1_000;
/** A seek that has not completed after this long is given up on. */
export const SYNC_SEEK_TIMEOUT_MS = 5_000;
/** After `seeked`, media time must advance for at least this long. */
export const SYNC_SETTLE_MIN_MS = 500;
/** Media time must be seen advancing on this many consecutive evaluations. */
export const SYNC_SETTLE_ADVANCES = 2;
/** Settling that has not produced advancing media after this long ends. */
export const SYNC_SETTLE_TIMEOUT_MS = 4_000;
/** Agreeing readings needed before a correction. */
export const SYNC_CONFIRM_SAMPLES = 2;
/** Readings older than this no longer confirm a correction. */
export const SYNC_READING_WINDOW_MS = 1_500;
/** An unchanged `currentTime` is stale once this much time has passed. */
export const SYNC_STALE_MS = 200;
/** Unchanged this long, the video is stalled, not merely late. */
export const SYNC_STALL_MS = 3_000;
/** A presented frame older than this no longer says where the video is. */
export const SYNC_FRAME_FRESH_MS = 400;
/** Reads kept to judge whether `currentTime` is reported in coarse steps. */
const GRANULARITY_WINDOW = 8;
/** A clock unchanged on this share of reads is reported in coarse steps. */
const COARSE_FLAT_SHARE = 0.25;
/** The coarsest step that is still modeled; beyond it a reading is noise. */
const MAX_GRANULARITY_MS = 600;
/** The seek cooldown doubles per unconverged seek, up to this. */
export const SYNC_MAX_SEEK_COOLDOWN_MS = 8_000;
/** This long inside the seek band clears the backoff. */
export const SYNC_HEALTHY_RESET_MS = 3_000;
/** A seek aims at most this far ahead of the shared position. */
export const SYNC_MAX_LEAD_MS = 2_000;
/** Seek latencies below this are measurement noise and are not led. */
const MIN_LEAD_MS = 150;
/** A seek this close to the clip's end is not worth making. */
const END_GUARD_MS = 100;

export interface MediaObservation {
  nowMs: number;
  currentTimeMs: number;
  seeking: boolean;
  paused: boolean;
  /** Metadata is available, so a seek is meaningful. */
  ready: boolean;
  playbackRate: number;
  /** Media time past which a seek target is meaningless, if known. */
  limitMs?: number | null;
}

export type SyncStateName =
  | "unready"
  | "paused"
  | "seek-pending"
  | "settling"
  | "stale"
  | "stalled"
  | "confirming"
  | "in-band"
  | "nudging"
  | "cooldown"
  | "near-end"
  | "seek";

export interface SyncDecision {
  action: "none" | "rate" | "seek";
  playbackRate: number;
  seekToMs: number | null;
  state: SyncStateName;
  /** The drift the decision rests on; null when none could be measured. */
  driftMs: number | null;
}

export type SyncEvent =
  | {
      type: "seek";
      driftMs: number;
      toMs: number;
      leadMs: number;
      consecutive: number;
    }
  | { type: "seek-settled"; latencyMs: number; kind: SeekKind }
  | { type: "seek-timeout"; kind: SeekKind }
  | { type: "settle-timeout"; kind: SeekKind }
  | { type: "rate"; rate: number; driftMs: number }
  | { type: "stale"; stalled: boolean };

export type SeekKind = "correction" | "occurrence";

interface Sample {
  currentTimeMs: number;
  nowMs: number;
}

export class VideoSyncCorrector {
  private phase: "tracking" | "seeking" | "settling" = "tracking";
  private seekKind: SeekKind = "correction";
  private seekIssuedAtMs = 0;
  private seekedAtMs = 0;
  private advances = 0;
  private resumeEstimateMs: number | null = null;
  private last: Sample | null = null;
  private frame: { mediaMs: number; nowMs: number } | null = null;
  private lastTickFrameMs: number | null = null;
  private recent: { driftMs: number; deadZoneMs: number; atMs: number }[] = [];
  private flats: boolean[] = [];
  private steps: number[] = [];
  private lastDistinctMs: number | null = null;
  private staleReported: "stale" | "stalled" | null = null;
  private rate = 1;
  private rateChangedAtMs = Number.NEGATIVE_INFINITY;
  private consecutiveSeeks = 0;
  private nextSeekAtMs = Number.NEGATIVE_INFINITY;
  private healthySinceMs: number | null = null;
  private staleSinceMs: number | null = null;
  private latencyMs = 0;

  constructor(private readonly listener?: (event: SyncEvent) => void) {}

  /** The latest seek latency, for aiming seeks; 0 until one was measured. */
  get leadMs(): number {
    return this.latencyMs >= MIN_LEAD_MS
      ? Math.min(this.latencyMs, SYNC_MAX_LEAD_MS)
      : 0;
  }

  /** A presented frame: where it was in media time, and when. */
  frameSample(mediaMs: number, nowMs: number): void {
    this.frame = { mediaMs, nowMs };
  }

  /**
   * The caller is about to seek for a reason other than a correction (the
   * element moves to the next occurrence of the same video). Nothing is
   * measured until that seek has settled.
   */
  expectSeek(nowMs: number): void {
    this.enterSeeking("occurrence", nowMs);
    this.rate = 1;
    this.rateChangedAtMs = nowMs;
  }

  /** The seek the decision asked for could not be issued. */
  abortSeek(nowMs: number): void {
    this.phase = "tracking";
    this.nextSeekAtMs = nowMs + this.cooldownMs();
  }

  /**
   * `seeked` fired. `currentTimeMs` is where the element stood then: the first
   * evaluation after it can then tell whether media time has moved at all.
   */
  seeked(nowMs: number, currentTimeMs?: number): void {
    if (this.phase !== "seeking") return;
    this.phase = "settling";
    this.seekedAtMs = nowMs;
    this.advances = 0;
    this.resumeEstimateMs = null;
    this.last = currentTimeMs === undefined ? null : { currentTimeMs, nowMs };
    this.lastTickFrameMs = null;
  }

  correct(obs: MediaObservation, expectedMs: number): SyncDecision {
    const now = obs.nowMs;
    if (!obs.ready) return this.hold("unready");

    // Something other than a correction is seeking (the element's start
    // offset, a loop). Nothing it reports is a reading until it has finished.
    if (obs.seeking && this.phase === "tracking") {
      this.recent = [];
      return this.hold("seek-pending");
    }

    if (this.phase === "seeking") {
      if (obs.seeking) {
        if (now - this.seekIssuedAtMs > SYNC_SEEK_TIMEOUT_MS) {
          this.emit({ type: "seek-timeout", kind: this.seekKind });
          this.phase = "tracking";
          this.nextSeekAtMs = now + this.cooldownMs();
        }
        return this.hold("seek-pending");
      }
      // The element is no longer seeking and the event has not been seen.
      this.seeked(now, obs.currentTimeMs);
    }

    if (this.phase === "settling") return this.settle(obs);

    if (obs.paused) {
      this.recent = [];
      this.last = null;
      return this.hold("paused");
    }

    const reading = this.read(obs);
    if (reading.kind !== "ok") return this.hold(reading.kind);
    this.recent = this.recent.filter(
      (sample) => now - sample.atMs <= SYNC_READING_WINDOW_MS,
    );
    this.recent.push({
      driftMs: expectedMs - reading.actualMs,
      deadZoneMs: reading.uncertaintyMs,
      atMs: now,
    });
    if (this.recent.length > SYNC_CONFIRM_SAMPLES) this.recent.shift();
    if (this.recent.length < SYNC_CONFIRM_SAMPLES) {
      return this.hold("confirming");
    }
    const drift = this.agreedDrift();
    const abs = Math.abs(drift);

    if (abs <= SYNC_RATE_DRIFT_MS) {
      this.healthySinceMs ??= now;
      if (now - this.healthySinceMs >= SYNC_HEALTHY_RESET_MS) {
        this.consecutiveSeeks = 0;
      }
    } else {
      this.healthySinceMs = null;
    }

    if (abs > SYNC_RATE_DRIFT_MS && now >= this.nextSeekAtMs) {
      const leadMs = this.leadMs;
      const toMs = Math.max(0, expectedMs + leadMs);
      if (obs.limitMs != null && toMs >= obs.limitMs - END_GUARD_MS) {
        return this.nudge(now, drift, "near-end");
      }
      this.consecutiveSeeks += 1;
      this.enterSeeking("correction", now);
      this.rate = 1;
      this.rateChangedAtMs = now;
      this.emit({
        type: "seek",
        driftMs: drift,
        toMs,
        leadMs,
        consecutive: this.consecutiveSeeks,
      });
      return {
        action: "seek",
        playbackRate: 1,
        seekToMs: toMs,
        state: "seek",
        driftMs: drift,
      };
    }
    return this.nudge(
      now,
      drift,
      abs > SYNC_RATE_DRIFT_MS
        ? "cooldown"
        : this.rate !== 1 || abs > SYNC_IGNORE_DRIFT_MS
          ? "nudging"
          : "in-band",
    );
  }

  private settle(obs: MediaObservation): SyncDecision {
    const now = obs.nowMs;
    const previous = this.last;
    this.last = { currentTimeMs: obs.currentTimeMs, nowMs: now };
    const frameMs =
      this.frame && this.frame.nowMs >= this.seekedAtMs
        ? this.frame.mediaMs
        : null;
    const previousFrameMs = this.lastTickFrameMs;
    this.lastTickFrameMs = frameMs;
    if (previous && !obs.paused) {
      // Media time moving forward is the evidence. It need not move on every
      // evaluation: a coarse clock steps less often than it is read.
      const forward =
        obs.currentTimeMs > previous.currentTimeMs ||
        (frameMs !== null &&
          previousFrameMs !== null &&
          frameMs > previousFrameMs);
      if (obs.currentTimeMs < previous.currentTimeMs) {
        // Backwards: another seek or a loop moved it. Start counting again.
        this.advances = 0;
        this.resumeEstimateMs = null;
      } else if (forward) {
        // Media time moved somewhere in (previous, now]. The last moment it
        // is known not to have moved is the safe estimate: a seek aimed that
        // far ahead can fall short by at most one evaluation, never overshoot.
        if (this.advances === 0) this.resumeEstimateMs = previous.nowMs;
        this.advances += 1;
      }
    }
    if (
      this.advances >= SYNC_SETTLE_ADVANCES &&
      now - this.seekedAtMs >= SYNC_SETTLE_MIN_MS
    ) {
      const latencyMs = Math.max(
        0,
        (this.resumeEstimateMs ?? now) - this.seekIssuedAtMs,
      );
      this.latencyMs = latencyMs;
      const kind = this.seekKind;
      this.finishSeek(now);
      this.emit({ type: "seek-settled", latencyMs, kind });
    } else if (now - this.seekedAtMs > SYNC_SETTLE_TIMEOUT_MS) {
      const kind = this.seekKind;
      this.finishSeek(now);
      this.emit({ type: "settle-timeout", kind });
    }
    return this.hold("settling");
  }

  private finishSeek(nowMs: number): void {
    this.phase = "tracking";
    this.recent = [];
    this.last = null;
    this.staleSinceMs = null;
    // Measured from here: a seek that did not converge is not repeated at
    // once, and each one that fails to converge waits twice as long.
    this.nextSeekAtMs =
      this.seekKind === "correction"
        ? nowMs + this.cooldownMs()
        : Number.NEGATIVE_INFINITY;
  }

  private enterSeeking(kind: SeekKind, nowMs: number): void {
    this.phase = "seeking";
    this.seekKind = kind;
    this.seekIssuedAtMs = nowMs;
    this.advances = 0;
    this.resumeEstimateMs = null;
    this.recent = [];
    this.last = null;
    this.frame = null;
    this.healthySinceMs = null;
    this.staleSinceMs = null;
    this.staleReported = null;
    this.flats = [];
    this.steps = [];
    this.lastDistinctMs = null;
  }

  private read(
    obs: MediaObservation,
  ):
    | { kind: "ok"; actualMs: number; uncertaintyMs: number }
    | { kind: "stale" | "stalled" } {
    const now = obs.nowMs;
    const previous = this.last;
    this.last = { currentTimeMs: obs.currentTimeMs, nowMs: now };
    const unchanged =
      previous !== null &&
      obs.currentTimeMs === previous.currentTimeMs &&
      now - previous.nowMs >= SYNC_STALE_MS;
    if (previous && now - previous.nowMs >= SYNC_STALE_MS / 2) {
      this.flats.push(unchanged);
      if (this.flats.length > GRANULARITY_WINDOW) this.flats.shift();
    }
    if (!unchanged) {
      this.staleSinceMs = null;
      this.staleReported = null;
      if (
        this.lastDistinctMs !== null &&
        obs.currentTimeMs > this.lastDistinctMs
      ) {
        this.steps.push(obs.currentTimeMs - this.lastDistinctMs);
        if (this.steps.length > 4) this.steps.shift();
      }
      this.lastDistinctMs = obs.currentTimeMs;
      // A clock reported in steps lags the media by somewhere in [0, step).
      // Add half a step and treat half a step either side as unknowable, so a
      // reading that is merely old is never mistaken for drift.
      const step = this.granularityMs();
      return {
        kind: "ok",
        actualMs: obs.currentTimeMs + step / 2,
        uncertaintyMs: step / 2,
      };
    }
    // The media clock did not move. A frame that was presented recently still
    // says where the picture is, so it can stand in; otherwise there is no
    // reading, and a missing reading is not drift.
    const frame = this.frame;
    if (
      frame &&
      now - frame.nowMs <= SYNC_FRAME_FRESH_MS &&
      frame.mediaMs > obs.currentTimeMs
    ) {
      this.staleSinceMs = null;
      this.staleReported = null;
      return {
        kind: "ok",
        actualMs: frame.mediaMs + (now - frame.nowMs) * obs.playbackRate,
        uncertaintyMs: 0,
      };
    }
    this.staleSinceMs ??= previous.nowMs;
    const staleForMs = now - this.staleSinceMs;
    const stalled = staleForMs >= SYNC_STALL_MS;
    const kind = stalled ? "stalled" : "stale";
    // Reported once it is no longer a coarse clock between steps, and again
    // when it becomes a stall: not on every evaluation, and not for a clock
    // that is merely unchanged between two of its steps. An unchanged reading
    // is skipped, not discarded, so a coarse clock still confirms a real drift.
    const report = stalled ? "stalled" : staleForMs >= 1_000 ? "stale" : null;
    if (report && this.staleReported !== report) {
      this.staleReported = report;
      this.emit({ type: "stale", stalled });
    }
    return { kind };
  }

  /** The step `currentTime` is reported in; 0 when it is read continuously. */
  private granularityMs(): number {
    const flat = this.flats.filter(Boolean).length;
    if (
      this.flats.length < 4 ||
      flat / this.flats.length < COARSE_FLAT_SHARE ||
      this.steps.length === 0
    ) {
      return 0;
    }
    const mean =
      this.steps.reduce((sum, step) => sum + step, 0) / this.steps.length;
    return Math.min(mean, MAX_GRANULARITY_MS);
  }

  /** The drift the recent readings agree on; none when they disagree. */
  private agreedDrift(): number {
    const values = this.recent.map((sample) => sample.driftMs);
    const positive = values.every((value) => value > 0);
    const negative = values.every((value) => value < 0);
    if (!positive && !negative) return 0;
    const deadZone = Math.max(...this.recent.map((s) => s.deadZoneMs));
    const smallest = Math.max(0, Math.min(...values.map(Math.abs)) - deadZone);
    return positive ? smallest : -smallest;
  }

  private nudge(
    nowMs: number,
    driftMs: number,
    state: SyncStateName,
  ): SyncDecision {
    const abs = Math.abs(driftMs);
    let desired = this.rate;
    if (this.rate === 1) {
      if (abs > SYNC_IGNORE_DRIFT_MS) {
        desired = driftMs > 0 ? SYNC_FAST_RATE : SYNC_SLOW_RATE;
      }
    } else {
      const sameSide = this.rate > 1 === driftMs > 0;
      if (abs < SYNC_RATE_EXIT_DRIFT_MS || !sameSide) desired = 1;
    }
    if (
      desired !== this.rate &&
      nowMs - this.rateChangedAtMs >= SYNC_RATE_DWELL_MS
    ) {
      this.rate = desired;
      this.rateChangedAtMs = nowMs;
      this.emit({ type: "rate", rate: desired, driftMs });
      return {
        action: "rate",
        playbackRate: desired,
        seekToMs: null,
        state,
        driftMs,
      };
    }
    return {
      action: "none",
      playbackRate: this.rate,
      seekToMs: null,
      state,
      driftMs,
    };
  }

  private hold(state: SyncStateName): SyncDecision {
    return {
      action: "none",
      playbackRate: this.rate,
      seekToMs: null,
      state,
      driftMs: null,
    };
  }

  private cooldownMs(): number {
    const doublings = Math.max(this.consecutiveSeeks - 1, 0);
    return Math.min(
      SYNC_SEEK_COOLDOWN_MS * 2 ** doublings,
      SYNC_MAX_SEEK_COOLDOWN_MS,
    );
  }

  private emit(event: SyncEvent): void {
    this.listener?.(event);
  }
}

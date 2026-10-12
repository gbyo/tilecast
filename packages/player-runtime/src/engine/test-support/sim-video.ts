/**
 * A deterministic model of a video element that is hard to keep in sync: the
 * kind of media pipeline an old Linux box gives you. It exists so drift
 * correction can be measured, not guessed at: a policy is run against it on a
 * manual timeline and judged by the seeks it issues and how long the picture
 * stood still.
 *
 * This is a model, not hardware. It reproduces three behaviors reported from
 * GStreamer-backed engines and nothing else:
 *
 *  - a seek is not instant: `seeking` stays true for `seekLatencyMs`;
 *  - after the seek completes, `currentTime` stays at the seek target for
 *    `resumeDelayMs` while the pipeline prerolls and starts the clock again;
 *  - `currentTime` is reported in coarse steps (`quantumMs`) and can lag.
 */

export interface SimVideoOptions {
  /** Where the clip stands at t = 0. */
  startMs?: number;
  seekLatencyMs?: number;
  resumeDelayMs?: number;
  /** `currentTime` granularity; 0 reports the exact position. */
  quantumMs?: number;
  /** Throughput relative to real time; below 1 the decoder cannot keep up. */
  speed?: number;
}

export class SimVideo {
  positionMs: number;
  seeks = 0;
  /** Time the picture was frozen: seeking or waiting to resume. */
  frozenMs = 0;
  rateChanges = 0;
  playbackRate = 1;
  private seekingUntilMs = 0;
  private frozenUntilMs = 0;
  private reportedMs: number;
  private readonly seekLatencyMs: number;
  private readonly resumeDelayMs: number;
  private readonly quantumMs: number;
  private readonly speed: number;
  /** Fired when a seek completes, as the `seeked` event would be. */
  onSeeked: (() => void) | null = null;
  private seekPending = false;

  constructor(options: SimVideoOptions = {}) {
    this.positionMs = options.startMs ?? 0;
    this.reportedMs = this.positionMs;
    this.seekLatencyMs = options.seekLatencyMs ?? 0;
    this.resumeDelayMs = options.resumeDelayMs ?? 0;
    this.quantumMs = options.quantumMs ?? 0;
    this.speed = options.speed ?? 1;
  }

  seeking(nowMs: number): boolean {
    return nowMs < this.seekingUntilMs;
  }

  seek(toMs: number, nowMs: number): void {
    this.seeks += 1;
    this.positionMs = toMs;
    this.reportedMs = toMs;
    this.seekingUntilMs = nowMs + this.seekLatencyMs;
    this.frozenUntilMs = this.seekingUntilMs + this.resumeDelayMs;
    this.seekPending = true;
  }

  setRate(rate: number): void {
    if (rate === this.playbackRate) return;
    this.playbackRate = rate;
    this.rateChanges += 1;
  }

  /** Advance the model by `dtMs`, ending at `nowMs`. */
  step(dtMs: number, nowMs: number): void {
    const frozenFor = Math.max(
      0,
      Math.min(nowMs, this.frozenUntilMs) - (nowMs - dtMs),
    );
    this.frozenMs += frozenFor;
    if (this.seekPending && nowMs >= this.seekingUntilMs) {
      this.seekPending = false;
      this.onSeeked?.();
    }
    const playingMs = dtMs - frozenFor;
    if (playingMs > 0) {
      this.positionMs += playingMs * Math.min(this.playbackRate, this.speed);
    }
    this.reportedMs =
      nowMs < this.frozenUntilMs
        ? this.reportedMs
        : this.quantumMs > 0
          ? Math.floor(this.positionMs / this.quantumMs) * this.quantumMs
          : this.positionMs;
  }

  currentTimeMs(): number {
    return this.reportedMs;
  }
}

export interface SimResult {
  seeks: number;
  frozenMs: number;
  rateChanges: number;
  /** Time spent more than 250 ms from the shared position. */
  farMs: number;
  maxAbsDriftMs: number;
  finalDriftMs: number;
}

export interface SimStrategy {
  /** Called once per drift evaluation; returns nothing, mutates the video. */
  tick(input: { video: SimVideo; nowMs: number; expectedMs: number }): void;
  /** Called when the model fires `seeked`. */
  seeked?(nowMs: number, video: SimVideo): void;
}

/**
 * Run `strategy` against `video` for `durationMs`. The shared position starts
 * where the video does and advances at real time. The strategy is evaluated
 * every 250 ms, as the synchronized timeline publishes positions.
 */
export function simulate(
  video: SimVideo,
  strategy: SimStrategy,
  durationMs: number,
  options: { startMs?: number; sharedStartMs?: number } = {},
): SimResult {
  const start = options.startMs ?? 0;
  const sharedStart = options.sharedStartMs ?? video.positionMs;
  const STEP = 50;
  let nowMs = start;
  let farMs = 0;
  let maxAbs = 0;
  video.onSeeked = () => strategy.seeked?.(nowMs, video);
  for (let elapsed = 0; elapsed < durationMs; elapsed += STEP) {
    nowMs += STEP;
    video.step(STEP, nowMs);
    const expectedMs = sharedStart + (nowMs - start);
    const drift = Math.abs(expectedMs - video.positionMs);
    maxAbs = Math.max(maxAbs, drift);
    if (drift > 250) farMs += STEP;
    if (elapsed % 250 === 200) {
      strategy.tick({ video, nowMs, expectedMs });
    }
  }
  const finalExpected = sharedStart + (nowMs - start);
  return {
    seeks: video.seeks,
    frozenMs: video.frozenMs,
    rateChanges: video.rateChanges,
    farMs,
    maxAbsDriftMs: maxAbs,
    finalDriftMs: finalExpected - video.positionMs,
  };
}

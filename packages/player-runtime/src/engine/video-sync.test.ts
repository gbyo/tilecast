import { describe, expect, it } from "vitest";
import {
  VideoSyncCorrector,
  type MediaObservation,
  type SyncEvent,
} from "./video-sync";
import {
  newVideoSyncState,
  recordVideoSyncSeek,
  videoSyncCorrection,
} from "./playback-policy";
import {
  SimVideo,
  simulate,
  type SimStrategy,
  type SimVideoOptions,
} from "./test-support/sim-video";

const RUN_MS = 60_000;

/**
 * What the video surface did before settle-aware correction: band the drift,
 * and rely on a fixed one-second cooldown between seeks.
 */
function cooldownOnly(): SimStrategy {
  const state = newVideoSyncState();
  return {
    tick({ video, nowMs, expectedMs }) {
      if (video.seeking(nowMs)) return;
      const c = videoSyncCorrection({
        expectedMs,
        actualMs: video.currentTimeMs(),
        nowMs,
        state,
      });
      video.setRate(c.playbackRate);
      if (c.action === "seek" && c.seekToMs !== null) {
        video.seek(c.seekToMs, nowMs);
        recordVideoSyncSeek(state, nowMs);
      }
    },
  };
}

function run(options: SimVideoOptions, sharedStartMs?: number) {
  const video = new SimVideo(options);
  return simulate(video, cooldownOnly(), RUN_MS, {
    ...(sharedStartMs !== undefined ? { sharedStartMs } : {}),
  });
}

describe("the cooldown-only corrector (before settle-aware correction)", () => {
  it("re-seeks a slow-to-seek pipeline that has not started playing yet", () => {
    // 5 s behind the group; a seek takes 800 ms and playback then needs
    // another 700 ms to resume. At the 1 s cooldown the video is still frozen
    // at the target, looks a second behind, and is seeked again.
    const result = run({ seekLatencyMs: 800, resumeDelayMs: 700 }, 5_000);
    // A seek every second for a minute, with the picture frozen throughout:
    // the correction is what keeps the video from ever playing.
    expect(result.seeks).toBe(60);
    expect(result.frozenMs).toBeGreaterThan(59_000);
  });

  it("acts on a coarse currentTime although the video is in sync", () => {
    const result = run({ quantumMs: 400 });
    // The video is exactly on the shared position the whole time. The
    // corrector acts on the stale reading anyway, and flips the playback rate
    // on most evaluations.
    expect(result.maxAbsDriftMs).toBe(0);
    expect(result.seeks).toBe(30);
    expect(result.rateChanges).toBe(180);
  });

  it("keeps seeking a decoder that cannot sustain real time", () => {
    const result = run(
      { speed: 0.85, seekLatencyMs: 300, resumeDelayMs: 300 },
      0,
    );
    expect(result.seeks).toBe(59);
    expect(result.frozenMs).toBeGreaterThan(35_000);
  });
});

function settleAware() {
  const events: SyncEvent[] = [];
  const corrector = new VideoSyncCorrector((event) => events.push(event));
  const strategy: SimStrategy = {
    tick({ video, nowMs, expectedMs }) {
      const decision = corrector.correct(
        {
          nowMs,
          currentTimeMs: video.currentTimeMs(),
          seeking: video.seeking(nowMs),
          paused: false,
          ready: true,
          playbackRate: video.playbackRate,
        },
        expectedMs,
      );
      video.setRate(decision.playbackRate);
      if (decision.action === "seek" && decision.seekToMs !== null) {
        video.seek(decision.seekToMs, nowMs);
      }
    },
    seeked(nowMs, video) {
      corrector.seeked(nowMs, video.currentTimeMs());
    },
  };
  return { strategy, events, corrector };
}

function runSettleAware(options: SimVideoOptions, sharedStartMs?: number) {
  const video = new SimVideo(options);
  const aware = settleAware();
  const result = simulate(video, aware.strategy, RUN_MS, {
    ...(sharedStartMs !== undefined ? { sharedStartMs } : {}),
  });
  return { ...result, events: aware.events };
}

describe("the settle-aware corrector in simulation", () => {
  it("leaves a video that is exactly on the shared position alone", () => {
    const result = runSettleAware({});
    expect(result.seeks).toBe(0);
    expect(result.rateChanges).toBe(0);
    expect(result.events).toEqual([]);
  });

  it("seeks a slow pipeline once, lets it resume, and lands the second seek", () => {
    // Same pipeline as the cooldown-only run, which seeked 60 times and left
    // the picture frozen for 59.75 s. The first seek teaches the corrector how
    // long a seek takes; the second aims that far ahead and lands on the group.
    const result = runSettleAware(
      { seekLatencyMs: 800, resumeDelayMs: 700 },
      5_000,
    );
    expect(result.seeks).toBe(2);
    expect(result.frozenMs).toBe(3_000);
    expect(Math.abs(result.finalDriftMs)).toBeLessThan(80);
    expect(result.events.filter((e) => e.type === "seek-settled")).toHaveLength(
      2,
    );
  });

  it("does not act on a coarse currentTime when the video is in sync", () => {
    const result = runSettleAware({ quantumMs: 400 });
    expect(result.maxAbsDriftMs).toBe(0);
    expect(result.seeks).toBe(0);
    // Two nudges while the clock's step size is being learned, then none.
    expect(result.rateChanges).toBeLessThanOrEqual(2);
  });

  it("backs off against a decoder that cannot sustain real time", () => {
    const result = runSettleAware(
      { speed: 0.85, seekLatencyMs: 300, resumeDelayMs: 300 },
      0,
    );
    expect(result.seeks).toBeLessThanOrEqual(10);
    expect(result.frozenMs).toBeLessThan(7_000);
  });

  it("is never worse than the cooldown-only loop on any modeled pipeline", () => {
    const pipelines: [SimVideoOptions, number][] = [
      [{ seekLatencyMs: 800, resumeDelayMs: 700 }, 5_000],
      [{ seekLatencyMs: 150, resumeDelayMs: 100 }, 2_000],
      [{ quantumMs: 400 }, 0],
      [{ quantumMs: 250, seekLatencyMs: 400, resumeDelayMs: 400 }, 3_000],
      [{ speed: 0.85, seekLatencyMs: 300, resumeDelayMs: 300 }, 0],
      [{ speed: 0.95 }, 0],
    ];
    for (const [options, shared] of pipelines) {
      const before = run(options, shared);
      const after = runSettleAware(options, shared);
      expect(after.seeks).toBeLessThanOrEqual(before.seeks);
      expect(after.frozenMs).toBeLessThanOrEqual(before.frozenMs);
    }
  });
});

const obs = (
  nowMs: number,
  currentTimeMs: number,
  extra: Partial<MediaObservation> = {},
): MediaObservation => ({
  nowMs,
  currentTimeMs,
  seeking: false,
  paused: false,
  ready: true,
  playbackRate: 1,
  ...extra,
});

/** Drive the corrector at 250 ms with a clock that tracks `expected`. */
function ticker(corrector: VideoSyncCorrector, startMs = 10_000) {
  let now = startMs;
  const at = () => now;
  return {
    now: at,
    step(ms: number) {
      now += ms;
    },
    correct(
      expectedMs: number,
      currentTimeMs: number,
      extra: Partial<MediaObservation> = {},
    ) {
      return corrector.correct(obs(now, currentTimeMs, extra), expectedMs);
    },
  };
}

describe("the settle-aware corrector", () => {
  it("needs two agreeing readings before it corrects", () => {
    const corrector = new VideoSyncCorrector();
    const t = ticker(corrector);
    // One reading 400 ms behind is not enough...
    expect(t.correct(5_400, 5_000).state).toBe("confirming");
    t.step(250);
    // ...a second one that agrees is.
    const decision = t.correct(5_650, 5_250);
    expect(decision.action).toBe("seek");
    expect(decision.seekToMs).toBe(5_650);
  });

  it("does not let one outlier cause a seek", () => {
    const corrector = new VideoSyncCorrector();
    const t = ticker(corrector);
    t.correct(5_000, 5_000);
    t.step(250);
    // A single bad sample 900 ms off, then the video is where it should be.
    expect(t.correct(5_250, 4_350).action).toBe("none");
    t.step(250);
    expect(t.correct(5_500, 5_500).action).toBe("none");
  });

  it("measures nothing while a seek is in flight", () => {
    const corrector = new VideoSyncCorrector();
    const t = ticker(corrector);
    t.correct(8_000, 5_000);
    t.step(250);
    expect(t.correct(8_250, 5_250).action).toBe("seek");
    for (let i = 0; i < 12; i += 1) {
      t.step(250);
      const decision = t.correct(8_500 + i * 250, 8_250, { seeking: true });
      expect(decision.action).toBe("none");
      expect(decision.state).toBe("seek-pending");
    }
  });

  it("waits for media time to advance after seeked before measuring", () => {
    const corrector = new VideoSyncCorrector();
    const t = ticker(corrector);
    t.correct(8_000, 5_000);
    t.step(250);
    t.correct(8_250, 5_250); // seek to 8250
    t.step(250);
    corrector.seeked(t.now());
    // currentTime sits at the target for a second while the pipeline resumes.
    // The shared position moves on; that is not drift to correct.
    for (let i = 0; i < 4; i += 1) {
      t.step(250);
      const decision = t.correct(8_750 + i * 250, 8_250);
      expect(decision.action).toBe("none");
      expect(decision.state).toBe("settling");
    }
    // Media time advances: settled after two forward steps.
    t.step(250);
    t.correct(9_750, 8_400);
    t.step(250);
    t.correct(10_000, 8_650);
    t.step(250);
    expect(t.correct(10_250, 8_900).state).not.toBe("settling");
  });

  it("treats an unchanged currentTime as stale, not as drift", () => {
    const events: SyncEvent[] = [];
    const corrector = new VideoSyncCorrector((e) => events.push(e));
    const t = ticker(corrector);
    t.correct(5_000, 5_000);
    // currentTime stops reporting while the shared position keeps moving.
    for (let i = 1; i <= 14; i += 1) {
      t.step(250);
      const decision = t.correct(5_000 + i * 250, 5_000);
      expect(decision.action).toBe("none");
    }
    // Stalled once it has not moved for three seconds, reported once each.
    expect(events.filter((e) => e.type === "stale")).toEqual([
      { type: "stale", stalled: false },
      { type: "stale", stalled: true },
    ]);
  });

  it("uses a recently presented frame when currentTime is stale", () => {
    const corrector = new VideoSyncCorrector();
    const t = ticker(corrector);
    t.correct(5_000, 5_000);
    t.step(250);
    // currentTime did not move, but frames show the video 5.3 s in.
    corrector.frameSample(5_250, t.now() - 20);
    const decision = t.correct(5_250, 5_000);
    expect(decision.state).not.toBe("stale");
    t.step(250);
    corrector.frameSample(5_500, t.now() - 20);
    expect(t.correct(5_500, 5_000).action).toBe("none");
  });

  it("ignores a frame that is too old to say where the video is", () => {
    const corrector = new VideoSyncCorrector();
    const t = ticker(corrector);
    t.correct(5_000, 5_000);
    t.step(500);
    corrector.frameSample(5_000, t.now() - 450);
    expect(t.correct(5_500, 5_000).state).toBe("stale");
  });

  it("does not chatter the playback rate around a band edge", () => {
    const corrector = new VideoSyncCorrector();
    const t = ticker(corrector);
    let changes = 0;
    let rate = 1;
    // Drift alternating between 70 and 95 ms, across the 80 ms edge.
    for (let i = 0; i < 40; i += 1) {
      const drift = i % 2 === 0 ? 95 : 70;
      const decision = t.correct(20_000 + drift, 20_000, {
        playbackRate: rate,
      });
      if (decision.playbackRate !== rate) {
        changes += 1;
        rate = decision.playbackRate;
      }
      t.step(250);
    }
    // Both readings sit between the exit and entry thresholds once nudging.
    expect(changes).toBeLessThanOrEqual(1);
  });

  it("leaves a nudge only when drift is nearly gone, and not more than once a second", () => {
    const corrector = new VideoSyncCorrector();
    const t = ticker(corrector);
    // Media and shared position both advance 250 ms per evaluation.
    let media = 20_000;
    let expected = 20_150;
    const next = (gap: number) => {
      t.step(250);
      media += 250;
      expected = media + gap;
      return t.correct(expected, media);
    };
    t.correct(expected, media);
    expect(next(150).playbackRate).toBeCloseTo(1.02);
    next(20);
    // Under the exit threshold, but the rate changed less than a second ago.
    expect(next(20).playbackRate).toBeCloseTo(1.02);
    next(20);
    expect(next(20).playbackRate).toBe(1);
  });

  it("doubles the wait after each seek that does not converge", () => {
    const corrector = new VideoSyncCorrector();
    const t = ticker(corrector);
    const waits: number[] = [];
    let expected = 30_000;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // Confirm the drift, seek, settle, then count how long until the next
      // seek is allowed while the gap stays 2 s.
      let decision = t.correct(expected, expected - 2_000);
      while (decision.action !== "seek") {
        t.step(250);
        expected += 250;
        decision = t.correct(expected, expected - 2_000);
      }
      corrector.seeked(t.now());
      t.step(250);
      expected += 250;
      let media = expected - 2_000;
      t.correct(expected, media);
      for (let i = 0; i < 3; i += 1) {
        t.step(250);
        expected += 250;
        media += 250;
        t.correct(expected, media);
      }
      const settledAt = t.now();
      for (;;) {
        t.step(250);
        expected += 250;
        media += 250 * 0.85;
        const next = t.correct(expected, media - 2_000 + (expected - media));
        if (next.action === "seek") break;
      }
      waits.push(t.now() - settledAt);
      corrector.seeked(t.now());
      for (let i = 0; i < 6; i += 1) {
        t.step(250);
        expected += 250;
        media += 250;
        t.correct(expected, media);
      }
    }
    for (let i = 1; i < waits.length; i += 1) {
      expect(waits[i]!).toBeGreaterThanOrEqual(waits[i - 1]!);
    }
  });

  it("aims a seek ahead by the latency it measured", () => {
    const corrector = new VideoSyncCorrector();
    const t = ticker(corrector);
    t.correct(8_000, 5_000);
    t.step(250);
    expect(t.correct(8_250, 5_250).seekToMs).toBe(8_250);
    // The seek takes about a second to produce moving media.
    t.step(500);
    corrector.seeked(t.now());
    t.step(500);
    t.correct(9_250, 8_250);
    t.step(250);
    t.correct(9_500, 8_300);
    t.step(250);
    t.correct(9_750, 8_550);
    t.step(250);
    t.correct(10_000, 8_800);
    expect(corrector.leadMs).toBeGreaterThan(800);
    expect(corrector.leadMs).toBeLessThanOrEqual(2_000);
  });

  it("holds an occurrence seek the same way and does not count it against the backoff", () => {
    const corrector = new VideoSyncCorrector();
    const t = ticker(corrector);
    corrector.expectSeek(t.now());
    expect(t.correct(100, 0, { seeking: true }).state).toBe("seek-pending");
    corrector.seeked(t.now());
    // The video resumes 600 ms behind the group.
    let media = 0;
    let expected = 600;
    const states: string[] = [];
    let seekedAfter = -1;
    for (let i = 0; i < 8; i += 1) {
      t.step(250);
      media += 250;
      expected += 250;
      const decision = t.correct(expected, media);
      states.push(decision.state);
      if (decision.action === "seek") {
        seekedAfter = i;
        break;
      }
    }
    // Settled after two forward readings (and 500 ms), confirmed with two
    // more: a seek on the sixth evaluation, with no cooldown in the way.
    expect(states.slice(0, 3)).toEqual(["settling", "settling", "settling"]);
    expect(seekedAfter).toBeGreaterThan(0);
    expect(seekedAfter).toBeLessThanOrEqual(5);
  });

  it("makes a correction seek wait a cooldown after it settles", () => {
    let settledAtMs = -1;
    let now = () => 0;
    const corrector = new VideoSyncCorrector((event) => {
      if (event.type === "seek-settled") settledAtMs = now();
    });
    const t = ticker(corrector);
    now = t.now;
    let media = 5_000;
    let expected = 8_000;
    t.correct(expected, media);
    t.step(250);
    media += 250;
    expected += 250;
    expect(t.correct(expected, media).action).toBe("seek");
    corrector.seeked(t.now());
    let seekAfterMs = -1;
    for (let i = 0; i < 20; i += 1) {
      t.step(250);
      media += 250;
      expected += 250;
      if (t.correct(expected, media).action === "seek") {
        seekAfterMs = t.now() - settledAtMs;
        break;
      }
    }
    expect(settledAtMs).toBeGreaterThan(0);
    expect(seekAfterMs).toBeGreaterThanOrEqual(1_000);
  });

  it("gives up on a seek that never completes and backs off", () => {
    const events: SyncEvent[] = [];
    const corrector = new VideoSyncCorrector((e) => events.push(e));
    const t = ticker(corrector);
    t.correct(8_000, 5_000);
    t.step(250);
    expect(t.correct(8_250, 5_250).action).toBe("seek");
    for (let i = 0; i < 24; i += 1) {
      t.step(250);
      t.correct(8_500 + i * 250, 8_250, { seeking: true });
    }
    expect(events.map((e) => e.type)).toContain("seek-timeout");
  });

  it("does not seek to a position at the end of the clip", () => {
    const corrector = new VideoSyncCorrector();
    const t = ticker(corrector);
    t.correct(29_900, 29_000, { limitMs: 30_000 });
    t.step(250);
    const decision = t.correct(30_000, 29_250, { limitMs: 30_000 });
    expect(decision.action).not.toBe("seek");
    expect(decision.state).toBe("near-end");
  });

  it("does nothing while paused or without metadata", () => {
    const corrector = new VideoSyncCorrector();
    const t = ticker(corrector);
    expect(t.correct(8_000, 0, { ready: false }).state).toBe("unready");
    expect(t.correct(8_000, 0, { paused: true }).state).toBe("paused");
  });
});

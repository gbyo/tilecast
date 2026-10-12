import { describe, expect, it } from "vitest";
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

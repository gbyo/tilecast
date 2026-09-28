import { describe, expect, it } from "vitest";
import { tilecastPlaybackPolicy } from "./playback-policy";

interface SyncState {
  lastSeekAtMs: number | null;
}

interface LayerCleanup {
  outgoingIsFront: boolean;
  capturedFill: number;
  currentFill: number;
}

interface Arbiter {
  complete(
    source: "ended" | "duration-timer" | "end-offset" | "skip" | "failure",
  ): "ignore" | "restart" | "advance";
  occurrenceStarted(): void;
  readonly settledForOccurrence: boolean;
}

interface Policy {
  ItemCompletion: new (authority: "local" | "shared", loop: boolean) => Arbiter;
  isCurrentPlayback(
    captured: { generation: number; render: number },
    current: { generation: number; render: number },
  ): boolean;
  newVideoSyncState(): SyncState;
  playbackAuthorityOf(synchronized: boolean | undefined): "local" | "shared";
  recordVideoSyncSeek(state: SyncState, nowMs: number): void;
  shouldClearOutgoingLayer(input: LayerCleanup): boolean;
  shouldPauseOutgoingLayer(input: LayerCleanup): boolean;
  transitionForSwap(
    configured: string | undefined,
    outgoingItemId: string | null,
    incomingItemId: string,
  ): string;
  videoSyncCorrection(input: {
    expectedMs: number;
    actualMs: number;
    nowMs: number;
    state: SyncState;
  }): {
    action: "hold" | "rate" | "seek";
    playbackRate: number;
    seekToMs: number | null;
  };
  zoneStepAllowed(step: {
    alive: boolean;
    mounted: boolean;
    connected: boolean;
  }): boolean;
}

const policy: Policy = tilecastPlaybackPolicy;

function correction(
  expectedMs: number,
  actualMs: number,
  options: { nowMs?: number; state?: SyncState } = {},
) {
  return policy.videoSyncCorrection({
    expectedMs,
    actualMs,
    nowMs: options.nowMs ?? 10_000,
    state: options.state ?? policy.newVideoSyncState(),
  });
}

describe("playback authority", () => {
  it("treats only an explicitly synchronized presentation as shared", () => {
    expect(policy.playbackAuthorityOf(true)).toBe("shared");
    expect(policy.playbackAuthorityOf(false)).toBe("local");
    // Absent flag: an ungrouped presentation keeps local playback behavior.
    expect(policy.playbackAuthorityOf(undefined)).toBe("local");
  });
});

describe("synchronized item completion", () => {
  it("never advances locally at a synchronized boundary", () => {
    // The preload's shared timeline schedules this boundary and pushes a fresh
    // projected presentation. Every local signal describing the same boundary
    // must be inert, or the renderer advances and is restarted milliseconds
    // later by the timeline — the visible rewind/repeat.
    const shared = new policy.ItemCompletion("shared", false);
    expect(shared.complete("duration-timer")).toBe("ignore");
    expect(shared.complete("ended")).toBe("ignore");
    expect(shared.complete("end-offset")).toBe("ignore");
    // Not even a local skip or failure may move a grouped screen on its own.
    expect(shared.complete("skip")).toBe("ignore");
    expect(shared.complete("failure")).toBe("ignore");
    expect(shared.settledForOccurrence).toBe(false);
  });

  it("keeps a synchronized single-video playlist on the shared timeline", () => {
    // loop is requested, but a grouped screen still restarts only when the
    // shared timeline says so.
    const shared = new policy.ItemCompletion("shared", true);
    expect(shared.complete("ended")).toBe("ignore");
  });
});

describe("ungrouped item completion", () => {
  it("advances a multi-item playlist locally", () => {
    const local = new policy.ItemCompletion("local", false);
    expect(local.complete("duration-timer")).toBe("advance");
  });

  it("advances on any single local completion source", () => {
    for (const source of ["ended", "end-offset", "skip", "failure"] as const) {
      expect(new policy.ItemCompletion("local", false).complete(source)).toBe(
        "advance",
      );
    }
  });

  it("only advances once when two completion signals race", () => {
    const local = new policy.ItemCompletion("local", false);
    expect(local.complete("ended")).toBe("advance");
    expect(local.complete("duration-timer")).toBe("ignore");
  });

  it("does not let a trailing event reopen an advanced occurrence", () => {
    const local = new policy.ItemCompletion("local", false);
    expect(local.complete("ended")).toBe("advance");
    // A timeupdate on the outgoing element must not rearm an item that has
    // already handed off to the next one.
    local.occurrenceStarted();
    expect(local.complete("duration-timer")).toBe("ignore");
  });

  it("restarts a single-video playlist exactly once per occurrence", () => {
    const loop = new policy.ItemCompletion("local", true);
    // `ended` and a fixed-duration timer routinely fire within a frame of each
    // other; the second one used to restart the video a second time.
    expect(loop.complete("duration-timer")).toBe("restart");
    expect(loop.complete("ended")).toBe("ignore");
    expect(loop.settledForOccurrence).toBe(true);

    // Only once playback has genuinely resumed does the next loop become
    // eligible to complete.
    loop.occurrenceStarted();
    expect(loop.settledForOccurrence).toBe(false);
    expect(loop.complete("ended")).toBe("restart");
  });
});

describe("synchronized video drift correction", () => {
  it("ignores drift inside the jitter band on a new occurrence", () => {
    // A fresh occurrence with a fresh element: the renderer already mounted it
    // at the right offset. Seeking here is what produced the "plays a few
    // frames, then jumps backward" artefact on every single boundary.
    const result = correction(12_040, 12_000, {
      state: policy.newVideoSyncState(),
    });
    expect(result.action).toBe("hold");
    expect(result.seekToMs).toBeNull();
    expect(result.playbackRate).toBe(1);

    // Exactly at the threshold, and in the other direction, too.
    expect(correction(12_080, 12_000).action).toBe("hold");
    expect(correction(12_000, 12_080).action).toBe("hold");
  });

  it("nudges the playback rate for drift between 81 and 250 ms", () => {
    const behind = correction(12_200, 12_000);
    expect(behind.action).toBe("rate");
    expect(behind.playbackRate).toBeCloseTo(1.02);
    expect(behind.seekToMs).toBeNull();

    const ahead = correction(12_000, 12_200);
    expect(ahead.action).toBe("rate");
    expect(ahead.playbackRate).toBeCloseTo(0.98);

    expect(correction(12_081, 12_000).action).toBe("rate");
    expect(correction(12_250, 12_000).action).toBe("rate");
  });

  it("seeks for drift above 250 ms", () => {
    const result = correction(12_251, 12_000);
    expect(result.action).toBe("seek");
    expect(result.seekToMs).toBe(12_251);
    expect(result.playbackRate).toBe(1);
  });

  it("performs the initial reposition when a video starts far from its offset", () => {
    // A newly created video that must start at a nonzero synchronized offset:
    // one intentional seek, then no further ones.
    const state = policy.newVideoSyncState();
    const initial = correction(30_000, 0, { nowMs: 1_000, state });
    expect(initial.action).toBe("seek");
    expect(initial.seekToMs).toBe(30_000);
  });

  it("never seeks to a negative position", () => {
    expect(correction(-500, 2_000).seekToMs).toBe(0);
  });

  it("does not keep seeking a video that is already converging", () => {
    const state = policy.newVideoSyncState();
    const first = correction(12_000, 8_000, { nowMs: 5_000, state });
    expect(first.action).toBe("seek");
    policy.recordVideoSyncSeek(state, 5_000);

    // The next 250 ms updates arrive while the decoder is still settling.
    for (const nowMs of [5_250, 5_500, 5_750]) {
      const next = correction(12_000, 8_000, { nowMs, state });
      expect(next.action).toBe("rate");
      expect(next.seekToMs).toBeNull();
    }

    // Once the cooldown has elapsed and the gap is still real, seek again.
    expect(correction(12_000, 8_000, { nowMs: 6_100, state }).action).toBe(
      "seek",
    );
  });
});

describe("stale playback callbacks", () => {
  it("rejects a callback from an older generation", () => {
    expect(
      policy.isCurrentPlayback(
        { generation: 4, render: 9 },
        { generation: 5, render: 9 },
      ),
    ).toBe(false);
  });

  it("rejects a stale failure timeout aimed at a newer item", () => {
    // A failItem() back-off scheduled for item 7 must not advance past item 8
    // when it finally fires; the generation alone cannot tell them apart,
    // because items of one presentation share it.
    expect(
      policy.isCurrentPlayback(
        { generation: 5, render: 7 },
        { generation: 5, render: 8 },
      ),
    ).toBe(false);
  });

  it("accepts a callback for the item that is still mounted", () => {
    expect(
      policy.isCurrentPlayback(
        { generation: 5, render: 8 },
        { generation: 5, render: 8 },
      ),
    ).toBe(true);
  });
});

describe("layout zone loops", () => {
  it("mounts the first zone item while the layout canvas is still detached", () => {
    // Zones are built into a canvas that is only appended to a layer once every
    // zone exists; demanding a connected container here would stop every zone
    // playlist from ever starting.
    expect(
      policy.zoneStepAllowed({ alive: true, mounted: false, connected: false }),
    ).toBe(true);
  });

  it("stops a zone loop whose container has been detached", () => {
    expect(
      policy.zoneStepAllowed({ alive: true, mounted: true, connected: false }),
    ).toBe(false);
  });

  it("stops a zone loop whose layout is no longer the active item", () => {
    expect(
      policy.zoneStepAllowed({ alive: false, mounted: false, connected: true }),
    ).toBe(false);
    expect(
      policy.zoneStepAllowed({ alive: false, mounted: true, connected: true }),
    ).toBe(false);
  });

  it("keeps rotating a zone that is still on screen", () => {
    expect(
      policy.zoneStepAllowed({ alive: true, mounted: true, connected: true }),
    ).toBe(true);
  });
});

describe("crossfade decision", () => {
  it("does not fade an item into itself", () => {
    // A grouped playlist that loops one video re-delivers the same item at
    // every shared boundary. Fading there runs a second decoder over the first
    // for 300 ms to dissolve a frame into itself.
    expect(policy.transitionForSwap("crossfade", "item-1", "item-1")).toBe(
      "none",
    );
    expect(policy.transitionForSwap(undefined, "item-1", "item-1")).toBe(
      "none",
    );
  });

  it("keeps the authored transition between different items", () => {
    expect(policy.transitionForSwap("crossfade", "item-1", "item-2")).toBe(
      "crossfade",
    );
    expect(policy.transitionForSwap("none", "item-1", "item-2")).toBe("none");
  });

  it("fades by default, including the first item of a presentation", () => {
    expect(policy.transitionForSwap(undefined, null, "item-1")).toBe("fade");
    expect(policy.transitionForSwap("", "item-1", "item-2")).toBe("fade");
  });
});

describe("crossfade cleanup", () => {
  it("clears the layer that actually faded out", () => {
    expect(
      policy.shouldClearOutgoingLayer({
        outgoingIsFront: false,
        capturedFill: 3,
        currentFill: 3,
      }),
    ).toBe(true);
  });

  it("cannot clear a back layer that was reused for the next item", () => {
    // The delayed cleanup used to read the mutable `backLayer`, so it tore down
    // content that had already been staged for the next item.
    expect(
      policy.shouldClearOutgoingLayer({
        outgoingIsFront: false,
        capturedFill: 3,
        currentFill: 4,
      }),
    ).toBe(false);
  });

  it("cannot clear the newly active layer", () => {
    expect(
      policy.shouldClearOutgoingLayer({
        outgoingIsFront: true,
        capturedFill: 3,
        currentFill: 3,
      }),
    ).toBe(false);
  });

  it("only pauses decoders on a layer it would also be safe to clear", () => {
    // Pausing a layer that is visible again would freeze the picture.
    expect(
      policy.shouldPauseOutgoingLayer({
        outgoingIsFront: true,
        capturedFill: 1,
        currentFill: 1,
      }),
    ).toBe(false);
    expect(
      policy.shouldPauseOutgoingLayer({
        outgoingIsFront: false,
        capturedFill: 1,
        currentFill: 1,
      }),
    ).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../clock/scheduler";
import {
  STARTUP_MIN_INTRO_MS,
  STARTUP_SHOWN_CEILING_MS,
  STARTUP_REVEAL_CEILING_MS,
  StartupSequence,
  type StartupPhase,
  type StartupSurface,
} from "./sequence";
import { PULSE_CATCH_MS, PULSE_CYCLE_MS, untilFrontPeak } from "./view";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeSurface(pulseStart: number | null = null) {
  const covered = deferred();
  const finished = deferred();
  const phases: StartupPhase[] = [];
  const reveal = vi.fn((_options: { reducedMotion: boolean }) => ({
    covered: covered.promise,
    finished: finished.promise,
  }));
  const surface: StartupSurface & { removed: number } = {
    removed: 0,
    pulseStarted: () => Promise.resolve(pulseStart),
    setPhase: (phase) => phases.push(phase),
    reveal,
    remove() {
      surface.removed += 1;
    },
  };
  return { surface, reveal, covered, finished, phases };
}

function harness(options: { reducedMotion?: boolean } = {}) {
  const clock = new ManualClock({ wallMs: 0, monotonicMs: 1_000 });
  const fake = fakeSurface();
  const sequence = new StartupSequence({
    clock,
    surface: fake.surface,
    reducedMotion: () => options.reducedMotion ?? false,
    introStartedAt: clock.monotonicNow(),
  });
  return { clock, sequence, ...fake };
}

describe("startup sequence", () => {
  it("plays the full intro even when the presentation is ready at once", () => {
    const h = harness();
    h.sequence.presentationAccepted();
    h.sequence.presentationShown();
    expect(h.sequence.phase).toBe("intro");
    h.clock.advance(STARTUP_MIN_INTRO_MS - 1);
    expect(h.reveal).not.toHaveBeenCalled();
    expect(h.sequence.covering).toBe(true);
    h.clock.advance(1);
    expect(h.reveal).toHaveBeenCalledTimes(1);
    expect(h.sequence.phase).toBe("revealing");
  });

  it("keeps pulsing after the minimum until the presentation is shown", () => {
    const h = harness();
    h.clock.advance(STARTUP_MIN_INTRO_MS * 6);
    expect(h.sequence.phase).toBe("intro");
    expect(h.sequence.describe()).toEqual({
      phase: "intro",
      presentationShown: false,
      minimumIntroComplete: true,
    });
    expect(h.reveal).not.toHaveBeenCalled();
    h.sequence.presentationShown();
    expect(h.reveal).toHaveBeenCalledTimes(1);
  });

  it("covers the presentation until the card fills the screen, then goes", async () => {
    const h = harness();
    const uncovered = vi.fn();
    h.sequence.onUncovered(uncovered);
    h.sequence.presentationShown();
    h.clock.advance(STARTUP_MIN_INTRO_MS);
    expect(h.sequence.covering).toBe(true);
    expect(uncovered).not.toHaveBeenCalled();

    h.covered.resolve();
    await flush();
    expect(h.sequence.phase).toBe("resolving");
    expect(h.sequence.covering).toBe(false);
    expect(uncovered).toHaveBeenCalledTimes(1);
    expect(h.surface.removed).toBe(0);

    h.finished.resolve();
    await flush();
    expect(h.sequence.phase).toBe("done");
    expect(h.surface.removed).toBe(1);
    expect(h.phases).toEqual(["revealing", "resolving", "done"]);
  });

  it("never replays for later presentations in the same document", async () => {
    const h = harness();
    h.sequence.presentationAccepted();
    h.sequence.presentationShown();
    h.clock.advance(STARTUP_MIN_INTRO_MS);
    h.covered.resolve();
    h.finished.resolve();
    await flush();
    for (let i = 0; i < 5; i++) {
      h.sequence.presentationAccepted();
      h.sequence.presentationShown();
      h.clock.advance(STARTUP_SHOWN_CEILING_MS);
    }
    expect(h.reveal).toHaveBeenCalledTimes(1);
    expect(h.surface.removed).toBe(1);
    expect(h.sequence.phase).toBe("done");
  });

  it("does not hide an accepted presentation that never reaches the screen forever", () => {
    const h = harness();
    h.sequence.presentationAccepted();
    h.clock.advance(STARTUP_SHOWN_CEILING_MS - 1);
    expect(h.reveal).not.toHaveBeenCalled();
    h.clock.advance(1);
    expect(h.reveal).toHaveBeenCalledTimes(1);
  });

  it("keeps the logo while nothing has been sent at all", () => {
    const h = harness();
    h.clock.advance(STARTUP_SHOWN_CEILING_MS * 10);
    expect(h.sequence.phase).toBe("intro");
  });

  it("asks for the reduced-motion reveal when motion is reduced", () => {
    const h = harness({ reducedMotion: true });
    h.sequence.presentationShown();
    h.clock.advance(STARTUP_MIN_INTRO_MS);
    expect(h.reveal).toHaveBeenCalledWith({ reducedMotion: true });
  });

  it("is removed at once, without a reveal, when skipped", () => {
    const h = harness();
    const uncovered = vi.fn();
    h.sequence.onUncovered(uncovered);
    h.sequence.skip();
    expect(h.sequence.phase).toBe("done");
    expect(h.surface.removed).toBe(1);
    expect(uncovered).toHaveBeenCalledTimes(1);
    h.sequence.presentationShown();
    h.clock.advance(STARTUP_MIN_INTRO_MS);
    expect(h.reveal).not.toHaveBeenCalled();
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("finishes rather than sticking when the reveal fails", async () => {
    const h = harness();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.sequence.presentationShown();
    h.clock.advance(STARTUP_MIN_INTRO_MS);
    h.finished.reject(new Error("no compositor"));
    await flush();
    expect(h.sequence.phase).toBe("done");
    expect(h.surface.removed).toBe(1);
  });

  it("counts the minimum from when the pulse is actually on screen", async () => {
    const clock = new ManualClock({ wallMs: 0, monotonicMs: 1_000 });
    let started!: (at: number) => void;
    const fake = fakeSurface();
    fake.surface.pulseStarted = () =>
      new Promise<number | null>((resolve) => (started = resolve));
    const sequence = new StartupSequence({
      clock,
      surface: fake.surface,
      reducedMotion: () => false,
    });
    sequence.presentationShown();
    // No frames yet: time passing does not count toward the intro.
    clock.advance(5_000);
    expect(fake.reveal).not.toHaveBeenCalled();
    started(clock.monotonicNow());
    await flush();
    clock.advance(STARTUP_MIN_INTRO_MS - 1);
    expect(fake.reveal).not.toHaveBeenCalled();
    clock.advance(1);
    expect(fake.reveal).toHaveBeenCalledTimes(1);
  });

  it("removes the layer if compositor completion never arrives", () => {
    const h = harness();
    const uncovered = vi.fn();
    h.sequence.onUncovered(uncovered);
    h.sequence.presentationShown();
    h.clock.advance(STARTUP_MIN_INTRO_MS + STARTUP_REVEAL_CEILING_MS);
    expect(h.sequence.phase).toBe("done");
    expect(h.surface.removed).toBe(1);
    expect(uncovered).toHaveBeenCalledTimes(1);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("bounds startup when the pulse readiness promise never resolves", () => {
    const clock = new ManualClock({ wallMs: 0 });
    const fake = fakeSurface();
    fake.surface.pulseStarted = () => new Promise(() => {});
    const sequence = new StartupSequence({
      clock,
      surface: fake.surface,
      reducedMotion: () => false,
    });
    sequence.presentationAccepted();
    clock.advance(STARTUP_SHOWN_CEILING_MS + STARTUP_REVEAL_CEILING_MS);
    expect(sequence.phase).toBe("done");
    expect(fake.surface.removed).toBe(1);
  });

  it("is already done when the document has no startup layer", () => {
    const clock = new ManualClock({ wallMs: 0 });
    const sequence = new StartupSequence({
      clock,
      surface: null,
      reducedMotion: () => false,
    });
    const uncovered = vi.fn();
    sequence.onUncovered(uncovered);
    expect(sequence.phase).toBe("done");
    expect(uncovered).toHaveBeenCalled();
  });
});

describe("startup pulse timing", () => {
  it("finds the front tile's next peak in the pulse loop", () => {
    // runtime.css: 1.5 s loop, front tile delayed 0.36 s, peak at 25 %.
    expect(untilFrontPeak(0)).toBe(735);
    expect(untilFrontPeak(735)).toBe(0);
    expect(untilFrontPeak(736)).toBe(PULSE_CYCLE_MS - 1);
    expect(untilFrontPeak(PULSE_CYCLE_MS)).toBe(735);
    expect(untilFrontPeak(PULSE_CYCLE_MS + 735 - 100)).toBe(100);
  });

  it("waits for a landing beat only when it is close", () => {
    expect(PULSE_CATCH_MS).toBeLessThan(PULSE_CYCLE_MS / 3);
  });
});

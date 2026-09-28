// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewClock } from "./previewClock";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PreviewClock", () => {
  it("follows the wall clock while live", () => {
    const clock = new PreviewClock();
    const before = Date.now();
    expect(clock.now()).toBeGreaterThanOrEqual(before);
    expect(clock.now()).toBeLessThanOrEqual(Date.now());
    expect(clock.monotonicNow()).toBeLessThanOrEqual(Date.now());
  });

  it("freezes time at a fixed instant", () => {
    const clock = new PreviewClock();
    const fixed = Date.parse("2026-09-28T14:37:45.000Z");
    clock.setFixed(fixed);
    expect(clock.now()).toBe(fixed);
    expect(clock.monotonicNow()).toBe(fixed);
    // A mode switch without an instant keeps the previous instant.
    clock.setMode("fixed");
    expect(clock.now()).toBe(fixed);
    clock.setMode("live");
    expect(clock.now()).not.toBe(fixed);
  });

  it("runs timers on real time in both modes", async () => {
    const clock = new PreviewClock();
    clock.setFixed(Date.parse("2026-09-28T14:37:45.000Z"));
    let fired = 0;
    const timer = clock.after(5, () => {
      fired += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fired).toBe(1);
    timer.cancel();
    expect(clock.now()).toBe(Date.parse("2026-09-28T14:37:45.000Z"));
  });

  it("cancels pending timers", async () => {
    const clock = new PreviewClock();
    let fired = 0;
    const timer = clock.after(5, () => {
      fired += 1;
    });
    timer.cancel();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fired).toBe(0);
  });

  it("never moves monotonic time backward when scrubbing fixed instants", () => {
    const clock = new PreviewClock();
    const later = Date.parse("2026-09-28T14:37:45.000Z");
    const earlier = Date.parse("2026-09-28T14:37:40.000Z");
    clock.setFixed(later);
    expect(clock.monotonicNow()).toBe(later);
    clock.setFixed(earlier);
    expect(clock.now()).toBe(earlier);
    expect(clock.monotonicNow()).toBe(later);
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { RuntimeManifestEntry } from "@tilecast/plugin-sdk/runtime";
import { createTestRuntime, grant } from "@tilecast/plugin-sdk/runtime/testing";
import countdownBar from "./index";
import { CONFETTI_MS } from "./confetti";

const TARGET = Date.parse("2026-09-01T16:10:00Z");

const entry = (config: Record<string, unknown> = {}): RuntimeManifestEntry => ({
  id: "cd-1",
  type: "countdown_bar",
  version: 1,
  config: {
    message: "Lunch starts in",
    scheduleType: "one_time",
    oneTimeAt: new Date(TARGET).toISOString(),
    timezone: "UTC",
    leadTimeSeconds: 3_600,
    completionText: "Lunch time",
    showConfetti: true,
    displayMode: "overlay",
    heightPx: 72,
    progressFill: "drain",
    priority: 4,
    ...config,
  },
});

function mounted(options: Parameters<typeof createTestRuntime>[0] = {}) {
  const runtime = createTestRuntime(options);
  const instance = countdownBar.create(runtime.context);
  const strip = document.createElement("div");
  const overlay = document.createElement("div");
  instance.mount("strip.bottom", strip);
  instance.mount("overlay", overlay);
  const bar = strip.querySelector<HTMLElement>(".tc-countdown-bar")!;
  return { runtime, instance, strip, overlay, bar };
}

describe("Countdown Bar runtime", () => {
  it("declares the scheduled tier on the bottom strip and the overlay", () => {
    expect(countdownBar.tier).toBe("scheduled");
    expect(countdownBar.surfaces).toEqual(["strip.bottom", "overlay"]);
  });

  it("claims the strip inside its lead window, on the corrected clock", () => {
    // Local time is before the window; the server's corrected time is inside.
    const { instance } = mounted({
      now: TARGET - 10 * 60_000,
      clockOffsetMs: 2 * 3_600_000,
    });
    expect(instance.update([entry()])).toEqual([
      {
        slot: "strip.bottom",
        priority: 4,
        heightPx: 72,
        displayMode: "overlay",
      },
    ]);
    const { instance: early } = mounted({ now: TARGET - 2 * 3_600_000 });
    expect(early.update([entry()])).toEqual([]);
  });

  it("draws what it holds and nothing it does not", () => {
    const { instance, bar } = mounted({ now: TARGET - 10 * 60_000 });
    instance.update([entry({ displayMode: "push", contentPadding: 10 })]);
    instance.render(grant(["strip.bottom"]));
    expect(bar.classList.contains("tc-countdown-bar--visible")).toBe(true);
    expect(instance.describe?.("strip.bottom")).toBe("Lunch starts in 10m 0s");
    expect(bar.style.getPropertyValue("--tc-countdown-bar-padding")).toBe(
      "10%",
    );
    const fill = bar.querySelector<HTMLElement>(".tc-countdown-bar__fill")!;
    expect(fill.style.width).toBe(`${(10 / 60) * 100}%`);

    // Another plugin won the strip: the same elements stay, hidden and empty.
    instance.render(grant([]));
    expect(bar.classList.contains("tc-countdown-bar--visible")).toBe(false);
    expect(bar.textContent).toBe("");
    expect(bar.isConnected || bar.parentElement).toBeTruthy();
  });

  it("marks urgency stages and pulses in the final stage", () => {
    const { instance, bar } = mounted({ now: TARGET - 5_000 });
    instance.update([entry({ urgencyEnabled: true })]);
    instance.render(grant(["strip.bottom"]));
    expect(bar.dataset["urgency"]).toBe("final");
    expect(bar.classList.contains("tc-countdown-bar--pulse")).toBe(true);
    expect(instance.describe?.("strip.bottom")).toBe(
      "Urgent Lunch starts in 5s",
    );
  });

  it("claims the overlay for one confetti burst and releases it", () => {
    const { runtime, instance, overlay } = mounted({ now: TARGET + 1_000 });
    const claims = instance.update([entry()]);
    expect(claims.map((claim) => claim.slot)).toEqual([
      "strip.bottom",
      "overlay",
    ]);
    instance.render(grant(["strip.bottom", "overlay"]));
    const pieces = overlay.querySelectorAll(
      ".tc-countdown-bar__confetti-piece",
    );
    expect(pieces.length).toBe(220);
    // Updates do not restart the burst.
    instance.update([entry()]);
    instance.render(grant(["strip.bottom", "overlay"]));
    expect(overlay.querySelector(".tc-countdown-bar__confetti-piece")).toBe(
      pieces[0],
    );
    runtime.advance(CONFETTI_MS);
    expect(runtime.invalidations).toBe(1);
    expect(instance.update([entry()]).map((claim) => claim.slot)).toEqual([
      "strip.bottom",
    ]);
    instance.render(grant(["strip.bottom"]));
    expect(overlay.children[0]!.children).toHaveLength(0);
  });

  it("skips confetti when motion is reduced or frozen", () => {
    const { instance } = mounted({ now: TARGET + 1_000, animationScale: 0 });
    expect(instance.update([entry()]).map((claim) => claim.slot)).toEqual([
      "strip.bottom",
    ]);
  });

  it("keeps counting from a cached manifest as time passes", () => {
    const { runtime, instance, bar } = mounted({ now: TARGET - 61_000 });
    const cached = [entry()];
    instance.update(cached);
    instance.render(grant(["strip.bottom"]));
    expect(bar.textContent).toContain("1m 1s");
    runtime.advance(60_000);
    instance.update(cached);
    instance.render(grant(["strip.bottom"]));
    expect(bar.textContent).toContain("1s");
    runtime.advance(61_000);
    // Completion text holds for a minute after the target, then the bar goes.
    instance.update(cached);
    instance.render(grant(["strip.bottom"]));
    expect(bar.textContent).toBe("Lunch time");
    runtime.advance(60_000);
    expect(instance.update(cached)).toEqual([]);
  });

  it("ignores entry versions it does not implement", () => {
    const { instance } = mounted({ now: TARGET - 60_000 });
    expect(instance.update([{ ...entry(), version: 2 }])).toEqual([]);
  });
});

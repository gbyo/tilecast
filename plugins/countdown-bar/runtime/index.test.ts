// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { PlayerStateEntry } from "@tilecast/plugin-sdk/player";
import {
  createTestPlayer,
  type TestPlayerOptions,
} from "@tilecast/plugin-sdk/player/testing";
import countdownBar, { TICK_MS } from "./index";
import { CONFETTI_MS } from "./confetti";
import manifest from "../tilecast.plugin.json";

const TARGET = Date.parse("2026-09-01T16:10:00Z");

const entry = (
  config: Record<string, unknown> = {},
  version = 1,
): PlayerStateEntry => ({
  id: "cd-1",
  type: "countdown_bar",
  version,
  state: {
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
  media: [],
  validUntil: null,
});

const surfaces = manifest.player.runtime
  .surfaces as TestPlayerOptions["surfaces"];

function player(options: TestPlayerOptions = {}) {
  const test = createTestPlayer(countdownBar, { surfaces, ...options });
  const bar = () =>
    test
      .container("bar", "strip.bottom")
      .querySelector<HTMLElement>(".tc-countdown-bar")!;
  return { test, bar };
}

describe("Countdown Bar runtime", () => {
  it("requests exactly the services and contributions its manifest declares", () => {
    expect(countdownBar.services).toEqual(manifest.player.runtime.services);
    expect(manifest.player.runtime.surfaces).toEqual([
      { id: "bar", slots: ["strip.bottom"], tier: "scheduled" },
      { id: "confetti", slots: ["overlay"], tier: "scheduled" },
    ]);
  });

  it("claims the strip inside its lead window, on the corrected clock", () => {
    // Local time is before the window; the server's corrected time is inside.
    const { test } = player({
      now: TARGET - 10 * 60_000,
      clockOffsetMs: 2 * 3_600_000,
    });
    test.setState([entry()]);
    expect(test.claims("bar")).toEqual([
      {
        slot: "strip.bottom",
        priority: 4,
        heightPx: 72,
        displayMode: "overlay",
      },
    ]);
    const { test: early } = player({ now: TARGET - 2 * 3_600_000 });
    early.setState([entry()]);
    expect(early.claims("bar")).toEqual([]);
  });

  it("draws what it holds and nothing it does not", () => {
    const { test, bar } = player({ now: TARGET - 10 * 60_000 });
    test.setState([entry({ displayMode: "push", contentPadding: 10 })]);
    test.grant("bar", ["strip.bottom"]);
    expect(bar().classList.contains("tc-countdown-bar--visible")).toBe(true);
    expect(test.describe("bar", "strip.bottom")).toBe("Lunch starts in 10m 0s");
    expect(bar().style.getPropertyValue("--tc-countdown-bar-padding")).toBe(
      "10%",
    );
    const fill = bar().querySelector<HTMLElement>(".tc-countdown-bar__fill")!;
    expect(fill.style.width).toBe(`${(10 / 60) * 100}%`);

    // Another plugin won the strip: the same elements stay, hidden and empty.
    const element = bar();
    test.grant("bar", []);
    expect(element.classList.contains("tc-countdown-bar--visible")).toBe(false);
    expect(element.textContent).toBe("");
    expect(bar()).toBe(element);
  });

  it("marks urgency stages and pulses in the final stage", () => {
    const { test, bar } = player({ now: TARGET - 5_000 });
    test.setState([entry({ urgencyEnabled: true })]);
    test.grant("bar", ["strip.bottom"]);
    expect(bar().dataset["urgency"]).toBe("final");
    expect(bar().classList.contains("tc-countdown-bar--pulse")).toBe(true);
    expect(test.describe("bar", "strip.bottom")).toBe(
      "Urgent Lunch starts in 5s",
    );
  });

  it("claims the overlay for one confetti burst and releases it", () => {
    const { test } = player({ now: TARGET + 1_000 });
    test.setState([entry()]);
    expect(test.claims("bar").map((claim) => claim.slot)).toEqual([
      "strip.bottom",
    ]);
    expect(test.claims("confetti")).toEqual([{ slot: "overlay", priority: 0 }]);
    test.grant("confetti", ["overlay"]);
    const overlay = test.container("confetti", "overlay");
    const pieces = overlay.querySelectorAll(
      ".tc-countdown-bar__confetti-piece",
    );
    expect(pieces.length).toBe(220);
    // A later tick does not restart the burst.
    test.advance(TICK_MS);
    test.grant("confetti", ["overlay"]);
    expect(overlay.querySelector(".tc-countdown-bar__confetti-piece")).toBe(
      pieces[0],
    );
    test.advance(CONFETTI_MS);
    expect(test.claims("confetti")).toEqual([]);
    test.grant("confetti", []);
    expect(overlay.children[0]!.children).toHaveLength(0);
  });

  it("skips confetti when motion is reduced or frozen", () => {
    const { test } = player({ now: TARGET + 1_000, animationScale: 0 });
    test.setState([entry()]);
    expect(test.claims("confetti")).toEqual([]);
  });

  it("keeps counting from cached state as time passes, on its own clock", () => {
    const { test, bar } = player({ now: TARGET - 61_000 });
    test.setState([entry()]);
    test.grant("bar", ["strip.bottom"]);
    expect(bar().textContent).toContain("1m 1s");
    test.advance(60_000);
    test.grant("bar", ["strip.bottom"]);
    expect(bar().textContent).toContain("1s");
    test.advance(61_000);
    // Completion text holds for a minute after the target, then the bar goes.
    test.grant("bar", ["strip.bottom"]);
    expect(bar().textContent).toBe("Lunch time");
    test.advance(60_000);
    expect(test.claims("bar")).toEqual([]);
  });

  it("stops its timers when it has no state", () => {
    const { test } = player({ now: TARGET - 60_000 });
    test.setState([entry()]);
    expect(test.pendingTimers).toBeGreaterThan(0);
    test.setState([]);
    expect(test.active).toBe(false);
    expect(test.pendingTimers).toBe(0);
  });

  it("ignores state versions it does not implement", () => {
    const { test } = player({ now: TARGET - 60_000 });
    test.setState([entry({}, 2)]);
    expect(test.claims("bar")).toEqual([]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  createManualClock,
  createTestContext,
  mountForTest,
} from "@tilecast/widget-sdk/testing";
import widget from "./index.ts";
import {
  parseCountdownConfig,
  readCountdown,
  segmentsFor,
  unitLabel,
  type CountdownConfig,
} from "./countdown.ts";
import { resolveCountdownTarget } from "./schedule.ts";

type CountdownElement = HTMLElement & { updateComplete: Promise<unknown> };

const now = Date.parse("2026-09-28T14:25:36Z");

function config(overrides: Record<string, unknown> = {}): CountdownConfig {
  const parsed = parseCountdownConfig({
    target: "2026-10-03T10:00",
    timeZone: "America/Chicago",
    label: "Graduation",
    ...overrides,
  });
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.config;
}

async function render(overrides: Record<string, unknown> = {}) {
  const clock = createManualClock(now);
  const test = mountForTest(widget, {
    config: {
      target: "2026-10-03T10:00",
      timeZone: "America/Chicago",
      label: "Graduation",
      ...overrides,
    },
    context: createTestContext({ clock }),
  });
  const element = test.element as CountdownElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const values = () =>
    [...root.querySelectorAll(".value")].map((node) => node.textContent);
  return { test, element, root, clock, values };
}

afterEach(() => document.body.replaceChildren());

describe("Countdown target", () => {
  it("rolls a daily local countdown to today's occurrence", () => {
    expect(
      resolveCountdownTarget(
        "2026-07-20T14:00:00",
        "UTC",
        "daily",
        new Date("2026-07-21T12:00:00Z"),
      ),
    ).toBe(Date.parse("2026-07-21T14:00:00Z"));
  });

  it("clamps a recurring month to its last day", () => {
    expect(
      resolveCountdownTarget(
        "2026-01-31T09:00:00",
        "UTC",
        "monthly",
        new Date("2026-02-01T12:00:00Z"),
      ),
    ).toBe(Date.parse("2026-02-28T09:00:00Z"));
  });

  it("preserves local wall time across daylight-saving changes", () => {
    expect(
      resolveCountdownTarget(
        "2026-03-01T09:00:00",
        "America/New_York",
        "weekly",
        new Date("2026-03-07T20:00:00Z"),
      ),
    ).toBe(Date.parse("2026-03-08T13:00:00Z"));
  });

  it("reads a saved RFC 3339 instant as that instant", () => {
    expect(
      resolveCountdownTarget(
        "2026-12-01T15:00:00Z",
        "Asia/Tokyo",
        "none",
        new Date(now),
      ),
    ).toBe(Date.parse("2026-12-01T15:00:00Z"));
  });
});

describe("Countdown configuration", () => {
  it("accepts the compiled legacy configuration", () => {
    expect(
      parseCountdownConfig({
        target: "2026-12-01T09:00",
        timeZone: "America/New_York",
        mode: "countdown",
        recurrence: "weekly",
        style: "horizontal",
        label: "Board meeting",
        completionText: "Started",
        completionAction: "hide",
        showDays: false,
        showHours: true,
        showMinutes: true,
        showSeconds: false,
        background: "#000000",
        foreground: "#ffffff",
      }),
    ).toMatchObject({
      ok: true,
      config: {
        recurrence: "weekly",
        style: "horizontal",
        units: { day: false, hour: true, minute: true, second: false },
      },
    });
  });

  it.each([
    [{ target: "tomorrow" }],
    [{ target: "2026-12-01" }],
    [{ timeZone: "Mars/Olympus" }],
    [{ mode: "sideways" }],
    [{ style: "<b>" }],
    [{ showDays: "yes" }],
    [{ label: "x".repeat(121) }],
  ])("refuses %j", (value) => {
    expect(
      parseCountdownConfig({ target: "2026-12-01T09:00", ...value }).ok,
    ).toBe(false);
  });

  it("never repeats a count up, as the saved rule required", () => {
    expect(config({ mode: "count_up", recurrence: "daily" }).recurrence).toBe(
      "none",
    );
  });

  it("shows days, hours and minutes when no unit is chosen", () => {
    expect(
      config({
        showDays: false,
        showHours: false,
        showMinutes: false,
        showSeconds: false,
      }).units,
    ).toEqual({ day: true, hour: true, minute: true, second: false });
  });
});

describe("Countdown reading", () => {
  const all = { day: true, hour: true, minute: true, second: true };

  it("folds a hidden larger unit into the next visible one", () => {
    const duration = 2 * 86_400_000 + 4 * 3_600_000 + 5 * 60_000;
    expect(
      segmentsFor(duration, { ...all, day: false, second: false }),
    ).toEqual([
      { unit: "hour", value: 52 },
      { unit: "minute", value: 5 },
    ]);
  });

  it("leaves out a leading zero-day segment", () => {
    expect(segmentsFor(3_600_000, all).map((s) => s.unit)).toEqual([
      "hour",
      "minute",
      "second",
    ]);
  });

  it("counts down to the target in the Countdown zone", () => {
    // 10:00 in Chicago is 15:00Z; 5 days 0:34:24 remain, shown rounded
    // up to the minute.
    expect(readCountdown(config(), now, "America/Chicago")).toEqual({
      phase: "counting",
      direction: "down",
      segments: [
        { unit: "day", value: 5 },
        { unit: "hour", value: 0 },
        { unit: "minute", value: 35 },
      ],
    });
  });

  it("follows the completion action after a one-time target", () => {
    const past = { target: "2026-09-01T07:00" };
    expect(readCountdown(config(past), now, "UTC").phase).toBe("complete");
    expect(
      readCountdown(config({ ...past, completionAction: "hide" }), now, "UTC")
        .phase,
    ).toBe("hidden");
    expect(
      readCountdown(
        config({ ...past, completionAction: "count_up" }),
        now,
        "UTC",
      ),
    ).toMatchObject({ phase: "counting", direction: "up" });
  });

  it("names units in the screen locale", () => {
    expect(unitLabel("day", 2, "en-US")).toBe("days");
    expect(unitLabel("day", 1, "en-US")).toBe("day");
    expect(unitLabel("hour", 3, "es")).toBe("horas");
  });
});

describe("Countdown element", () => {
  it("renders segments with the title and reports ready", async () => {
    const { root, test, values } = await render();
    expect(root.querySelector(".title")?.textContent).toBe("Graduation");
    expect(values()).toEqual(["5", "00", "35"]);
    expect(root.querySelector("[role=timer]")?.getAttribute("aria-label")).toBe(
      "5 days 0 hours 35 minutes",
    );
    expect(test.states.at(-1)).toEqual({ state: "ready" });
  });

  it("ticks each second from the Widget clock when seconds show", async () => {
    const { element, clock, values } = await render({
      target: "2026-09-28T11:00",
      showDays: false,
      showSeconds: true,
    });
    expect(values()).toEqual(["1", "34", "24"]);
    // The clock wakes just after the next second boundary.
    clock.advance(1_010);
    await element.updateComplete;
    expect(values()).toEqual(["1", "34", "23"]);
  });

  it("switches to the completion message at the target", async () => {
    const { element, clock, root } = await render({
      target: "2026-09-28T09:26",
      completionText: "Doors are open",
    });
    expect(root.querySelector(".complete")).toBeNull();
    clock.advance(60_000);
    await element.updateComplete;
    expect(root.querySelector(".complete")?.textContent?.trim()).toBe(
      "Doors are open",
    );
  });

  it("reports expected empty content when a hidden countdown has ended", async () => {
    const { test, root } = await render({
      target: "2026-09-01T07:00",
      completionAction: "hide",
    });
    expect(root.querySelector(".segments")).toBeNull();
    expect(test.states.at(-1)).toEqual({ state: "empty", reason: "completed" });
  });

  it("leaves no timer behind after disposal", async () => {
    const { test, clock } = await render({ showSeconds: true });
    test.dispose();
    expect(clock.pendingTimers).toBe(0);
  });
});

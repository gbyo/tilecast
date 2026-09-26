import { tilecastCountdownBar } from "./countdown-bar-resolver";
import { describe, expect, it } from "vitest";

interface CountdownBarPlugin {
  id: string;
  type: string;
  version: number;
  config: {
    message: string;
    scheduleType: "weekly" | "one_time";
    targetTime?: string | null;
    daysOfWeek?: number[];
    oneTimeAt?: string | null;
    timezone: string;
    leadTimeSeconds: number;
    completionText?: string;
    showConfetti?: boolean;
    displayMode: "overlay" | "push";
    heightPx: number;
    progressFill?: "none" | "drain" | null;
    contentPadding?: number | null;
    textScale?: number | null;
    urgencyEnabled?: boolean;
    startingSoonSeconds?: number | null;
    urgentSeconds?: number | null;
    pulseSeconds?: number | null;
    priority: number;
  };
}

interface CountdownBarResolver {
  resolve(
    plugins: CountdownBarPlugin[] | null | undefined,
    localNow: Date,
    clockOffsetMs?: number,
  ): {
    id: string;
    message: string;
    value: string;
    displayMode: string;
    targetAt: string;
    remainingFraction: number | null;
    contentPadding: number;
    fontSizePx: number;
    showBar: boolean;
    showConfetti: boolean;
    urgencyStage: string;
    urgencyLabel: string;
    pulse: boolean;
  } | null;
}

const resolver = tilecastCountdownBar;

function weekly(
  overrides: Partial<CountdownBarPlugin["config"]> = {},
): CountdownBarPlugin {
  return {
    id: "bar-1",
    type: "countdown_bar",
    version: 1,
    config: {
      message: "Lunch ends in",
      scheduleType: "weekly",
      targetTime: "12:00",
      daysOfWeek: [1],
      timezone: "America/New_York",
      leadTimeSeconds: 900,
      completionText: "Lunch is over",
      displayMode: "overlay",
      heightPx: 72,
      priority: 10,
      ...overrides,
    },
  };
}

describe("countdown bar resolver", () => {
  it("evaluates weekly wall time in the configured timezone", () => {
    const active = resolver.resolve(
      [weekly()],
      new Date("2026-07-27T15:50:00Z"),
    );
    expect(active).toMatchObject({
      message: "Lunch ends in",
      value: "10m 0s",
      targetAt: "2026-07-27T16:00:00.000Z",
    });
  });

  it("shows completion text for one minute and then hides", () => {
    const plugin: CountdownBarPlugin = {
      ...weekly(),
      config: {
        ...weekly().config,
        scheduleType: "one_time",
        targetTime: null,
        daysOfWeek: [],
        oneTimeAt: "2026-07-27T16:00:00Z",
      },
    };
    expect(
      resolver.resolve([plugin], new Date("2026-07-27T16:00:30Z")),
    ).toMatchObject({
      message: "",
      value: "Lunch is over",
    });
    expect(
      resolver.resolve([plugin], new Date("2026-07-27T16:01:01Z")),
    ).toBeNull();
  });

  it("shows confetti briefly at zero without keeping an empty bar visible", () => {
    const plugin: CountdownBarPlugin = {
      ...weekly({ completionText: "", showConfetti: true }),
      config: {
        ...weekly({ completionText: "", showConfetti: true }).config,
        scheduleType: "one_time",
        targetTime: null,
        daysOfWeek: [],
        oneTimeAt: "2026-07-27T16:00:00Z",
      },
    };
    expect(
      resolver.resolve([plugin], new Date("2026-07-27T16:00:04Z")),
    ).toMatchObject({
      completed: true,
      showBar: false,
      showConfetti: true,
    });
    expect(
      resolver.resolve([plugin], new Date("2026-07-27T16:00:09Z")),
    ).toMatchObject({ showConfetti: true });
    expect(
      resolver.resolve([plugin], new Date("2026-07-27T16:00:13Z")),
    ).toBeNull();
  });

  it("selects the highest-priority active instance", () => {
    const low = weekly({ priority: 1, message: "Low" });
    const high = {
      ...weekly({ priority: 50, message: "High", displayMode: "push" }),
      id: "bar-2",
    };
    expect(
      resolver.resolve([low, high], new Date("2026-07-27T15:50:00Z")),
    ).toMatchObject({ id: "bar-2", message: "High", displayMode: "push" });
  });

  it("reports no fill fraction unless the instance opts in", () => {
    const active = resolver.resolve(
      [weekly()],
      new Date("2026-07-27T15:50:00Z"),
    );
    expect(active?.remainingFraction).toBeNull();
  });

  it("drains the fill across the lead window", () => {
    const plugin = weekly({ progressFill: "drain" });
    // leadTimeSeconds is 900, so the window opens at 15:45 and ends at 16:00.
    const at = (iso: string) =>
      resolver.resolve([plugin], new Date(iso))?.remainingFraction;
    expect(at("2026-07-27T15:45:00Z")).toBeCloseTo(1);
    expect(at("2026-07-27T15:50:00Z")).toBeCloseTo(2 / 3);
    expect(at("2026-07-27T15:52:30Z")).toBeCloseTo(0.5);
    expect(at("2026-07-27T15:59:59Z")).toBeCloseTo(1 / 900, 3);
  });

  it("holds the fill at empty while completion text shows", () => {
    const plugin: CountdownBarPlugin = {
      ...weekly({ progressFill: "drain" }),
      config: {
        ...weekly({ progressFill: "drain" }).config,
        scheduleType: "one_time",
        targetTime: null,
        daysOfWeek: [],
        oneTimeAt: "2026-07-27T16:00:00Z",
      },
    };
    const active = resolver.resolve([plugin], new Date("2026-07-27T16:00:30Z"));
    expect(active?.value).toBe("Lunch is over");
    expect(active?.remainingFraction).toBe(0);
  });

  it("defaults padding and type size to the original appearance", () => {
    const active = resolver.resolve(
      [weekly()],
      new Date("2026-07-27T15:50:00Z"),
    );
    // 72px height * 0.42 = 30.24, inside the 22..72 clamp, at 100% scale.
    expect(active?.contentPadding).toBe(4);
    expect(active?.fontSizePx).toBeCloseTo(30.24, 2);
  });

  it("applies a custom padding and text scale", () => {
    const active = resolver.resolve(
      [weekly({ contentPadding: 0, textScale: 200 })],
      new Date("2026-07-27T15:50:00Z"),
    );
    expect(active?.contentPadding).toBe(0);
    expect(active?.fontSizePx).toBeCloseTo(60.48, 2);
  });

  it("advances through urgency stages and recompacts completion text", () => {
    const plugin = weekly({
      urgencyEnabled: true,
      startingSoonSeconds: 300,
      urgentSeconds: 60,
      pulseSeconds: 10,
    });
    expect(
      resolver.resolve([plugin], new Date("2026-07-27T15:54:59Z")),
    ).toMatchObject({ urgencyStage: "normal", urgencyLabel: "", pulse: false });
    expect(
      resolver.resolve([plugin], new Date("2026-07-27T15:55:00Z")),
    ).toMatchObject({
      urgencyStage: "starting_soon",
      urgencyLabel: "Starting soon",
    });
    expect(
      resolver.resolve([plugin], new Date("2026-07-27T15:59:00Z")),
    ).toMatchObject({
      urgencyStage: "urgent",
      urgencyLabel: "Urgent",
      heightPx: 72,
    });
    expect(
      resolver.resolve([plugin], new Date("2026-07-27T15:59:50Z")),
    ).toMatchObject({ urgencyStage: "final", pulse: true, heightPx: 90 });
    expect(
      resolver.resolve([plugin], new Date("2026-07-27T16:00:10Z")),
    ).toMatchObject({ urgencyStage: "normal", pulse: false, heightPx: 72 });
  });

  it("lets a scaled bar exceed the unscaled type ceiling", () => {
    const tall = weekly({ textScale: 300 });
    tall.config.heightPx = 320;
    const active = resolver.resolve([tall], new Date("2026-07-27T15:50:00Z"));
    // The height-derived size clamps at 72, then the scale multiplies it.
    expect(active?.fontSizePx).toBeCloseTo(216, 2);
  });

  it("clamps padding and scale that arrive out of range", () => {
    const active = resolver.resolve(
      [weekly({ contentPadding: 99, textScale: 5_000 })],
      new Date("2026-07-27T15:50:00Z"),
    );
    expect(active?.contentPadding).toBe(40);
    expect(active?.fontSizePx).toBeCloseTo(30.24 * 5, 1);
  });

  it("applies the persisted server clock offset", () => {
    expect(
      resolver.resolve([weekly()], new Date("2026-07-27T15:45:00Z"), 5 * 60_000)
        ?.value,
    ).toBe("10m 0s");
  });
});

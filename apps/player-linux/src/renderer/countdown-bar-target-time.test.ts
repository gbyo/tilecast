import { describe, expect, it } from "vitest";
import "./countdown-display";
import "./countdown-bar-resolver";

interface CountdownBarPlugin {
  id: string;
  type: string;
  version: number;
  config: {
    message: string;
    scheduleType: "weekly";
    targetTime: string;
    daysOfWeek: number[];
    timezone: string;
    leadTimeSeconds: number;
    completionText: string;
    displayMode: "overlay";
    heightPx: number;
    priority: number;
  };
}

interface CountdownBarResolver {
  resolve(
    plugins: CountdownBarPlugin[],
    now: Date,
  ): { targetAt: string; value: string } | null;
}

const resolver = (
  globalThis as typeof globalThis & {
    tilecastCountdownBar: CountdownBarResolver;
  }
).tilecastCountdownBar;

function weekly(targetTime: string): CountdownBarPlugin {
  return {
    id: "bar-seconds",
    type: "countdown_bar",
    version: 1,
    config: {
      message: "Lunch ends in",
      scheduleType: "weekly",
      targetTime,
      daysOfWeek: [1],
      timezone: "America/New_York",
      leadTimeSeconds: 900,
      completionText: "Lunch is over",
      displayMode: "overlay",
      heightPx: 72,
      priority: 10,
    },
  };
}

describe("countdown bar target time parsing", () => {
  it("preserves seconds from PostgreSQL-style target times", () => {
    const active = resolver.resolve(
      [weekly("12:00:45")],
      new Date("2026-07-27T15:50:00Z"),
    );

    expect(active).toMatchObject({
      targetAt: "2026-07-27T16:00:45.000Z",
      value: "10m 45s",
    });
  });

  it("rejects trailing text instead of treating it as a valid time", () => {
    expect(
      resolver.resolve(
        [weekly("12:00oops")],
        new Date("2026-07-27T15:50:00Z"),
      ),
    ).toBeNull();
  });
});

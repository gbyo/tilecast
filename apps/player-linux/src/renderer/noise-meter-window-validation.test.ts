import { describe, expect, it } from "vitest";
import "./noise-meter";

interface NoiseMeterSchedule {
  scheduleEnabled: boolean;
  scheduleDaysOfWeek: number[];
  scheduleStartTime: string | null;
  scheduleEndTime: string | null;
  scheduleTimezone: string;
}

interface NoiseMeterModule {
  scheduleOpen(settings: NoiseMeterSchedule, at: Date): boolean;
}

const meter = (
  globalThis as typeof globalThis & { tilecastNoiseMeter: NoiseMeterModule }
).tilecastNoiseMeter;

function schedule(overrides: Partial<NoiseMeterSchedule> = {}): NoiseMeterSchedule {
  return {
    scheduleEnabled: true,
    scheduleDaysOfWeek: [1],
    scheduleStartTime: "08:00",
    scheduleEndTime: "15:30",
    scheduleTimezone: "America/Chicago",
    ...overrides,
  };
}

function chicago(hour: number): Date {
  // Monday, August 10, 2026. Chicago is UTC-5 in August.
  return new Date(Date.UTC(2026, 7, 10, hour + 5));
}

describe("noise meter display window time validation", () => {
  it("fails open when a start time has trailing characters", () => {
    expect(
      meter.scheduleOpen(
        schedule({ scheduleStartTime: "08:00oops" }),
        chicago(7),
      ),
    ).toBe(true);
  });

  it("fails open when an end time has trailing characters", () => {
    expect(
      meter.scheduleOpen(
        schedule({ scheduleEndTime: "15:30oops" }),
        chicago(16),
      ),
    ).toBe(true);
  });
});

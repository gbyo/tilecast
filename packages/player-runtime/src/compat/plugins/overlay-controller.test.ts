import { describe, expect, it } from "vitest";
import { ManualClock } from "../../clock/scheduler";
import type { RuntimePluginV1 } from "../../host/contract";
import { PluginOverlayController } from "./overlay-controller";

const noiseMeter = {
  id: "noise-1",
  type: "noise_meter",
  version: 1,
  config: {
    message: "Too loud",
    warningLevel: 60,
    loudLevel: 80,
    sensitivity: 50,
    triggerHoldMs: 0,
    clearHoldMs: 0,
    displayMode: "overlay",
    heightPx: 96,
  },
} as unknown as RuntimePluginV1;

describe("host-measured Noise Meter levels", () => {
  it("tells the host when to open and close its microphone", () => {
    const reports: string[] = [];
    const controller = new PluginOverlayController({
      clock: new ManualClock({ wallMs: Date.parse("2026-09-25T12:00:00Z") }),
      noiseSource: "host-levels",
      reports: {
        noiseMeter: (report) => reports.push(report.status),
        noiseDiagnostic: () => {},
      },
      reducedMotion: () => true,
    });
    controller.setPlugins([noiseMeter], 0);
    expect(reports).toEqual(["active"]);
    controller.hostNoiseLevel(0.9);
    controller.hostNoiseLevel(0.9);
    expect(reports.at(-1)).not.toBe("inactive");
    controller.setPlugins([], 0);
    expect(reports.at(-1)).toBe("inactive");
    controller.stop();
  });

  it("ignores host levels when the runtime measures itself", () => {
    const reports: string[] = [];
    const controller = new PluginOverlayController({
      clock: new ManualClock({ wallMs: Date.parse("2026-09-25T12:00:00Z") }),
      noiseSource: null,
      reports: {
        noiseMeter: (report) => reports.push(report.status),
        noiseDiagnostic: () => {},
      },
      reducedMotion: () => true,
    });
    controller.setPlugins([noiseMeter], 0);
    controller.hostNoiseLevel(0.9);
    expect(reports).not.toContain("active");
    controller.stop();
  });
});

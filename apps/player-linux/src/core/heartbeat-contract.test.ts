import { describe, expect, it } from "vitest";
import { PlayerRuntime, type PlayerHost } from "./player";
import { StateStore } from "./storage";
import type { Heartbeat } from "./types";

describe("Linux Player heartbeat contract", () => {
  it("keeps render-progress measurements in telemetry, not the heartbeat", async () => {
    const host = {
      screenSize: () => ({ width: 1920, height: 1080 }),
      availableStorageBytes: async () => null,
    } as unknown as PlayerHost;
    const runtime = new PlayerRuntime(
      new StateStore("/tmp/tilecast-test"),
      host,
      {
        serverUrl: "http://localhost:8080",
        playerVersion: "0.17.0",
      },
    );
    const internals = runtime as unknown as {
      buildHeartbeat: () => Promise<Heartbeat>;
      playbackState: string;
      currentItemId: string | null;
      renderProgress: { itemStartedAtMs: number | null };
    };
    internals.playbackState = "playing";
    internals.currentItemId = "00000000-0000-4000-8000-000000000001";
    internals.renderProgress.itemStartedAtMs = Date.now();

    const heartbeat = JSON.parse(
      JSON.stringify(await internals.buildHeartbeat()),
    ) as Record<string, unknown>;

    expect(heartbeat.playbackState).toBe("playing");
    expect(Object.keys(heartbeat)).not.toEqual(
      expect.arrayContaining([
        "lastMeaningfulProgressAt",
        "stallStartedAt",
        "stallDurationMs",
        "stallReason",
        "expectedMotion",
        "rendererResponding",
        "currentItemStartedAt",
      ]),
    );
  });
});

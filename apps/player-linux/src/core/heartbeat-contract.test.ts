import { describe, expect, it, vi } from "vitest";
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
      reportStatus: () => Promise<void>;
      credential: object;
      identityVerified: boolean;
      client: { heartbeat: (status: Heartbeat) => Promise<void> };
      socket: { isOpen: boolean; sendStatus: (status: Heartbeat) => boolean };
    };
    internals.playbackState = "playing";
    internals.currentItemId = "00000000-0000-4000-8000-000000000001";
    internals.renderProgress.itemStartedAtMs = Date.now();
    internals.credential = {};
    internals.identityVerified = true;
    const httpHeartbeat = vi.fn(async (_status: Heartbeat) => {});
    const socketStatus = vi.fn((_status: Heartbeat) => true);
    internals.client = { heartbeat: httpHeartbeat };
    internals.socket = { isOpen: true, sendStatus: socketStatus };
    await internals.reportStatus();
    expect(socketStatus).toHaveBeenCalledOnce();
    expect(httpHeartbeat).not.toHaveBeenCalled();
    internals.socket.isOpen = false;
    await internals.reportStatus();
    expect(httpHeartbeat).toHaveBeenCalledOnce();

    const heartbeat = JSON.parse(
      JSON.stringify(await internals.buildHeartbeat()),
    ) as Record<string, unknown>;

    expect(heartbeat.playbackState).toBe("playing");
    for (const field of [
      "lastMeaningfulProgressAt",
      "stallStartedAt",
      "stallDurationMs",
      "stallReason",
      "expectedMotion",
      "rendererResponding",
      "currentItemStartedAt",
    ]) {
      for (const status of [
        heartbeat,
        socketStatus.mock.calls[0][0],
        httpHeartbeat.mock.calls[0][0],
      ]) {
        expect(status).not.toHaveProperty(field);
        expect(status.playbackState).toBe("playing");
        expect(status.currentItemId).toBe(internals.currentItemId);
      }
    }
  });
});

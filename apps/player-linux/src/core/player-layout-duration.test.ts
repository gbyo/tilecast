import { describe, expect, it } from "vitest";
import { PlayerRuntime, type PlayerHost } from "./player";
import { StateStore } from "./storage";
import type { Manifest } from "./types";

const layout = {
  id: "hall",
  revisionId: "revision-1",
  revision: 1,
  documentSha256: "sha",
  document: {
    schemaVersion: 2,
    canvas: {
      width: 1920,
      height: 1080,
      orientation: "landscape",
      backgroundColor: "#000000",
    },
    placements: [],
  },
};

function manifest(playlist?: Manifest["playlist"]): Manifest {
  return {
    schemaVersion: 11,
    manifestVersion: 1,
    screenId: "screen-1",
    generatedAt: "2026-11-09T00:00:00Z",
    mode: "presentation",
    playlist,
    layout,
    layouts: [layout],
    playlists: [],
    schedules: [],
    assets: [],
    serverTime: "2026-11-09T00:00:00Z",
    prefetchHorizonDays: 7,
    activationGraceSeconds: 30,
    websites: [],
  };
}

describe("Linux Layout presentation lifetime", () => {
  it("keeps a directly assigned Layout mounted beyond the 30-second fallback", () => {
    const runtime = new PlayerRuntime(
      new StateStore("/tmp/tilecast-layout-duration-test"),
      { screenSize: () => ({ width: 1920, height: 1080 }) } as PlayerHost,
      { serverUrl: "http://localhost:8080", playerVersion: "0.17.4" },
    );
    const internal = runtime as unknown as {
      activeManifest: Manifest;
      buildPresentation: () => { state: string; items?: { durationMs: number | null }[] };
    };
    internal.activeManifest = manifest();
    const direct = internal.buildPresentation();
    expect(direct.state).toBe("playing");
    expect(direct.items?.[0].durationMs).toBeNull();

    // An authored playlist item still has its own finite playback boundary.
    internal.activeManifest = manifest({
      id: "playlist-1",
      revision: 1,
      name: "Main",
      items: [{
        id: "item-1",
        assetId: "",
        assetType: "layout",
        layoutId: "hall",
        durationMs: 45_000,
        fitMode: "contain",
        transition: "none",
        audioEnabled: false,
        volume: 0,
        deliveryPolicy: "download",
      }],
    });
    expect(internal.buildPresentation().items?.[0].durationMs).toBe(45_000);
  });
});

import { describe, expect, it } from "vitest";
import {
  PlayerRuntime,
  type PlayerHost,
  type Presentation,
} from "./player";
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

function manifest(options: {
  playlist?: Manifest["playlist"];
  rootLayout?: typeof layout;
  manifestVersion?: number;
} = {}): Manifest {
  const rootLayout = options.rootLayout ?? layout;
  return {
    schemaVersion: 11,
    manifestVersion: options.manifestVersion ?? 1,
    screenId: "screen-1",
    generatedAt: "2026-11-09T00:00:00Z",
    mode: "presentation",
    playlist: options.playlist,
    layout: rootLayout,
    layouts: [rootLayout],
    playlists: [],
    schedules: [],
    assets: [],
    serverTime: "2026-11-09T00:00:00Z",
    prefetchHorizonDays: 7,
    activationGraceSeconds: 30,
    websites: [],
  };
}

function runtimeWithPresentations() {
  const presentations: Presentation[] = [];
  const host = {
    screenSize: () => ({ width: 1920, height: 1080 }),
    present: (presentation: Presentation) => presentations.push(presentation),
  } as PlayerHost;
  return {
    runtime: new PlayerRuntime(
      new StateStore("/tmp/tilecast-layout-duration-test"),
      host,
      { serverUrl: "http://localhost:8080", playerVersion: "0.17.4" },
    ),
    presentations,
  };
}

describe("Linux Layout presentation lifetime", () => {
  it("keeps a directly assigned Layout mounted beyond the 30-second fallback", () => {
    const { runtime } = runtimeWithPresentations();
    const internal = runtime as unknown as {
      activeManifest: Manifest;
      buildPresentation: () => {
        state: string;
        items?: { durationMs: number | null }[];
      };
    };
    internal.activeManifest = manifest();
    const direct = internal.buildPresentation();
    expect(direct.state).toBe("playing");
    expect(direct.items?.[0].durationMs).toBeNull();

    // An authored playlist item still has its own finite playback boundary.
    internal.activeManifest = manifest({
      playlist: {
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
      },
    });
    expect(internal.buildPresentation().items?.[0].durationMs).toBe(45_000);
  });

  it("activates manifests immediately when the current root Layout has no boundary", () => {
    const { runtime, presentations } = runtimeWithPresentations();
    const internal = runtime as unknown as {
      activeManifest: Manifest | null;
      pendingManifest: Manifest | null;
      onManifestPrepared: (manifest: Manifest, clockOffsetMs?: number) => void;
    };

    internal.activeManifest = manifest();
    runtime.evaluatePresentation();
    expect(presentations).toHaveLength(1);
    const first = presentations[0];
    expect(first.state).toBe("playing");
    if (first.state !== "playing") throw new Error("expected playing presentation");
    expect(first.items[0]?.durationMs).toBeNull();

    // A manifest-version-only refresh activates without remounting the same
    // Layout. presentationIdentity() keeps the current renderer mount intact.
    internal.onManifestPrepared(manifest({ manifestVersion: 2 }));
    expect(internal.activeManifest?.manifestVersion).toBe(2);
    expect(internal.pendingManifest).toBeNull();
    expect(presentations).toHaveLength(1);

    // A real assignment change cannot wait for an item boundary that this
    // indefinite root Layout will never emit.
    const lobby = {
      ...layout,
      id: "lobby",
      revisionId: "revision-2",
      revision: 2,
      documentSha256: "sha-2",
    };
    internal.onManifestPrepared(
      manifest({ rootLayout: lobby, manifestVersion: 3 }),
    );

    expect(internal.activeManifest?.manifestVersion).toBe(3);
    expect(internal.pendingManifest).toBeNull();
    expect(presentations).toHaveLength(2);
    const replacement = presentations[1];
    expect(replacement.state).toBe("playing");
    if (replacement.state !== "playing") {
      throw new Error("expected playing presentation");
    }
    expect(replacement.items[0]?.durationMs).toBeNull();
    expect(replacement.items[0]?.id).not.toBe(first.items[0]?.id);
  });
});

import { createHash } from "crypto";
import { mkdtempSync, promises as fs } from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "./api";
import { ManifestSync, mediaFileName, requiredDownloads } from "./manifest";
import { StateStore } from "./storage";
import type { Manifest, ManifestAsset, ManifestItem } from "./types";

function asset(overrides: Partial<ManifestAsset>): ManifestAsset {
  return {
    assetId: "a1",
    variantId: "v1",
    mimeType: "image/jpeg",
    sha256: "00",
    fileSize: 1000,
    downloadPath: "/api/v1/player/assets/a1/variants/v1",
    ...overrides,
  };
}

function item(overrides: Partial<ManifestItem>): ManifestItem {
  return {
    id: "i1",
    assetId: "a1",
    variantId: "v1",
    assetType: "image",
    durationMs: 10_000,
    fitMode: "contain",
    transition: "fade",
    audioEnabled: false,
    volume: 1,
    deliveryPolicy: "download",
    ...overrides,
  };
}

function manifest(overrides: Partial<Manifest>): Manifest {
  return {
    schemaVersion: 11,
    manifestVersion: 3,
    screenId: "s",
    generatedAt: "",
    mode: "presentation",
    playlists: [],
    schedules: [],
    assets: [],
    serverTime: "",
    prefetchHorizonDays: 7,
    activationGraceSeconds: 30,
    websites: [],
    ...overrides,
  };
}

describe("requiredDownloads", () => {
  it("downloads download-policy items across all playlists", () => {
    const m = manifest({
      playlist: { id: "p1", revision: 1, name: "", items: [item({})] },
      playlists: [
        {
          id: "p2",
          revision: 1,
          name: "",
          items: [item({ id: "i2", assetId: "a2", variantId: "v2" })],
        },
      ],
      assets: [
        asset({}),
        asset({ assetId: "a2", variantId: "v2" }),
        asset({ assetId: "unreferenced", variantId: "vX" }),
      ],
    });
    const required = requiredDownloads(m);
    expect(required.map((a) => a.assetId).sort()).toEqual(["a1", "a2"]);
  });

  it("automatic policy downloads small video and streams huge video", () => {
    const small = asset({
      assetId: "small",
      variantId: "v",
      mimeType: "video/mp4",
      fileSize: 10 * 1024 * 1024,
    });
    const huge = asset({
      assetId: "huge",
      variantId: "v",
      mimeType: "video/mp4",
      fileSize: 300 * 1024 * 1024,
    });
    const m = manifest({
      playlist: {
        id: "p",
        revision: 1,
        name: "",
        items: [
          item({
            id: "s",
            assetId: "small",
            variantId: "v",
            assetType: "video",
            deliveryPolicy: "automatic",
          }),
          item({
            id: "h",
            assetId: "huge",
            variantId: "v",
            assetType: "video",
            deliveryPolicy: "automatic",
          }),
        ],
      },
      assets: [small, huge],
    });
    expect(requiredDownloads(m).map((a) => a.assetId)).toEqual(["small"]);
  });

  it("stream policy is never downloaded", () => {
    const m = manifest({
      playlist: {
        id: "p",
        revision: 1,
        name: "",
        items: [item({ deliveryPolicy: "stream" })],
      },
      assets: [asset({})],
    });
    expect(requiredDownloads(m)).toEqual([]);
  });

  it("website items have no media but their fallback image is required", () => {
    const m = manifest({
      playlist: {
        id: "p",
        revision: 1,
        name: "",
        items: [
          item({
            id: "w",
            assetId: "site1",
            variantId: null,
            assetType: "website",
            deliveryPolicy: "stream",
          }),
        ],
      },
      websites: [
        {
          assetId: "site1",
          name: "Site",
          url: "https://example.org",
          allowedHosts: ["example.org"],
          javascriptEnabled: true,
          domStorageEnabled: true,
          cookiePolicy: "session",
          reloadPolicy: "interval",
          loadTimeoutSeconds: 20,
          zoomPercent: 100,
          scrollX: 0,
          scrollY: 0,
          backgroundColor: "#000",
          failureBehavior: "fallback_image",
          fallbackImageAssetId: "fb",
          fallbackVariantId: "fbv",
        },
      ],
      assets: [asset({ assetId: "fb", variantId: "fbv" })],
    });
    expect(requiredDownloads(m).map((a) => a.assetId)).toEqual(["fb"]);
  });

  it("layout items are skipped without failing preparation", () => {
    const m = manifest({
      playlist: {
        id: "p",
        revision: 1,
        name: "",
        items: [
          item({ layoutId: "layout-1", assetId: "x", variantId: null }),
          item({ id: "ok" }),
        ],
      },
      assets: [asset({})],
    });
    expect(requiredDownloads(m).map((a) => a.assetId)).toEqual(["a1"]);
  });

  it("caches the exact layout variant when an asset has multiple variants", () => {
    const m = manifest({
      layout: {
        id: "layout-1",
        document: {
          canvas: { backgroundAssetId: "logo", backgroundVariantId: "v2" },
          placements: [],
        },
      },
      assets: [
        asset({ assetId: "logo", variantId: "v1" }),
        asset({ assetId: "logo", variantId: "v2" }),
      ],
    });
    expect(requiredDownloads(m).map((value) => value.variantId)).toEqual([
      "v2",
    ]);
  });

  it("deduplicates an asset shared by multiple items", () => {
    const m = manifest({
      playlist: {
        id: "p",
        revision: 1,
        name: "",
        items: [item({}), item({ id: "i2" })],
      },
      assets: [asset({})],
    });
    expect(requiredDownloads(m)).toHaveLength(1);
  });
});

describe("ManifestSync cache eviction", () => {
  const identity = {
    installationId: "inst",
    screenId: "scr",
    normalizedServerUrl: "http://server.test",
  };

  function playlistManifest(
    version: number,
    assets: ManifestAsset[],
  ): Manifest {
    return manifest({
      manifestVersion: version,
      playlist: {
        id: "p",
        revision: version,
        name: "",
        items: assets.map((a) =>
          item({ id: a.assetId, assetId: a.assetId, variantId: a.variantId }),
        ),
      },
      assets,
    });
  }

  function mediaAsset(id: string, body: Buffer, baseUrl = ""): ManifestAsset {
    return asset({
      assetId: id,
      variantId: "v",
      fileSize: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      downloadPath: `${baseUrl}/${id}`,
    });
  }

  async function setup(active: Manifest, candidate: Manifest) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tilecast-manifest-"));
    const store = new StateStore(dir);
    await store.init();
    await store.writeJson("manifest-active.json", {
      manifest: active,
      etag: '"a"',
      storedAt: new Date().toISOString(),
      ...identity,
    });
    const client = {
      manifest: async () => ({ value: candidate, etag: '"b"' }),
      url: (p: string) => p,
      authHeaders: () => ({}),
    };
    const sync = new ManifestSync(store, client as unknown as ApiClient, {
      onManifestPrepared() {},
      onCredentialRejected() {},
      onSyncError() {},
    });
    sync.setIdentity(identity);
    await sync.loadCached();
    return { store, sync };
  }

  async function seed(store: StateStore, name: string, body: Buffer) {
    await fs.mkdir(store.mediaDir(), { recursive: true });
    await fs.writeFile(path.join(store.mediaDir(), name), body);
  }

  const files = async (store: StateStore) =>
    (await fs.readdir(store.mediaDir())).sort();

  it("keeps the active manifest's media when the candidate exceeds the cache policy", async () => {
    const aBody = Buffer.alloc(1000, 1);
    const a = mediaAsset("a", aBody);
    const b = mediaAsset("b", Buffer.alloc(5000, 2));
    const { store, sync } = await setup(
      playlistManifest(1, [a]),
      playlistManifest(2, [b]),
    );
    await seed(store, mediaFileName(a), aBody);
    sync.applyPolicy(2000, 0, 1e6, 1, 300);
    await sync.syncNow("test");
    expect(await files(store)).toEqual([mediaFileName(a)]);
    expect(await sync.cachedPath(a)).not.toBeNull();
    expect(sync.lastSyncError).toContain("insufficient cache space");
  });

  it("still evicts media that neither manifest references", async () => {
    const aBody = Buffer.alloc(1000, 1);
    const a = mediaAsset("a", aBody);
    const b = mediaAsset("b", Buffer.alloc(5000, 2));
    const { store, sync } = await setup(
      playlistManifest(1, [a]),
      playlistManifest(2, [b]),
    );
    await seed(store, mediaFileName(a), aBody);
    await seed(store, "orphan-v", Buffer.alloc(500, 3));
    sync.applyPolicy(2000, 0, 1e6, 1, 300);
    await sync.syncNow("test");
    expect(await files(store)).toEqual([mediaFileName(a)]);
  });

  it("releases the active media only when the candidate cannot fit otherwise", async () => {
    const aBody = Buffer.alloc(1000, 1);
    const bBody = Buffer.alloc(1500, 2);
    const server = http.createServer((_req, res) => res.end(bBody));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const { port } = server.address() as { port: number };
      const a = mediaAsset("a", aBody);
      const b = mediaAsset("b", bBody, `http://127.0.0.1:${port}`);
      const { store, sync } = await setup(
        playlistManifest(1, [a]),
        playlistManifest(2, [b]),
      );
      await seed(store, mediaFileName(a), aBody);
      sync.applyPolicy(2000, 0, 1e6, 1, 300);
      await sync.syncNow("test");
      expect(sync.lastSyncError).toBeNull();
      expect(await files(store)).toEqual([mediaFileName(b)]);
    } finally {
      server.close();
    }
  });
});

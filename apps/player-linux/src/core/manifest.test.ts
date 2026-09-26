import { describe, expect, it } from "vitest";
import { requiredDownloads } from "./manifest";
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

import { describe, expect, it } from "vitest";
import type { Asset } from "../../api/types";
import { contentTypeLabel } from "./ContentLibraryGrid";

const base: Asset = {
  id: "asset-1",
  name: "Test",
  description: "",
  type: "widget",
  originalFilename: "",
  declaredMimeType: "application/json",
  detectedMimeType: "application/json",
  sha256: "aabb",
  originalSize: 100,
  metadata: {},
  processingStatus: "ready",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  variants: [],
  playlistUsage: 0,
  layoutUsage: [],
  tags: [],
  collectionIds: [],
};

const widgetAsset = (provider: string): Asset => ({
  ...base,
  widget: {
    provider,
    configVersion: 1,
    configuration: {},
  },
});

// contentTypeLabel resolves through the i18n key, so the fake translator
// echoes the key: the assertions prove which label each provider selects.
const t = ((key: string) => key) as Parameters<typeof contentTypeLabel>[1];

describe("contentTypeLabel", () => {
  it("keeps the Website label for website widgets", () => {
    expect(contentTypeLabel(widgetAsset("website"), t)).toBe(
      "media.type.websiteWidget",
    );
  });

  it("keeps the YouTube label for youtube widgets", () => {
    expect(contentTypeLabel(widgetAsset("youtube"), t)).toBe(
      "media.type.youtubeWidget",
    );
  });

  it("uses the generic Widget label for built-in native widgets", () => {
    expect(contentTypeLabel(widgetAsset("clock"), t)).toBe("media.type.widget");
    expect(contentTypeLabel(widgetAsset("weather"), t)).toBe(
      "media.type.widget",
    );
    expect(contentTypeLabel(widgetAsset("agenda"), t)).toBe(
      "media.type.widget",
    );
  });

  it("uses the generic Widget label for unknown plugin providers", () => {
    expect(contentTypeLabel(widgetAsset("my-plugin-gadget"), t)).toBe(
      "media.type.widget",
    );
  });
});

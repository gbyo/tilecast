import { expect, it } from "vitest";
import { projectManifestItems } from "./items";
import type { Manifest, ManifestItem } from "./types";

const assetId = "a";
const variantId = "v";
const item: ManifestItem = {
  id: "item",
  assetId,
  variantId,
  assetType: "video",
  fitMode: "cover",
  transition: "fade",
  audioEnabled: false,
  volume: 25,
  videoStartOffsetMs: 1000,
  videoEndOffsetMs: 3000,
  deliveryPolicy: "download",
};
const manifest = {
  assets: [{ assetId, variantId, mimeType: "video/mp4" }],
  widgets: [],
  websites: [],
} as unknown as Manifest;
it("projects only an explicit host grant and keeps authored video settings", () => {
  expect(
    projectManifestItems(manifest, [item], undefined, new Date(), [
      { assetId, variantId, uri: "/player/media/1/opaque" },
    ]),
  ).toMatchObject([
    {
      kind: "video",
      src: "/player/media/1/opaque",
      fitMode: "cover",
      transition: "fade",
      audioEnabled: false,
      volume: 25,
      videoStartOffsetMs: 1000,
      videoEndOffsetMs: 3000,
    },
  ]);
  expect(() =>
    projectManifestItems(manifest, [item], undefined, new Date(), []),
  ).toThrow("not authorized");
});
it("leaves layouts and widgets as references for the one shared projector", () => {
  const references = {
    ...manifest,
    widgets: [{ assetId: "widget" }],
  } as unknown as Manifest;
  expect(
    projectManifestItems(
      references,
      [
        { ...item, assetId: "widget", assetType: "widget", variantId: null },
        { ...item, layoutId: "layout" },
      ],
      undefined,
      new Date(),
      [],
    ),
  ).toMatchObject([
    { kind: "widget", widget: { widgetAssetId: "widget" } },
    { kind: "layout", layout: { layoutId: "layout" } },
  ]);
});
it("does not project an expired occurrence", () => {
  expect(
    projectManifestItems(
      manifest,
      [{ ...item, expiresAt: "2020-01-01T00:00:00Z" }],
      undefined,
      new Date(),
      [],
    ),
  ).toEqual([]);
});

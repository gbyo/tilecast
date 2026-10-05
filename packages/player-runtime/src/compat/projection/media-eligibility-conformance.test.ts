import { describe, expect, it } from "vitest";
import fixtures from "../../../../presentation-model/fixtures/media-eligibility.json";
import { renderLayout } from "./layout-render";
import type { Manifest } from "./types";
import type { LayoutDocument } from "./content-types";

const document: LayoutDocument = {
  schemaVersion: 2,
  canvas: {
    width: 100,
    height: 100,
    orientation: "landscape",
    backgroundColor: "#000000",
  },
  placements: [
    {
      id: "zone",
      type: "playlistZone",
      name: "zone",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      layer: 0,
      opacity: 1,
      visible: true,
      locked: false,
      playlistId: "playlist",
      playback: { loop: true, fallback: "blank" },
    },
  ],
};

describe("Layout projection adopts media eligibility fixtures", () => {
  it.each(fixtures.cases)("$name", (fixture) => {
    const item = {
      id: "item",
      durationMs: 5000,
      fitMode: "contain",
      transition: "none",
      audioEnabled: false,
      volume: 0,
      deliveryPolicy: "download",
      ...fixtures.item,
      ...fixture.item,
    };
    const asset =
      fixture.asset == null
        ? null
        : {
            sha256: "fixture",
            fileSize: 1,
            downloadPath: "/fixture",
            ...fixtures.asset,
            ...fixture.asset,
          };
    const manifest = {
      playlists: [{ id: "playlist", items: [item] }],
      assets: asset ? [asset] : [],
    } as unknown as Manifest;
    const payload = renderLayout(document, {
      manifest,
      widgets: new Map(),
      dataSources: new Map(),
      at: new Date(fixtures.at),
    });
    expect(
      payload?.zones[0]?.playlistItems?.map((entry) => entry.kind) ?? [],
    ).toEqual(fixture.kind ? [fixture.kind] : []);
  });
});

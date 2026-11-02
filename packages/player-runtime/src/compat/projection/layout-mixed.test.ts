import { describe, expect, it } from "vitest";
import type {
  ProjectionContextV1,
  RuntimeItem,
  RuntimeLayoutPayload,
} from "../../host/contract";
import { createProjector } from "../projector";

const placement = {
  id: "zone",
  type: "playlistZone",
  playlistId: "mix",
  x: 0,
  y: 0,
  width: 960,
  height: 1080,
  layer: 0,
  opacity: 1,
  visible: true,
};
const component = {
  assetId: "component",
  name: "Clock",
  provider: "clock",
  configVersion: 1,
  configuration: {},
  presentation: {
    schemaVersion: 3,
    kind: "component",
    requiredCapabilities: { "widget.tilecast.clock": 1 },
    component: {
      type: "tilecast.clock",
      version: 1,
      config: { title: "Clock" },
      dataSources: [],
      media: [{ assetId: "image", variantId: "original" }],
      empty: "render",
    },
  },
};
const occurrence = (id: string, assetType = "widget") => ({
  id,
  assetId: id,
  assetType,
  durationMs: 1234,
  fitMode: "contain",
  transition: "crossfade",
  audioEnabled: false,
  volume: 0,
  variantId: assetType === "image" || assetType === "video" ? "original" : null,
});

function project(widget = component, extra: Partial<ProjectionContextV1> = {}) {
  const manifest = {
    assets: [
      { assetId: "image", variantId: "original", mimeType: "image/png" },
      { assetId: "video", variantId: "original", mimeType: "video/mp4" },
    ],
    widgets: [widget],
    dataSources: [],
    playlists: [
      {
        id: "mix",
        items: [
          occurrence("image", "image"),
          occurrence("component"),
          occurrence("video", "video"),
          occurrence("component"),
        ],
      },
    ],
    layouts: [
      {
        id: "layout",
        document: {
          schemaVersion: 2,
          canvas: { width: 1920, height: 1080, backgroundColor: "#000" },
          placements: [
            placement,
            {
              ...placement,
              id: "fixed",
              type: "widget",
              widgetId: "component",
              playlistId: undefined,
            },
          ],
        },
      },
    ],
  };
  const projector = createProjector({
    schema: 1,
    clockOffsetMs: 0,
    manifest,
    media: [
      { assetId: "image", variantId: "original", uri: "authorized-image" },
      { assetId: "video", variantId: "original", uri: "authorized-video" },
    ],
    ...extra,
  })!;
  const item: RuntimeItem = {
    id: "layout",
    kind: "layout",
    layout: { layoutId: "layout" },
    src: "",
    durationMs: null,
    fitMode: "contain",
    audioEnabled: false,
    volume: 0,
    videoStartOffsetMs: null,
    videoEndOffsetMs: null,
  };
  const presentation = projector.project(
    { state: "playing", generation: 1, items: [item] },
    Date.parse("2026-10-13T12:00:00Z"),
  );
  if (presentation.state !== "playing") throw new Error("expected playing");
  return presentation.items[0]!.layout as RuntimeLayoutPayload;
}

describe("Layout mixed playlist projection", () => {
  it("translates a rotating package Widget through its sandbox frame and media grants", () => {
    const frameDigest = "c".repeat(64);
    const external = {
      ...component,
      presentation: {
        ...component.presentation,
        component: {
          ...component.presentation.component,
          type: "acme.athletics.scoreboard",
          package: {
            packageId: "acme.athletics",
            digest: `sha256:${"a".repeat(64)}`,
            frame: {
              sha256: frameDigest,
              fileSize: 4242,
              downloadPath:
                "/api/v1/player/packages/acme.athletics/widgets/scoreboard/frame",
            },
          },
        },
      },
    };
    const grants: Partial<ProjectionContextV1> = {
      widgetFrames: [
        {
          packageId: "acme.athletics",
          packageDigest: `sha256:${"a".repeat(64)}`,
          frameDigest,
          uri: "authorized-frame",
        },
      ],
      widgetMedia: [
        { assetId: "image", variantId: "original", uri: "sandbox-image" },
      ],
    };
    expect(
      project(external, grants).zones[0]?.playlistItems?.[1],
    ).toMatchObject({
      widget: {
        execution: { kind: "sandboxed", frameUrl: "authorized-frame" },
        media: { "image/original": "sandbox-image" },
      },
    });
    expect(() => project(external)).toThrow("frame is not authorized");
  });
  it("uses the placement component payload and authorized resources without collapsing Widgets into trees", () => {
    const layout = project();
    const entries = layout.zones[0]!.playlistItems!;
    expect(entries.map((entry) => entry.kind)).toEqual([
      "image",
      "widget",
      "video",
      "widget",
    ]);
    expect(entries[1]).toEqual({
      id: "component",
      kind: "widget",
      widget: layout.zones[1]!.component,
      durationMs: 1234,
      radius: 0,
      transition: "crossfade",
    });
    expect(entries[1]).toMatchObject({
      widget: { media: { "image/original": "authorized-image" } },
    });
    expect(entries[0]).toMatchObject({ src: "authorized-image" });
    expect(entries[2]).toMatchObject({ src: "authorized-video" });
  });
  it("rejects unauthorized media inside a rotating component", () => {
    expect(() => project(component, { media: [] })).toThrow("not authorized");
  });
  it("rejects a malformed component instead of silently dropping its occurrence", () => {
    expect(() =>
      project({
        ...component,
        presentation: {
          ...component.presentation,
          component: { ...component.presentation.component, type: "invalid" },
        },
      }),
    ).toThrow("projection failed");
  });
});

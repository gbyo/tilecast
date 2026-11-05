/*
 * Organization library fonts on Layout text: the projection names the
 * family's faces as media aliases, the projector authorizes them through
 * the host table, and text without a usable library face keeps its bundled
 * fallback family.
 */
import { describe, expect, it } from "vitest";
import type {
  ProjectionContextV1,
  RuntimeItem,
  RuntimePresentation,
} from "../../host/contract";
import { createProjector } from "../projector";
import { layoutFonts, renderLayout } from "./layout-render";
import type { Manifest } from "./types";

const FONT = "5c0a2f8e-3c1b-4d2a-9e7f-0a1b2c3d4e5f";
const ASSET = "1f8f2d8e-1b1a-4c55-9a0d-3d2f6c7b8a90";
const VARIANT = "7b6a5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const LAYOUT = "5e2b86f4-4d49-4a8e-b0a4-2b5c1c9f7d10";
const CAP = "tcmedia://cap/" + "d".repeat(64);

const fontAsset = {
  assetId: ASSET,
  variantId: VARIANT,
  mimeType: "font/woff2",
  sha256: "0".repeat(64),
  fileSize: 48256,
  downloadPath: `/api/v1/player/assets/${ASSET}/variants/${VARIANT}`,
};

const fonts = [
  {
    id: FONT,
    family: "Fixture Display",
    faces: [
      {
        assetId: ASSET,
        variantId: VARIANT,
        style: "normal",
        weightMin: 100,
        weightMax: 900,
        unicodeRange: "U+0000-00FF",
      },
    ],
  },
];

function textDocument(fontId: string | null) {
  return {
    schemaVersion: 2,
    canvas: {
      width: 1920,
      height: 1080,
      orientation: "landscape",
      backgroundColor: "#101010",
    },
    placements: [
      {
        id: "welcome",
        type: "primitive",
        name: "Welcome",
        x: 0,
        y: 0,
        width: 1200,
        height: 200,
        layer: 0,
        opacity: 1,
        visible: true,
        locked: false,
        primitive: {
          kind: "text",
          text: "Welcome",
          fontFamily: "Roboto",
          fontId,
          fontWeight: 700,
        },
      },
    ],
  };
}

function render(fontId: string | null, assets: unknown[] = [fontAsset]) {
  const payload = renderLayout(textDocument(fontId), {
    manifest: { assets } as unknown as Manifest,
    widgets: new Map(),
    dataSources: new Map(),
    at: new Date(Date.UTC(2026, 10, 4)),
    fonts: layoutFonts(fonts),
  });
  return (
    payload!.zones[0] as unknown as {
      render: { style: Record<string, unknown> };
    }
  ).render.style;
}

describe("Layout text with a library font", () => {
  it("uses the generated family first and lists its faces as media aliases", () => {
    const style = render(FONT);
    expect(style["fontFamily"]).toBe(`tcf-${FONT}, Roboto`);
    expect(style["fontFaces"]).toEqual([
      {
        family: `tcf-${FONT}`,
        src: `tcmedia://variant/${ASSET}/${VARIANT}`,
        weight: "100 900",
        style: "normal",
        unicodeRange: "U+0000-00FF",
      },
    ]);
  });

  it("keeps the bundled fallback when the family or its file is missing", () => {
    expect(render(null)["fontFamily"]).toBe("Roboto");
    expect(render("00000000-0000-4000-8000-000000000000")["fontFamily"]).toBe(
      "Roboto",
    );
    const withoutFile = render(FONT, []);
    expect(withoutFile["fontFamily"]).toBe("Roboto");
    expect(withoutFile["fontFaces"]).toBeUndefined();
  });

  it("authorizes face sources through the host media table", () => {
    const projection: ProjectionContextV1 = {
      schema: 1,
      clockOffsetMs: 0,
      manifest: {
        assets: [fontAsset],
        playlists: [],
        widgets: [],
        dataSources: [],
        layouts: [{ id: LAYOUT, document: textDocument(FONT), fonts }],
      },
      media: [{ assetId: ASSET, variantId: VARIANT, uri: CAP }],
    };
    const item: RuntimeItem = {
      id: "layout-1",
      kind: "layout",
      src: "",
      durationMs: 5000,
      fitMode: "contain",
      transition: "none",
      audioEnabled: false,
      volume: 0,
      videoStartOffsetMs: null,
      videoEndOffsetMs: null,
      layout: { layoutId: LAYOUT },
    };
    const projected = createProjector(projection)!.project(
      {
        state: "playing",
        items: [item],
        takeover: false,
        generation: 1,
        synchronized: false,
      },
      Date.UTC(2026, 10, 4),
    ) as Extract<RuntimePresentation, { state: "playing" }>;
    const serialized = JSON.stringify(projected);
    expect(serialized).toContain(`"src":"${CAP}"`);
    expect(serialized).not.toContain("tcmedia://variant/");
  });
});

/*
 * Widget and layout references projected inside the runtime: the reference
 * projection code runs at the host-corrected clock, media is addressed only
 * through the host's alias table, and a presentation the runtime cannot
 * project is rejected instead of shown partially. (Ported from the WPE
 * bridge's projection test when projection moved into the runtime.)
 */
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock/scheduler";
import type {
  PresentationResultV1,
  ProjectionContextV1,
  RuntimeItem,
  RuntimePresentation,
} from "../host/contract";
import { PlaybackController } from "../engine/controller";
import { createProjector } from "./projector";

const ASSET = "844f4a48-a47c-4fbd-8a84-f8d61cc64b6a";
const VARIANT = "46784d73-3daf-45cf-8ff0-7cb4a3d12852";
const WIDGET = "0c3e1d2f-7a55-4b1e-9c33-6f0d2e8a4b91";
const LAYOUT = "5e2b86f4-4d49-4a8e-b0a4-2b5c1c9f7d10";
const CAP = "tcmedia://cap/" + "a".repeat(64);

const widget = {
  assetId: WIDGET,
  name: "Greeting",
  provider: "text",
  presentation: {
    schemaVersion: 1,
    kind: "native",
    requiredCapabilities: { "content.text": 1 },
    native: {
      root: {
        type: "text",
        binding: { source: "literal", value: "Welcome to Edge" },
      },
    },
  },
};

const manifest = {
  assets: [
    {
      assetId: ASSET,
      variantId: VARIANT,
      mimeType: "image/png",
      sha256: "0".repeat(64),
      fileSize: 68,
      downloadPath: `/api/v1/player/assets/${ASSET}/variants/${VARIANT}`,
    },
  ],
  playlists: [],
  widgets: [widget],
  dataSources: [],
  layouts: [
    {
      id: LAYOUT,
      document: {
        schemaVersion: 2,
        canvas: { width: 1920, height: 1080, backgroundColor: "#101010" },
        placements: [
          {
            id: "zone-text",
            type: "widget",
            widgetId: WIDGET,
            x: 0,
            y: 0,
            width: 960,
            height: 1080,
            layer: 0,
            opacity: 1,
            visible: true,
          },
          {
            id: "zone-image",
            type: "asset",
            assetId: ASSET,
            variantId: VARIANT,
            x: 960,
            y: 0,
            width: 960,
            height: 1080,
            layer: 1,
            opacity: 1,
            visible: true,
            playback: { fit: "cover" },
          },
        ],
      },
    },
  ],
};

const projection: ProjectionContextV1 = {
  schema: 1,
  clockOffsetMs: 0,
  manifest,
  media: [{ assetId: ASSET, variantId: VARIANT, uri: CAP }],
};

function item(
  id: string,
  kind: RuntimeItem["kind"],
  extra: Partial<RuntimeItem>,
): RuntimeItem {
  return {
    id,
    kind,
    src: "",
    durationMs: 5000,
    fitMode: "contain",
    transition: "none",
    audioEnabled: false,
    volume: 0,
    videoStartOffsetMs: null,
    videoEndOffsetMs: null,
    ...extra,
  };
}

const playing = (items: RuntimeItem[]): RuntimePresentation => ({
  state: "playing",
  items,
  takeover: false,
  generation: 3,
  synchronized: false,
});

describe("projection of widget and layout references", () => {
  it("projects with the reference code and capability media", () => {
    const projector = createProjector(projection)!;
    const projected = projector.project(
      playing([
        item("layout-1", "layout", { layout: { layoutId: LAYOUT } }),
        item("w1", "widget", { widget: { widgetAssetId: WIDGET } }),
      ]),
      Date.UTC(2026, 8, 1),
    ) as Extract<RuntimePresentation, { state: "playing" }>;
    const [layoutItem, widgetItem] = projected.items;
    const zones = (
      layoutItem!.layout as unknown as { zones: Record<string, unknown>[] }
    ).zones;
    expect(zones).toHaveLength(2);
    expect(zones[0]!["render"]).toMatchObject({
      t: "text",
      value: "Welcome to Edge",
    });
    expect((zones[1]!["image"] as { src: string }).src).toBe(CAP);
    expect(widgetItem!.widget).toMatchObject({ root: { t: "text" } });
    expect(JSON.stringify(projected)).not.toContain("tcmedia://variant/");
  });

  it("skips an item that cannot render; none left is unavailable", () => {
    const projector = createProjector(projection)!;
    const projected = projector.project(
      playing([
        item("missing", "widget", {
          widget: { widgetAssetId: "11111111-2222-4333-8444-555555555555" },
        }),
      ]),
      Date.UTC(2026, 8, 1),
    );
    expect(projected.state).toBe("unavailable");
  });

  function controller() {
    const clock = new ManualClock({ wallMs: Date.UTC(2026, 8, 1, 12) });
    const results: PresentationResultV1[] = [];
    const started: string[] = [];
    const playback = new PlaybackController({
      clock,
      synchronizedPlayback: false,
      reports: {
        evidence: (_activation, kind, itemId) => {
          if (kind === "item-started") started.push(itemId ?? "-");
        },
        playbackError: () => {},
        presentationResult: (result) => results.push(result),
        websiteRecovered: () => {},
      },
    });
    return { clock, results, started, playback };
  }

  it("rejects references without a projection context, never shows them", () => {
    const h = controller();
    h.playback.present({
      type: "presentation",
      presentation: playing([
        item("w1", "widget", { widget: { widgetAssetId: WIDGET } }),
      ]),
      activation: { activationId: "a", generation: 7 },
    });
    expect(h.results.at(-1)?.outcome).toBe("rejected");
    expect(h.started).toEqual([]);
    expect(h.playback.state.mode).toBe("waiting");
  });

  it("re-projects on the cadence and restarts only when the tree changed", () => {
    const h = controller();
    h.playback.present({
      type: "presentation",
      presentation: playing([
        item("w1", "widget", {
          durationMs: null,
          widget: { widgetAssetId: WIDGET },
        }),
      ]),
      activation: { activationId: "a", generation: 7 },
      projection,
    });
    expect(h.results.at(-1)?.outcome).toBe("accepted");
    expect(h.started).toEqual(["w1"]);
    h.clock.advance(30_000);
    expect(h.started).toEqual(["w1"]);
  });
});

describe("projection under the host's player configuration", () => {
  const CLOCK = "7a0e6a1c-3f25-4b8e-9d11-2c4e5f6a7b8c";
  const clockManifest = {
    ...manifest,
    widgets: [
      {
        assetId: CLOCK,
        name: "Lobby clock",
        provider: "clock",
        config: {},
      },
    ],
  };
  const clockItem = item("clock", "widget", {
    widget: { widgetAssetId: CLOCK },
  });

  function projectedClock(context: ProjectionContextV1) {
    const projected = createProjector(context)!.project(
      playing([clockItem]),
      Date.UTC(2026, 8, 24, 13),
    ) as Extract<RuntimePresentation, { state: "playing" }>;
    return JSON.stringify(projected.items[0]!.widget);
  }

  it("uses the configured regional format, as the Electron main process does", () => {
    const configured = projectedClock({
      ...projection,
      manifest: clockManifest,
      playback: {
        regionalFormat: {
          locale: "es-US",
          timezone: "America/Chicago",
          dateFormat: "locale",
          timeFormat: "12-hour",
          firstDayOfWeek: "sunday",
        },
      },
    });
    expect(configured).toContain('"timezone":"America/Chicago"');
    expect(configured).toContain('"locale":"es-US"');
    expect(configured).toContain('"hour12":true');
  });

  it("keeps the projection defaults when the host sends no configuration", () => {
    const defaults = projectedClock({ ...projection, manifest: clockManifest });
    expect(defaults).not.toContain("America/Chicago");
    expect(defaults).not.toContain("es-US");
  });
});

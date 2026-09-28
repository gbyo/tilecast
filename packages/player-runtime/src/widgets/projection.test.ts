/*
 * Projection of first-class Widget components (docs/widgets-v2.md §6): the
 * payload carries only what the component declares, never a time-dependent
 * value, and a malformed component is left out rather than downgraded.
 */
import { describe, expect, it } from "vitest";
import type { ProjectionContextV1 } from "../host/contract";
import { createProjector } from "../compat/projector";
import { resolveRegionalFormatting } from "../compat/projection/format";
import { renderLayout } from "../compat/projection/layout-render";
import type {
  ManifestDataSource,
  ManifestWidget,
} from "../compat/projection/content-types";
import type { Manifest } from "../compat/projection/types";
import { projectWidgetComponent } from "./projection";

const SOURCE = "6f5f2f7e-1c1a-4e8e-9b61-3a2d8d2f1c10";
const OTHER_SOURCE = "0b8a7c52-6c2f-4c65-9a5e-8e0e1f3a2b44";
const ASSET = "844f4a48-a47c-4fbd-8a84-f8d61cc64b6a";
const VARIANT = "46784d73-3daf-45cf-8ff0-7cb4a3d12852";
const WIDGET = "0c3e1d2f-7a55-4b1e-9c33-6f0d2e8a4b91";

const componentWidget = (
  component: Record<string, unknown>,
  schemaVersion = 2,
): ManifestWidget => ({
  assetId: WIDGET,
  name: "Lobby Clock",
  provider: "clock",
  configVersion: 1,
  configuration: {},
  presentation: {
    schemaVersion,
    kind: "component",
    requiredCapabilities: { "widget.tilecast.clock": 1 },
    component: component as never,
  },
});

const document = (label: string) => ({
  schemaVersion: 1,
  datasets: [{ id: "current", kind: "object", attribution: label }],
});

const sources = new Map<string, ManifestDataSource>([
  [
    SOURCE,
    {
      id: SOURCE,
      name: "Weather",
      provider: "weather",
      configVersion: 1,
      configuration: {},
      dataDocument: document("granted"),
    },
  ],
  [
    OTHER_SOURCE,
    {
      id: OTHER_SOURCE,
      name: "Other",
      provider: "json",
      configVersion: 1,
      configuration: {},
      dataDocument: document("secret"),
    },
  ],
]);

const context = {
  dataSources: sources,
  assets: [
    {
      assetId: ASSET,
      variantId: VARIANT,
      mimeType: "image/png",
      sha256: "0".repeat(64),
      fileSize: 68,
      downloadPath: "/x",
    },
  ],
  regionalFormat: resolveRegionalFormatting({
    locale: "en-GB",
    timezone: "Europe/London",
    dateFormat: "locale",
    timeFormat: "24-hour",
    firstDayOfWeek: "monday",
  }),
};

describe("projectWidgetComponent", () => {
  it("projects the declared resources and regional formatting", () => {
    const payload = projectWidgetComponent(
      componentWidget({
        type: "tilecast.clock",
        version: 1,
        config: { style: "analog" },
        dataSources: [SOURCE],
        media: [
          { assetId: ASSET, variantId: VARIANT },
          { assetId: ASSET, variantId: "not-in-manifest" },
        ],
      }),
      context,
    );
    expect(payload).toEqual({
      component: {
        type: "tilecast.clock",
        version: 1,
        config: { style: "analog" },
        dataSources: [SOURCE],
        media: [
          { assetId: ASSET, variantId: VARIANT },
          { assetId: ASSET, variantId: "not-in-manifest" },
        ],
      },
      // The undeclared source is not copied in.
      documents: { [SOURCE]: document("granted") },
      // Only variants the manifest carries become URIs.
      media: {
        [`${ASSET}/${VARIANT}`]: `tcmedia://variant/${ASSET}/${VARIANT}`,
      },
      regional: {
        locale: "en-GB",
        timeZone: "Europe/London",
        hourCycle: "h23",
      },
    });
  });

  it.each([
    ["a native presentation", { kind: "native" }],
    ["presentation schema 1", "schema1"],
    ["an unnamespaced type", { type: "clock" }],
    ["a fractional version", { version: 1.5 }],
    ["an array config", { config: [] }],
    ["too many sources", { dataSources: new Array(9).fill(SOURCE) }],
    ["a path-like source id", { dataSources: ["../../etc/passwd"] }],
    ["a hostile media id", { media: [{ assetId: "a/b", variantId: "c" }] }],
  ])("leaves out %s", (_label, change) => {
    const base = {
      type: "tilecast.clock",
      version: 1,
      config: {},
      dataSources: [],
      media: [],
    };
    const widget =
      change === "schema1"
        ? componentWidget(base, 1)
        : componentWidget({ ...base, ...(change as object) });
    if ((change as { kind?: string }).kind) {
      widget.presentation!.kind = (change as { kind: string }).kind;
    }
    expect(projectWidgetComponent(widget, context)).toBeNull();
  });
});

describe("component projection in hosts", () => {
  const widget = componentWidget({
    type: "tilecast.clock",
    version: 1,
    config: { showSeconds: true },
    dataSources: [],
    media: [],
  });

  it("is identical at every instant, so re-projection never restarts it", () => {
    const projection: ProjectionContextV1 = {
      schema: 16,
      clockOffsetMs: 0,
      manifest: { widgets: [widget], dataSources: [] },
      media: [],
    };
    const projector = createProjector(projection)!;
    const presentation = {
      state: "playing" as const,
      generation: 1,
      items: [
        {
          id: "clock-item",
          kind: "widget" as const,
          src: "",
          durationMs: null,
          fitMode: "contain",
          audioEnabled: false,
          volume: 1,
          videoStartOffsetMs: null,
          videoEndOffsetMs: null,
          widget: { widgetAssetId: WIDGET },
        },
      ],
    };
    const first = projector.project(
      presentation,
      Date.parse("2026-09-01T08:00:00Z"),
    );
    const later = projector.project(
      presentation,
      Date.parse("2026-09-02T17:59:59Z"),
    );
    expect(JSON.stringify(later)).toBe(JSON.stringify(first));
    expect(first.state === "playing" && first.items[0]!.widget).toMatchObject({
      component: { type: "tilecast.clock" },
    });
  });

  it("keeps the component in a Layout zone instead of a render tree", () => {
    const layout = renderLayout(
      {
        schemaVersion: 2,
        canvas: {
          width: 1920,
          height: 1080,
          orientation: "landscape",
          backgroundColor: "#000000",
        },
        placements: [
          {
            id: "zone-1",
            type: "widget",
            name: "Clock",
            x: 1440,
            y: 0,
            width: 480,
            height: 1080,
            layer: 1,
            opacity: 1,
            visible: true,
            locked: false,
            widgetId: WIDGET,
          },
        ],
      },
      {
        manifest: { assets: [], playlists: [] } as unknown as Manifest,
        widgets: new Map([[WIDGET, widget]]),
        dataSources: new Map(),
        at: new Date("2026-09-01T08:00:00Z"),
      },
      undefined,
    );
    expect(layout?.zones[0]).toMatchObject({
      id: "zone-1",
      component: { component: { type: "tilecast.clock" } },
    });
    expect(layout?.zones[0]?.render).toBeUndefined();
  });
});

/*
 * Projection of first-class Widget components (docs/widgets-v2.md §6): the
 * payload carries only declared resources and applies date-selection policy
 * before a component receives its document.
 */
import { describe, expect, it } from "vitest";
import type { ProjectionContextV1 } from "../host/contract";
import { createProjector } from "../compat/projector";
import { resolveRegionalFormatting } from "../compat/projection/format";
import { normalizeSource } from "../compat/projection/datasource";
import { renderLayout } from "../compat/projection/layout-render";
import type {
  DataDocument,
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
  at: new Date("2026-07-15T12:00:00-04:00"),
};

function sourceWithDateSelection(
  dates: readonly string[],
  selection: NonNullable<
    ManifestDataSource["dataDocument"]
  >["datasets"][number]["dateSelection"],
): ManifestDataSource {
  return {
    id: SOURCE,
    name: "Events",
    provider: "manual",
    configVersion: 1,
    configuration: {},
    dataDocument: {
      schemaVersion: 1,
      datasets: [
        {
          id: "events",
          kind: "records",
          dateSelection: selection,
          records: dates.map((date, index) => ({
            id: `event-${index}`,
            values: { date: { kind: "date", date } },
          })),
        },
      ],
    },
  };
}

function selectedRecordIds(
  source: ManifestDataSource,
  at: Date,
  firstDayOfWeek:
    | "sunday"
    | "monday"
    | "tuesday"
    | "wednesday"
    | "thursday"
    | "friday"
    | "saturday" = "monday",
): string[] | null {
  const regionalFormat = resolveRegionalFormatting({
    locale: "en-US",
    timezone: "America/New_York",
    dateFormat: "locale",
    timeFormat: "locale",
    firstDayOfWeek,
  });
  const payload = projectWidgetComponent(
    componentWidget({
      type: "tilecast.events",
      version: 1,
      config: {},
      dataSources: [SOURCE],
      media: [],
    }),
    { dataSources: new Map([[SOURCE, source]]), regionalFormat, at },
  );
  if (!payload) return null;
  if (payload.hidden) return null;
  const document = payload.documents[SOURCE] as DataDocument | undefined;
  return document?.datasets[0]?.records?.map((record) => record.id) ?? [];
}

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
    ["today", { mode: "today" }, ["2026-07-15", "2026-07-15"]],
    ["tomorrow", { mode: "tomorrow" }, ["2026-07-16"]],
    [
      "next available",
      { mode: "next_available" },
      ["2026-07-15", "2026-07-15"],
    ],
    [
      "current week",
      { mode: "current_week" },
      ["2026-07-15", "2026-07-15", "2026-07-16", "2026-07-18"],
    ],
    [
      "custom range",
      {
        mode: "custom_range",
        customStartDate: "2026-07-15",
        customEndDate: "2026-07-16",
      },
      ["2026-07-15", "2026-07-15", "2026-07-16"],
    ],
  ] as const)(
    "selects %s records like compatibility Widgets",
    (_name, mode, dates) => {
      const at = new Date("2026-07-15T12:00:00-04:00");
      const selection = {
        field: "date",
        timezone: "America/New_York",
        mode: mode.mode,
        customStartDate:
          "customStartDate" in mode ? mode.customStartDate : undefined,
        customEndDate: "customEndDate" in mode ? mode.customEndDate : undefined,
        excludePast: true,
        noMatchBehavior: "empty",
      };
      const source = sourceWithDateSelection(
        [
          "2026-07-14",
          "2026-07-15",
          "2026-07-15",
          "2026-07-16",
          "2026-07-18",
          "2026-08-01",
        ],
        selection,
      );
      const expectedDates = [...dates];
      const actualIds = selectedRecordIds(source, at);
      const compat = normalizeSource(
        source,
        at,
        resolveRegionalFormatting({
          locale: "en-US",
          timezone: "America/New_York",
          dateFormat: "locale",
          timeFormat: "locale",
          firstDayOfWeek: "monday",
        }),
      ).records.map((record) => record.id);
      const selectedDates = source
        .dataDocument!.datasets[0]!.records!.filter((record) =>
          actualIds?.includes(record.id),
        )
        .map((record) => (record.values["date"] as { date: string }).date);
      expect(selectedDates).toEqual(expectedDates);
      expect(actualIds).toEqual(compat);
    },
  );

  it("uses the Player time zone and regional week start", () => {
    const source = sourceWithDateSelection(
      ["2026-07-10", "2026-07-12", "2026-07-14", "2026-07-18"],
      {
        field: "date",
        timezone: "America/New_York",
        mode: "current_week",
        excludePast: false,
      },
    );
    const at = new Date("2026-07-16T00:30:00Z");
    expect(selectedRecordIds(source, at, "monday")).toEqual([
      "event-2",
      "event-3",
    ]);
    expect(selectedRecordIds(source, at, "friday")).toEqual([
      "event-0",
      "event-1",
      "event-2",
    ]);
  });

  it("uses the selected time zone across a UTC date boundary", () => {
    const source = sourceWithDateSelection(["2026-07-15", "2026-07-16"], {
      field: "date",
      timezone: "America/New_York",
      mode: "today",
      excludePast: true,
    });
    expect(selectedRecordIds(source, new Date("2026-07-16T00:30:00Z"))).toEqual(
      ["event-0"],
    );
  });

  it.each([
    ["empty", []],
    ["fallback_text", []],
    ["last_known_good", []],
    ["next_available", ["2026-07-20"]],
  ] as const)(
    "matches compatibility no-match policy %s",
    (behavior, expectedDates) => {
      const source = sourceWithDateSelection(["2026-07-01", "2026-07-20"], {
        field: "date",
        timezone: "America/New_York",
        mode: "today",
        excludePast: true,
        noMatchBehavior: behavior,
        fallbackText: "No events today",
      });
      const actualIds = selectedRecordIds(
        source,
        new Date("2026-07-15T12:00:00-04:00"),
      );
      const selectedDates = source
        .dataDocument!.datasets[0]!.records!.filter((record) =>
          actualIds?.includes(record.id),
        )
        .map((record) => (record.values["date"] as { date: string }).date);
      expect(selectedDates).toEqual(expectedDates);
    },
  );

  it("hides a component when the source date policy says hide", () => {
    const source = sourceWithDateSelection(["2026-07-01"], {
      field: "date",
      timezone: "America/New_York",
      mode: "today",
      excludePast: true,
      noMatchBehavior: "hide",
    });
    const at = new Date("2026-07-15T12:00:00-04:00");
    expect(selectedRecordIds(source, at)).toBeNull();
    const payload = projectWidgetComponent(
      componentWidget({
        type: "tilecast.events",
        version: 1,
        config: {},
        dataSources: [SOURCE],
        media: [],
      }),
      {
        dataSources: new Map([[SOURCE, source]]),
        regionalFormat: context.regionalFormat,
        at,
      },
    );
    expect(payload?.hidden).toBe(true);
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

  it("keeps an unsourced clock component stable at every instant", () => {
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

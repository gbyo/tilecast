import { describe, expect, it } from "vitest";
import { renderWidget } from "./widget-render";
import { renderPresentation } from "./presentation-render";
import { renderLayout } from "./layout-render";
import { normalizeSource } from "./datasource";
import type {
  ManifestDataSource,
  ManifestWidget,
  LayoutDocument,
  PresentationNode,
} from "./content-types";
import type { Manifest } from "./types";

const at = new Date("2026-07-15T12:00:00-04:00");

function typedSource(id: string, currency?: string): ManifestDataSource {
  return {
    id,
    name: id,
    provider: "json",
    configVersion: 12,
    configuration: {
      fields: [
        { key: "title", label: "Title", type: "text" },
        { key: "price", label: "Price", type: "currency", currency },
      ],
      records: [
        { id: "1", values: { title: "Coffee", price: "3.5" } },
        { id: "2", values: { title: "Tea", price: "2.75" } },
      ],
    } as unknown as Record<string, unknown>,
  };
}

function scheduleSource(): ManifestDataSource {
  const event = (id: string, title: string, start: string, end: string) => ({
    id,
    values: {
      title: { kind: "text", text: title },
      start: { kind: "datetime", datetime: start },
      end: { kind: "datetime", datetime: end },
    },
  });
  return {
    id: "calendar",
    name: "Calendar",
    provider: "calendar",
    configVersion: 13,
    configuration: {},
    dataDocument: {
      schemaVersion: 1,
      datasets: [
        {
          id: "records",
          kind: "records",
          fields: [
            { key: "title", label: "Title", type: "text" },
            { key: "start", label: "Start", type: "datetime" },
            { key: "end", label: "End", type: "datetime" },
          ],
          records: [
            event(
              "algebra",
              "Algebra",
              "2026-07-15T15:30:00Z",
              "2026-07-15T16:30:00Z",
            ),
            event(
              "science",
              "Science",
              "2026-07-15T17:00:00Z",
              "2026-07-15T18:00:00Z",
            ),
            event("art", "Art", "2026-07-15T19:00:00Z", "2026-07-15T20:00:00Z"),
          ],
        },
      ],
    },
  };
}

function schedulePresentation(): PresentationNode {
  const temporalBinding = (
    selector: "current" | "next",
    path: "title" | "start" | "end",
  ) => ({
    source: "dataset",
    dataset: "calendar:records",
    path,
    selector,
    startField: "start",
    endField: "end",
  });
  const currentCondition = (op: "empty" | "not_empty") => ({
    binding: temporalBinding("current", "title"),
    op,
  });
  const upcomingCards = (offset: number): PresentationNode => ({
    type: "repeat",
    repeat: {
      dataset: "calendar:records",
      selector: "upcoming",
      startField: "start",
      endField: "end",
      offset,
      limit: 4,
    },
    children: [
      {
        type: "column",
        props: { background: "#18212B", padding: 14, radius: 10 },
        children: [
          {
            type: "text",
            binding: { source: "repeat", path: "title" },
          },
          {
            type: "text",
            binding: { source: "repeat", path: "start", format: "time" },
          },
        ],
      },
    ],
  });
  return {
    type: "column",
    children: [
      {
        type: "conditional",
        condition: currentCondition("not_empty"),
        children: [
          {
            type: "text",
            binding: temporalBinding("current", "title"),
          },
          {
            type: "text",
            binding: {
              ...temporalBinding("current", "end"),
              format: "relative-countdown",
              prefix: "Ends in ",
            },
          },
        ],
      },
      {
        type: "conditional",
        condition: currentCondition("empty"),
        children: [
          { type: "text", binding: temporalBinding("next", "title") },
          {
            type: "text",
            binding: {
              ...temporalBinding("next", "start"),
              format: "relative-countdown",
              prefix: "Starts in ",
            },
          },
        ],
      },
      {
        type: "conditional",
        condition: currentCondition("not_empty"),
        children: [upcomingCards(0)],
      },
      {
        type: "conditional",
        condition: currentCondition("empty"),
        children: [upcomingCards(1)],
      },
    ],
  };
}

describe("normalizeSource", () => {
  it("flattens typed records into display strings", () => {
    const norm = normalizeSource(typedSource("s1"), at);
    expect(norm.records).toHaveLength(2);
    expect(norm.records[0]!.fields["title"]).toBe("Coffee");
    expect(norm.fieldTypes["price"]).toBe("currency");
    expect(norm.records[0]!.rawFields["price"]).toBe("3.5");
    expect(norm.records[0]!.fields["price"]).not.toMatch(/[€£$¥]/);
  });
});

describe("renderWidget", () => {
  const ctx = (
    sources: ManifestDataSource[],
    regionalFormat?: {
      locale: string;
      timezone: string;
      dateFormat: "locale";
      timeFormat: "locale";
      firstDayOfWeek: "monday";
    },
  ) => ({
    dataSources: new Map(sources.map((s) => [s.id, s])),
    at,
    regionalFormat,
  });

  it("renders a clock as a self-updating node", () => {
    const widget: ManifestWidget = {
      assetId: "w1",
      name: "Clock",
      provider: "clock",
      configVersion: 11,
      configuration: {
        timezone: "America/New_York",
        format: "24",
        showSeconds: true,
      },
    };
    const payload = renderWidget(widget, ctx([]))!;
    // Root box wraps the clock node.
    const stack = JSON.stringify(payload.root);
    expect(stack).toContain('"t":"clock"');
    expect(stack).toContain('"hour12":false');
  });

  it("uses organization time defaults for a new clock while preserving explicit choices", () => {
    const regionalFormat = {
      locale: "de-DE",
      timezone: "Europe/Berlin",
      dateFormat: "locale" as const,
      timeFormat: "locale" as const,
      firstDayOfWeek: "monday" as const,
    };
    const widget: ManifestWidget = {
      assetId: "organization-clock",
      name: "Clock",
      provider: "clock",
      configVersion: 13,
      configuration: { timezone: "", format: "locale", showSeconds: false },
    };
    const inherited = JSON.stringify(
      renderWidget(widget, ctx([], regionalFormat)),
    );
    expect(inherited).toContain('"timezone":"Europe/Berlin"');
    expect(inherited).toContain('"locale":"de-DE"');
    expect(inherited).not.toContain('"hour12":true');

    const explicit = JSON.stringify(
      renderWidget(
        { ...widget, configuration: { ...widget.configuration, format: "12" } },
        ctx([], regionalFormat),
      ),
    );
    expect(explicit).toContain('"hour12":true');
  });

  it("renders a recurring countdown in the selected horizontal layout", () => {
    const widget: ManifestWidget = {
      assetId: "countdown-horizontal",
      name: "Countdown",
      provider: "countdown",
      configVersion: 13,
      configuration: {
        target: "2026-07-22T09:00:00",
        timezone: "America/New_York",
        recurrence: "daily",
        layout: "horizontal",
        label: "Doors open",
      },
    };
    const payload = renderWidget(widget, ctx([]))!;
    // The root is the full-bleed surface; the inset box inside it holds the
    // content area (the center 80 percent by default) and the layout direction.
    expect(payload.root).toMatchObject({
      t: "box",
      style: { width: 100, height: 100 },
      children: [
        { t: "box", style: { width: 80, height: 80, direction: "row" } },
      ],
    });
    expect(JSON.stringify(payload.root)).toContain('"recurrence":"daily"');
    expect(JSON.stringify(payload.root)).toContain("Doors open");
  });

  it("omits the title from a countdown-only layout", () => {
    const widget: ManifestWidget = {
      assetId: "countdown-only",
      name: "Countdown",
      provider: "countdown",
      configVersion: 13,
      configuration: {
        target: "2026-07-22T09:00:00Z",
        recurrence: "none",
        layout: "countdown_only",
        label: "Hidden title",
      },
    };
    const payload = renderWidget(widget, ctx([]))!;
    expect(JSON.stringify(payload.root)).not.toContain("Hidden title");
  });

  it("reads the countdown's textScale and contentPadding as percentages", () => {
    const countdown = (configuration: Record<string, unknown>) => {
      const payload = renderWidget(
        {
          assetId: "countdown-sizing",
          name: "Countdown",
          provider: "countdown",
          configVersion: 13,
          configuration: {
            target: "2026-07-22T09:00:00Z",
            layout: "countdown_only",
            ...configuration,
          },
        },
        ctx([]),
      )!;
      const content = (payload.root as { children: unknown[] }).children[0] as {
        style: { width: number };
        children: { style: { fontSize: number } }[];
      };
      return {
        inset: content.style.width,
        fontSize: content.children[0]!.style.fontSize,
      };
    };

    // Default: the center 80 percent of the Widget at the designed 88px type.
    expect(countdown({})).toEqual({ inset: 80, fontSize: 88 });
    // A scale is a percentage, so 50 halves the type rather than multiplying it.
    expect(countdown({ textScale: 50, contentPadding: 0 })).toEqual({
      inset: 100,
      fontSize: 44,
    });
    expect(countdown({ textScale: 500, contentPadding: 40 })).toEqual({
      inset: 20,
      fontSize: 440,
    });
  });

  it("renders a metric with explicit EUR metadata using the organization locale", () => {
    const widget: ManifestWidget = {
      assetId: "w2",
      name: "Price",
      provider: "metric",
      configVersion: 12,
      configuration: {
        dataSourceId: "s1",
        valueField: "price",
        format: "currency",
        precision: 2,
      },
    };
    const payload = renderWidget(
      widget,
      ctx([typedSource("s1", "EUR")], {
        locale: "de-DE",
        timezone: "Europe/Berlin",
        dateFormat: "locale",
        timeFormat: "locale",
        firstDayOfWeek: "monday",
      }),
    )!;
    const rendered = JSON.stringify(payload.root).replace(/\\u00a0/g, " ");
    expect(rendered).toContain("3,50");
    expect(rendered).toContain("€");
    expect(rendered).not.toContain("$");
  });

  it("renders a menu/list from records", () => {
    const widget: ManifestWidget = {
      assetId: "w3",
      name: "Menu",
      provider: "list",
      configVersion: 12,
      configuration: { dataSourceId: "s1", primaryField: "title" },
    };
    const payload = renderWidget(widget, ctx([typedSource("s1")]))!;
    const json = JSON.stringify(payload.root);
    expect(json).toContain("Coffee");
    expect(json).toContain("Tea");
  });

  it("returns null for an unknown provider", () => {
    const widget: ManifestWidget = {
      assetId: "w4",
      name: "?",
      provider: "mystery",
      configVersion: 11,
      configuration: {},
    };
    expect(renderWidget(widget, ctx([]))).toBeNull();
  });
});

describe("renderPresentation (v13 declarative)", () => {
  it("does not render an exact asset variant outside its availability window", () => {
    const asset = {
      assetId: "a1",
      variantId: "v1",
      mimeType: "image/png",
      sha256: "hash",
      fileSize: 10,
      downloadPath: "/api/v1/player/assets/a1/variants/v1",
      availableFrom: "2026-07-16T00:00:00Z",
      expiresAt: "2026-07-20T00:00:00Z",
    };
    const node: PresentationNode = {
      type: "asset_image",
      props: { assetId: "a1", variantId: "v1" },
    };
    expect(
      renderPresentation(node, {
        datasets: new Map(),
        assets: [asset],
        at,
      }),
    ).toBeNull();
    expect(
      renderPresentation(node, {
        datasets: new Map(),
        assets: [{ ...asset, availableFrom: "2026-07-01T00:00:00Z" }],
        at,
      }),
    ).toMatchObject({ t: "image", src: "tcmedia://variant/a1/v1" });
    expect(
      renderPresentation(node, {
        datasets: new Map(),
        assets: [{ ...asset, expiresAt: "2026-07-15T00:00:00Z" }],
        at,
      }),
    ).toBeNull();
  });

  it("projects a v2 countdown binding as a self-updating countdown node", () => {
    const tree = renderPresentation(
      {
        type: "text",
        binding: {
          source: "environment",
          path: "currentTime",
          format:
            "countdown:v2:2026-12-01T09%3A00:America%2FNew_York:countdown:weekly:completed_text:1110:Started",
        },
      },
      { datasets: new Map(), at },
    );
    expect(tree).toMatchObject({
      t: "countdown",
      target: "2026-12-01T09:00",
      timezone: "America/New_York",
      recurrence: "weekly",
      showSeconds: false,
      completionText: "Started",
    });
  });

  it("expands a repeat with dataset bindings and formatting", () => {
    const root: PresentationNode = {
      type: "column",
      children: [
        {
          type: "row",
          repeat: { dataset: "s1", limit: 10 },
          children: [
            { type: "text", binding: { source: "repeat", path: "title" } },
            {
              type: "text",
              binding: {
                source: "repeat",
                path: "price",
                format: "currency",
                precision: 2,
              },
            },
          ],
        },
      ],
    };
    const regionalFormat = {
      locale: "de-DE",
      timezone: "Europe/Berlin",
      dateFormat: "locale" as const,
      timeFormat: "locale" as const,
      firstDayOfWeek: "monday" as const,
    };
    const datasets = new Map([
      ["s1", normalizeSource(typedSource("s1", "EUR"), at, regionalFormat)],
    ]);
    const tree = renderPresentation(root, { datasets, at, regionalFormat });
    const json = JSON.stringify(tree);
    expect(json).toContain("Coffee");
    expect(json).toContain("3,50");
    expect(json).toContain("€");
    expect(json).not.toContain("$");
    expect(json).toContain("Tea");
  });

  // The Server compiles Clock, Date, and World Clock to a text node bound to environment
  // "currentTime" with the whole spec in the format string. Resolving the path alone yields
  // nothing, so missing these renders an empty string — a blank screen, not a broken one.
  it("projects a compiled clock binding as a self-updating clock node", () => {
    const tree = renderPresentation(
      {
        type: "text",
        props: { role: "metric", color: "#FFFFFF" },
        binding: {
          source: "environment",
          path: "currentTime",
          format: "time:24:true:America/New_York",
        },
      },
      { datasets: new Map(), at },
    );
    expect(tree).toMatchObject({
      t: "clock",
      timezone: "America/New_York",
      hour12: false,
      showSeconds: true,
    });
  });

  it("resolves a compiled date binding to the formatted date", () => {
    const tree = renderPresentation(
      {
        type: "text",
        binding: {
          source: "environment",
          path: "currentTime",
          format: "date:full:America/New_York",
        },
      },
      { datasets: new Map(), at },
    );
    expect(tree).toMatchObject({
      t: "text",
      value: "Wednesday, July 15, 2026",
    });
  });

  it("drops nodes failing a condition", () => {
    const root: PresentationNode = {
      type: "column",
      children: [
        {
          type: "text",
          binding: { source: "literal", value: "shown" },
          condition: {
            binding: { source: "literal", value: "5" },
            op: "greater_than",
            value: "3",
          },
        },
        {
          type: "text",
          binding: { source: "literal", value: "hidden" },
          condition: {
            binding: { source: "literal", value: "1" },
            op: "greater_than",
            value: "3",
          },
        },
      ],
    };
    const tree = renderPresentation(root, { datasets: new Map(), at });
    const json = JSON.stringify(tree);
    expect(json).toContain("shown");
    expect(json).not.toContain("hidden");
  });

  it("signals autoskip only after the last current or upcoming event", () => {
    const source: ManifestDataSource = {
      id: "calendar",
      name: "Calendar",
      provider: "calendar",
      configVersion: 1,
      configuration: {},
      dataDocument: {
        schemaVersion: 1,
        datasets: [
          {
            id: "records",
            kind: "records",
            fields: [
              { key: "title", label: "Title", type: "text" },
              { key: "start", label: "Start", type: "datetime" },
              { key: "end", label: "End", type: "datetime" },
            ],
            records: [
              {
                id: "future",
                values: {
                  title: { kind: "text", text: "Assembly" },
                  start: {
                    kind: "datetime",
                    datetime: "2026-07-15T17:00:00Z",
                  },
                  end: {
                    kind: "datetime",
                    datetime: "2026-07-15T18:00:00Z",
                  },
                },
              },
            ],
            cache: { usingCachedData: false, unavailable: false },
          },
        ],
      },
    };
    const widget: ManifestWidget = {
      assetId: "schedule",
      name: "School Schedule",
      provider: "schedule-board",
      configVersion: 1,
      configuration: {},
      presentation: {
        schemaVersion: 1,
        kind: "native",
        native: {
          root: {
            type: "surface",
            props: {
              autoSkipWhenEmpty: true,
              emptyCondition: {
                binding: {
                  source: "dataset",
                  dataset: "calendar:records",
                  path: "title",
                  selector: "current_or_next",
                  startField: "start",
                  endField: "end",
                },
                op: "empty",
              },
            },
          },
        },
      },
    };
    const dataSources = new Map([["calendar", source]]);
    expect(renderWidget(widget, { dataSources, at })!.autoSkip).toBe(false);
    expect(
      renderWidget(widget, {
        dataSources,
        at: new Date("2026-07-15T19:00:00Z"),
      })!.autoSkip,
    ).toBe(true);
  });

  it("renders the current card and all upcoming cards with a live countdown", () => {
    const datasets = new Map([
      ["calendar", normalizeSource(scheduleSource(), at)],
    ]);
    const tree = renderPresentation(schedulePresentation(), { datasets, at });
    const json = JSON.stringify(tree);

    expect(json).toContain('"value":"Algebra"');
    expect(json).toContain('"value":"Science"');
    expect(json).toContain('"value":"Art"');
    expect(json).toContain('"background":"#18212B"');
    expect(json).toContain('"radius":10');
    expect(json).not.toContain('"value":"2026-07-15T17:00:00Z"');
    expect(json).toMatch(/"value":"\d{1,2}:00 [AP]M"/);
    expect(json).toContain('"target":"2026-07-15T16:30:00Z","timezone":"UTC"');
    expect(json).toContain('"compact":true,"prefix":"Ends in "');
    expect(json).toContain('"showSeconds":true');
  });

  it("features the next card between events without repeating it as upcoming", () => {
    const betweenEvents = new Date("2026-07-15T16:45:00Z");
    const datasets = new Map([
      ["calendar", normalizeSource(scheduleSource(), betweenEvents)],
    ]);
    const tree = renderPresentation(schedulePresentation(), {
      datasets,
      at: betweenEvents,
    });
    const json = JSON.stringify(tree);

    expect(json.match(/"value":"Science"/g)).toHaveLength(1);
    expect(json).toContain('"value":"Art"');
    expect(json).not.toContain('"value":"Algebra"');
    expect(json).toContain('"target":"2026-07-15T17:00:00Z","timezone":"UTC"');
    expect(json).toContain('"compact":true,"prefix":"Starts in "');
  });

  it("applies the surface's content margins and author scale", () => {
    const surface = (props: Record<string, unknown>): PresentationNode => ({
      type: "surface",
      props: { backgroundColor: "#000000", ...props },
      children: [
        {
          type: "text",
          props: { role: "metric", color: "#ffffff" },
          binding: { source: "literal", value: "5d 3h" },
        },
      ],
    });
    const inset = (node: PresentationNode) => {
      const tree = renderPresentation(node, { datasets: new Map(), at }) as {
        children: {
          style: { width: number };
          children: { style: { fontSize: number } }[];
        }[];
      };
      return tree.children[0]!;
    };

    // Default padding leaves the content the center 80 percent at 1x type.
    const automatic = inset(surface({ paddingPercent: 10, textScale: 100 }));
    expect(automatic.style.width).toBe(80);
    const baseSize = automatic.children[0]!.style.fontSize;

    // Zero padding fills the Widget; the scale multiplies the type.
    const enlarged = inset(surface({ paddingPercent: 0, textScale: 250 }));
    expect(enlarged.style.width).toBe(100);
    expect(enlarged.children[0]!.style.fontSize).toBeCloseTo(baseSize * 2.5);

    // Out-of-range values clamp to the supported 25–500 / 0–40 percent range.
    const clamped = inset(surface({ paddingPercent: 90, textScale: 5_000 }));
    expect(clamped.style.width).toBe(20);
    expect(clamped.children[0]!.style.fontSize).toBeCloseTo(baseSize * 5);
  });
});

describe("renderLayout", () => {
  const manifest = {
    manifestVersion: 1,
    assets: [
      {
        assetId: "a1",
        variantId: "v1",
        mimeType: "image/jpeg",
        sha256: "x",
        fileSize: 10,
        downloadPath: "/api/v1/player/assets/a1/variants/v1",
      },
      {
        assetId: "a1",
        variantId: "v2",
        mimeType: "image/png",
        sha256: "y",
        fileSize: 12,
        downloadPath: "/api/v1/player/assets/a1/variants/v2",
      },
    ],
    playlists: [],
    websites: [],
    schedules: [],
  } as unknown as Manifest;

  it("projects placements into positioned zones and rejects bad schema", () => {
    const document: LayoutDocument = {
      schemaVersion: 2,
      canvas: {
        width: 1920,
        height: 1080,
        orientation: "landscape",
        backgroundColor: "#101418",
      },
      placements: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          type: "asset",
          name: "bg",
          x: 0,
          y: 0,
          width: 960,
          height: 1080,
          layer: 0,
          opacity: 1,
          visible: true,
          locked: false,
          assetId: "a1",
          variantId: "v1",
        },
        {
          id: "22222222-2222-2222-2222-222222222222",
          type: "primitive",
          name: "title",
          x: 960,
          y: 0,
          width: 960,
          height: 200,
          layer: 1,
          opacity: 1,
          visible: true,
          locked: false,
          primitive: {
            kind: "text",
            text: "Welcome",
            fontFamily: "Inter",
            fontSize: 72,
          },
        },
      ],
    };
    const payload = renderLayout(document, {
      manifest,
      widgets: new Map(),
      dataSources: new Map(),
      at,
    })!;
    expect(payload.zones).toHaveLength(2);
    expect(payload.zones[0]!.image?.src).toContain("tcmedia://variant/a1/v1");
    expect(payload.zones[0]!.image?.src).not.toContain("v2");
    expect(JSON.stringify(payload.zones[1]!.render)).toContain("Welcome");

    // Wrong schema version → null (keeps previous presentation active).
    expect(
      renderLayout(
        { ...document, schemaVersion: 1 },
        {
          manifest,
          widgets: new Map(),
          dataSources: new Map(),
          at,
        },
      ),
    ).toBeNull();
  });

  it("applies player defaults to playlist zones and skips unavailable items", () => {
    const playlistManifest = {
      ...manifest,
      playlists: [
        {
          id: "p1",
          revision: 1,
          name: "Zone playlist",
          items: [
            {
              id: "future",
              assetId: "a1",
              variantId: "v1",
              assetType: "image",
              fitMode: "contain",
              transition: "none",
              audioEnabled: true,
              volume: 1,
              deliveryPolicy: "download",
              usePlayerDefaults: true,
              availableFrom: "2026-07-16T00:00:00Z",
            },
            {
              id: "current",
              assetId: "a1",
              variantId: "v2",
              assetType: "image",
              fitMode: "contain",
              transition: "none",
              audioEnabled: true,
              volume: 1,
              deliveryPolicy: "download",
              usePlayerDefaults: true,
            },
          ],
        },
      ],
    } as unknown as Manifest;
    const payload = renderLayout(
      {
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
            playlistId: "p1",
          },
        ],
      },
      {
        manifest: playlistManifest,
        widgets: new Map(),
        dataSources: new Map(),
        playback: {
          defaultFitMode: "cover",
          defaultImageDurationSeconds: 7,
          defaultVolume: 0.25,
          defaultAudioEnabled: false,
        },
        at,
      },
    )!;
    expect(payload.zones[0]!.playlistItems).toMatchObject([
      {
        id: "current",
        durationMs: 7_000,
        fit: "cover",
        muted: true,
        volume: 0.25,
      },
    ]);
  });

  it("does not produce a blank layout when every visible zone is unavailable", () => {
    const unavailableManifest = {
      ...manifest,
      assets: [
        {
          ...manifest.assets[0],
          availableFrom: "2026-07-16T00:00:00Z",
        },
      ],
      playlists: [
        {
          id: "p1",
          revision: 1,
          name: "Zone playlist",
          items: [
            {
              id: "future",
              assetId: "a1",
              variantId: "v1",
              assetType: "image",
              fitMode: "contain",
              transition: "none",
              audioEnabled: false,
              volume: 0,
              deliveryPolicy: "download",
            },
          ],
        },
      ],
    } as unknown as Manifest;
    const payload = renderLayout(
      {
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
            playlistId: "p1",
          },
        ],
      },
      {
        manifest: unavailableManifest,
        widgets: new Map(),
        dataSources: new Map(),
        at,
      },
    );

    expect(payload).toBeNull();
  });

  it("does not guess a layout variant when an asset has several variants", () => {
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
          id: "ambiguous",
          type: "asset",
          name: "ambiguous",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          layer: 0,
          opacity: 1,
          visible: true,
          locked: false,
          assetId: "a1",
          variantId: null,
        },
      ],
    };

    expect(
      renderLayout(document, {
        manifest,
        widgets: new Map(),
        dataSources: new Map(),
        at,
      }),
    ).toBeNull();
  });

  it("clips layout zones to a Span viewport", () => {
    const document: LayoutDocument = {
      schemaVersion: 2,
      canvas: {
        width: 3840,
        height: 1080,
        orientation: "landscape",
        backgroundColor: "#101418",
      },
      placements: [
        {
          id: "wall-zone",
          type: "primitive",
          name: "wall title",
          x: 1800,
          y: 0,
          width: 1200,
          height: 200,
          layer: 1,
          opacity: 1,
          visible: true,
          locked: false,
          primitive: { kind: "text", text: "wall" },
        },
      ],
    };
    const payload = renderLayout(
      document,
      { manifest, widgets: new Map(), dataSources: new Map(), at },
      {
        x: 1920,
        y: 0,
        width: 1920,
        height: 1080,
        rotation: 0,
        order: 1,
        canvasWidth: 3840,
        canvasHeight: 1080,
      },
    )!;
    expect(payload.canvasWidth).toBe(1920);
    expect(payload.canvasHeight).toBe(1080);
    expect(payload.zones[0]).toMatchObject({
      x: 0,
      y: 0,
      width: 1080,
      height: 200,
    });
    expect(payload.backgroundImageViewport?.x).toBe(1920);
  });
});

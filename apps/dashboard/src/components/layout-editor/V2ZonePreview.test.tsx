// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type {
  Asset,
  ContentDefinitionCatalog,
  ContentDefinitionField,
  WidgetDefinition,
} from "../../api/types";
import clockManifest from "../../../../../widgets/clock/tilecast.widget.json";
import qrManifest from "../../../../../widgets/qr-code/tilecast.widget.json";
import listManifest from "../../../../../widgets/list/tilecast.widget.json";
import agendaManifest from "../../../../../widgets/agenda/tilecast.widget.json";
import weatherManifest from "../../../../../widgets/weather/tilecast.widget.json";
import newsManifest from "../../../../../widgets/news/tilecast.widget.json";
import tickerManifest from "../../../../../widgets/ticker/tilecast.widget.json";
import { studioWidgetDiscovery } from "../../content/studioWidgets";
import { V2ZonePreview } from "./V2ZonePreview";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function clockDefinition(): WidgetDefinition {
  return {
    id: "clock",
    version: 1,
    apiVersion: 1,
    name: "Clock",
    description: "Show live local time in a configured timezone.",
    category: "Essentials",
    icon: "clock",
    runtime: "native",
    configurationSchema: clockManifest.configurationSchema as {
      fields: ContentDefinitionField[];
    },
    defaultConfiguration: clockManifest.defaultConfiguration,
    component: {
      type: "tilecast.clock",
      version: 1,
      tagName: "tc-widget-clock",
      entrypoint: "./runtime/index.ts",
      configTemplate: clockManifest.component.configTemplate,
      dataSourceFields: [],
      empty: "render",
    },
    compatibility: { fallback: "legacy" },
    presentationSchemaVersion: 1,
    requiredCapabilities: {},
    emptyStateBehavior: "text",
  };
}

function qrCodeDefinition(): WidgetDefinition {
  return {
    id: "qr-code",
    version: 1,
    apiVersion: 1,
    name: "QR Code",
    description:
      "Show a scannable code with an optional heading and instruction.",
    category: "Essentials",
    icon: "qr_code",
    runtime: "native",
    configurationSchema: qrManifest.configurationSchema as {
      fields: ContentDefinitionField[];
    },
    defaultConfiguration: qrManifest.defaultConfiguration,
    component: {
      type: "tilecast.qr-code",
      version: 1,
      tagName: "tc-widget-qr-code",
      entrypoint: "./runtime/index.ts",
      configTemplate: qrManifest.component.configTemplate,
      dataSourceFields: [],
      empty: "render",
    },
    compatibility: { fallback: "none" },
    presentationSchemaVersion: 1,
    requiredCapabilities: {},
    emptyStateBehavior: "text",
  };
}

function legacyQrCodeDefinition(): WidgetDefinition {
  // A saved legacy provider keeps its persisted keys; the chained template
  // prefers current keys and falls back to the superseded ones.
  return {
    ...qrCodeDefinition(),
    id: "qrcode",
    deprecation: { deprecated: true, replacement: "qr-code" },
    compatibility: { fallback: "legacy" },
    component: {
      ...qrCodeDefinition().component!,
      configTemplate: {
        payload: {
          $config: "payload",
          default: { $config: "value", default: "" },
        },
        heading: { $config: "heading", default: "" },
        instruction: { $config: "instruction", default: "" },
        shortLabel: {
          $config: "shortLabel",
          default: { $config: "label", default: "" },
        },
        style: { $config: "style", default: "standard" },
        background: { $config: "backgroundColor", default: "#FFFFFF" },
        foreground: { $config: "foregroundColor", default: "#101418" },
      },
    },
  };
}

function listDefinition(): WidgetDefinition {
  return {
    id: "list",
    version: 1,
    apiVersion: 1,
    name: "List",
    description: "Show records as flexible primary and secondary rows.",
    category: "Data display",
    icon: "list",
    runtime: "native",
    configurationSchema: listManifest.configurationSchema as {
      fields: ContentDefinitionField[];
    },
    defaultConfiguration: listManifest.defaultConfiguration,
    component: {
      type: "tilecast.list",
      version: 1,
      tagName: "tc-widget-list",
      entrypoint: "./runtime/index.ts",
      configTemplate: listManifest.component.configTemplate,
      dataSourceFields: listManifest.component.dataSourceFields,
      empty: "skip-eligible",
    },
    compatibility: { fallback: "legacy" },
    presentationSchemaVersion: 1,
    requiredCapabilities: {},
    emptyStateBehavior: "text",
  };
}

function agendaDefinition(): WidgetDefinition {
  return {
    id: "agenda",
    version: 1,
    apiVersion: 1,
    name: "Agenda",
    description: "Group upcoming events by day.",
    category: "Data display",
    icon: "calendar",
    runtime: "native",
    configurationSchema: agendaManifest.configurationSchema as {
      fields: ContentDefinitionField[];
    },
    defaultConfiguration: agendaManifest.defaultConfiguration,
    component: {
      type: "tilecast.agenda",
      version: 1,
      tagName: "tc-widget-agenda",
      entrypoint: "./runtime/index.ts",
      configTemplate: agendaManifest.component.configTemplate,
      dataSourceFields: agendaManifest.component.dataSourceFields,
      empty: "skip-eligible",
    },
    compatibility: { fallback: "legacy" },
    presentationSchemaVersion: 1,
    requiredCapabilities: {},
    emptyStateBehavior: "text",
  };
}

function weatherDefinition(): WidgetDefinition {
  return {
    id: "weather",
    version: 1,
    apiVersion: 1,
    name: "Weather",
    description: "Show current conditions and the forecast.",
    category: "Data display",
    icon: "cloud_sun",
    runtime: "native",
    configurationSchema: weatherManifest.configurationSchema as {
      fields: ContentDefinitionField[];
    },
    defaultConfiguration: weatherManifest.defaultConfiguration,
    component: {
      type: "tilecast.weather",
      version: 1,
      tagName: "tc-widget-weather",
      entrypoint: "./runtime/index.ts",
      configTemplate: weatherManifest.component.configTemplate,
      dataSourceFields: weatherManifest.component.dataSourceFields,
      empty: "skip-eligible",
    },
    compatibility: { fallback: "legacy" },
    presentationSchemaVersion: 1,
    requiredCapabilities: {},
    emptyStateBehavior: "text",
  };
}

function newsDefinition(): WidgetDefinition {
  return {
    id: "news",
    version: 1,
    apiVersion: 1,
    name: "News",
    description: "Present normalized feed and news records.",
    category: "Data display",
    icon: "newspaper",
    runtime: "native",
    configurationSchema: newsManifest.configurationSchema as {
      fields: ContentDefinitionField[];
    },
    defaultConfiguration: newsManifest.defaultConfiguration,
    component: {
      type: "tilecast.news",
      version: 1,
      tagName: "tc-widget-news",
      entrypoint: "./runtime/index.ts",
      configTemplate: newsManifest.component.configTemplate,
      dataSourceFields: newsManifest.component.dataSourceFields,
      empty: "skip-eligible",
    },
    compatibility: { fallback: "none" },
    presentationSchemaVersion: 1,
    requiredCapabilities: {},
    emptyStateBehavior: "text",
  };
}

function tickerDefinition(): WidgetDefinition {
  return {
    id: "ticker",
    version: 1,
    apiVersion: 1,
    name: "Ticker",
    description: "Scroll short items from any records source.",
    category: "Data display",
    icon: "text",
    runtime: "native",
    configurationSchema: tickerManifest.configurationSchema as {
      fields: ContentDefinitionField[];
    },
    defaultConfiguration: tickerManifest.defaultConfiguration,
    component: {
      type: "tilecast.ticker",
      version: 1,
      tagName: "tc-widget-ticker",
      entrypoint: "./runtime/index.ts",
      configTemplate: tickerManifest.component.configTemplate,
      dataSourceFields: tickerManifest.component.dataSourceFields,
      empty: "skip-eligible",
    },
    compatibility: { fallback: "legacy" },
    presentationSchemaVersion: 1,
    requiredCapabilities: {},
    emptyStateBehavior: "text",
  };
}

function rssTickerDefinition(): WidgetDefinition {
  // A saved RSS Ticker keeps its content mode and managed source; the alias
  // template projects both into the shared ticker contract.
  return {
    ...tickerDefinition(),
    id: "rss-ticker",
    name: "RSS Ticker",
    deprecation: { deprecated: true, replacement: "ticker" },
    compatibility: { fallback: "template" },
    component: {
      ...tickerDefinition().component!,
      configTemplate: {
        dataSourceId: { $config: "managedDataSourceId", default: "" },
        primaryField: "title",
        secondaryField: "",
        legacyFields: [],
        legacyContentMode: {
          $config: "contentMode",
          default: "title_source",
        },
        leadingLabel: { $config: "leadingLabel", default: "NEWS" },
        separator: { $config: "separator", default: " • " },
        fieldSeparator: " — ",
        maxItems: { $config: "maxStories", default: 15 },
        direction: { $config: "direction", default: "left" },
        speed: { $config: "speed", default: "normal" },
        emptyText: { $config: "emptyState", default: "" },
        background: "",
        foreground: "",
      },
    },
  };
}

function catalog(): ContentDefinitionCatalog {
  return {
    revision: "test",
    compilerVersion: "99",
    fingerprint: "test",
    widgets: [
      clockDefinition(),
      qrCodeDefinition(),
      legacyQrCodeDefinition(),
      listDefinition(),
      agendaDefinition(),
      weatherDefinition(),
      newsDefinition(),
      tickerDefinition(),
      rssTickerDefinition(),
    ],
    dataSources: [],
  };
}

describe("V2ZonePreview", () => {
  it("mounts the migrated Widget's real element at zone size", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog());
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    const asset = {
      widget: {
        authorConfiguration: {
          timezone: "",
          format: "locale",
          showSeconds: false,
          style: "standard",
          showDate: false,
          backgroundColor: "#0E141B",
          foregroundColor: "#F5F7FA",
        },
      },
    } as unknown as Asset;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <V2ZonePreview
          provider="clock"
          asset={asset}
          width={480}
          height={270}
        />
      </QueryClientProvider>,
    );
    const frame = await screen.findByRole("img", {
      name: "Live Widget preview",
    });
    const widget = await waitFor(() => frame.querySelector("tc-widget-clock"));
    expect(widget).toBeInTheDocument();
    const sharedDefinition = studioWidgetDiscovery.registry.lookup(
      "tilecast.clock",
      1,
    );
    expect(customElements.get("tc-widget-clock")).toBe(
      sharedDefinition?.element as CustomElementConstructor,
    );
    const stage = frame.firstElementChild as HTMLElement;
    const intrinsicFrame = stage.firstElementChild as HTMLElement;
    expect(stage.style.width).toBe("480px");
    expect(stage.style.height).toBe("270px");
    expect(intrinsicFrame.style.width).toBe("480px");
    expect(intrinsicFrame.style.height).toBe("270px");
    expect(container.querySelector("tc-widget-clock")).toBe(widget);
  });

  it("mounts the real QR element for saved legacy provider content", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog());
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    const asset = {
      widget: {
        authorConfiguration: {
          value: "https://example.org/visit",
          label: "example.org",
          errorCorrection: "medium",
          foregroundColor: "#000000",
          backgroundColor: "#FFFFFF",
        },
      },
    } as unknown as Asset;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <V2ZonePreview
          provider="qrcode"
          asset={asset}
          width={480}
          height={270}
        />
      </QueryClientProvider>,
    );
    const frame = await screen.findByRole("img", {
      name: "Live Widget preview",
    });
    await waitFor(() => frame.querySelector("tc-widget-qr-code"));
    const code = container.querySelector("tc-widget-qr-code");
    expect(code).toBeInTheDocument();
    expect(code?.shadowRoot?.querySelector("svg.code")).not.toBeNull();
  });

  it("mounts the real List element for saved legacy display content", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog());
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    vi.spyOn(api, "previewSavedDataSource").mockResolvedValue({
      fields: [
        { key: "title", label: "Title", type: "text" },
        { key: "budget", label: "Budget", type: "currency", currency: "USD" },
      ],
      records: [
        {
          id: "r1",
          values: { title: "Lobby screen refresh", budget: "1200" },
        },
      ],
      cachedAt: "2026-09-28T15:00:00Z",
      usingCachedData: false,
      attribution: "Projects sheet",
      unavailable: false,
    });
    // Saved content keeps its persisted legacy keys, including superseded
    // layout tuning the V2 component intentionally ignores.
    const asset = {
      widget: {
        authorConfiguration: {
          dataSourceId: "source-1",
          primaryField: "title",
          trailingField: "budget",
          maximumItems: 8,
          rowSpacing: "comfortable",
          showDividers: true,
          textScale: 2,
        },
      },
    } as unknown as Asset;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <V2ZonePreview provider="list" asset={asset} width={480} height={270} />
      </QueryClientProvider>,
    );
    const frame = await screen.findByRole("img", {
      name: "Live Widget preview",
    });
    await waitFor(() => frame.querySelector("tc-widget-list"));
    const list = container.querySelector("tc-widget-list");
    expect(list).toBeInTheDocument();
    expect(list?.shadowRoot?.querySelector(".row .primary")?.textContent).toBe(
      "Lobby screen refresh",
    );
    expect(list?.shadowRoot?.querySelector(".row .trailing")?.textContent).toBe(
      "$1,200.00",
    );
  });

  it("mounts the real Agenda element for saved legacy calendar content", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog());
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    vi.spyOn(api, "previewSavedDataSource").mockResolvedValue({
      configuration: {
        calendars: [],
        displayMode: "upcoming",
        maxEvents: 20,
        fields: {
          title: true,
          startTime: true,
          endTime: true,
          date: true,
          location: true,
          descriptionExcerpt: false,
        },
        timezone: "America/Chicago",
        refreshIntervalSeconds: 900,
        stalenessLimitHours: 24,
        emptyState: "",
        data: {
          events: [
            {
              id: "e1",
              calendar: "School",
              title: "Board meeting",
              // Far enough ahead that the live preview clock still finds
              // it upcoming, so ended-removal does not hide it.
              start: "2030-05-04T16:00:00Z",
              end: "2030-05-04T17:00:00Z",
              allDay: false,
              location: "Main hall",
            },
          ],
          cachedAt: "2026-09-28T15:00:00Z",
          staleAt: "2026-09-28T16:00:00Z",
          usingCachedData: false,
        },
      },
      diagnostics: {
        assetId: "source-1",
        parseStatus: "ok",
        availableEventCount: 1,
        availableItemCount: 0,
        usingCachedData: false,
      },
    });
    // Saved content keeps its persisted legacy date/time keys; the chained
    // template prefers the start mapping and falls back to them.
    const asset = {
      widget: {
        authorConfiguration: {
          dataSourceId: "source-1",
          titleField: "title",
          dateField: "start",
          timeField: "",
          locationField: "location",
          maximumItems: 20,
        },
      },
    } as unknown as Asset;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <V2ZonePreview
          provider="agenda"
          asset={asset}
          width={480}
          height={270}
        />
      </QueryClientProvider>,
    );
    const frame = await screen.findByRole("img", {
      name: "Live Widget preview",
    });
    await waitFor(() => frame.querySelector("tc-widget-agenda"));
    const agenda = container.querySelector("tc-widget-agenda");
    expect(agenda).toBeInTheDocument();
    expect(
      agenda?.shadowRoot?.querySelector(".event .title")?.textContent,
    ).toBe("Board meeting");
  });

  it("mounts the real Weather element for a normalized source", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog());
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    vi.spyOn(api, "previewSavedDataSource").mockResolvedValue({
      fields: [
        { key: "kind", label: "Kind", type: "text" },
        { key: "location", label: "Location", type: "text" },
        { key: "condition", label: "Condition", type: "text" },
        { key: "temperature", label: "Temperature", type: "number" },
        { key: "temperatureUnit", label: "Unit", type: "text" },
      ],
      records: [
        {
          id: "current",
          values: {
            kind: "current",
            location: "Riverside",
            condition: "Clear Sky",
            temperature: "21.5",
            temperatureUnit: "°C",
          },
        },
      ],
      cachedAt: "2026-09-28T15:00:00Z",
      usingCachedData: false,
      attribution: "MET Norway",
      unavailable: false,
    });
    const asset = {
      widget: {
        authorConfiguration: {
          dataSourceId: "source-1",
          showLocation: true,
          showCurrent: true,
          forecastDays: 3,
        },
      },
    } as unknown as Asset;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <V2ZonePreview
          provider="weather"
          asset={asset}
          width={480}
          height={270}
        />
      </QueryClientProvider>,
    );
    const frame = await screen.findByRole("img", {
      name: "Live Widget preview",
    });
    await waitFor(() => frame.querySelector("tc-widget-weather"));
    const weather = container.querySelector("tc-widget-weather");
    expect(weather).toBeInTheDocument();
    const weatherText = (selector: string) =>
      weather?.shadowRoot
        ?.querySelector(selector)
        ?.textContent?.replace(/\s+/g, " ")
        .trim() ?? null;
    expect(weatherText(".temp")).toBe("21.5 °C");
    expect(weatherText(".condition")).toBe("Clear Sky");
  });

  it("mounts the real News element for a normalized feed source", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog());
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    vi.spyOn(api, "previewSavedDataSource").mockResolvedValue({
      fields: [
        { key: "title", label: "Title", type: "text", role: "headline" },
        {
          key: "description",
          label: "Description",
          type: "text",
          role: "summary",
        },
        {
          key: "date",
          label: "Publication time",
          type: "datetime",
          role: "published_at",
        },
        { key: "source", label: "Source", type: "text", role: "source_name" },
      ],
      records: [
        {
          id: "s1",
          values: {
            title: "Library extends weekend hours",
            description: "The main branch opens Sundays.",
            date: "2026-09-27T14:00:00Z",
            source: "City Wire",
          },
        },
      ],
      cachedAt: "2026-09-28T15:00:00Z",
      usingCachedData: false,
      attribution: "City Wire",
      unavailable: false,
    });
    const asset = {
      widget: {
        authorConfiguration: {
          dataSourceId: "source-1",
          heading: "Latest news",
          maxStories: 8,
          showSummary: true,
          showPublicationTime: true,
          showSource: true,
          displayStyle: "headlines",
        },
      },
    } as unknown as Asset;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <V2ZonePreview provider="news" asset={asset} width={480} height={270} />
      </QueryClientProvider>,
    );
    const frame = await screen.findByRole("img", {
      name: "Live Widget preview",
    });
    await waitFor(() => frame.querySelector("tc-widget-news"));
    const news = container.querySelector("tc-widget-news");
    expect(news).toBeInTheDocument();
    expect(
      news?.shadowRoot?.querySelector(".story .headline")?.textContent,
    ).toBe("Library extends weekend hours");
    expect(
      news?.shadowRoot?.querySelector(".story .summary")?.textContent,
    ).toBe("The main branch opens Sundays.");
  });

  it("mounts the real Ticker element for a records source", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog());
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    vi.spyOn(api, "previewSavedDataSource").mockResolvedValue({
      fields: [
        { key: "title", label: "Title", type: "text", role: "headline" },
        { key: "source", label: "Source", type: "text", role: "source_name" },
      ],
      records: [
        {
          id: "s1",
          values: { title: "Pool reopens Monday", source: "City Wire" },
        },
      ],
      cachedAt: "2026-09-28T15:00:00Z",
      usingCachedData: false,
      attribution: "City Wire",
      unavailable: false,
    });
    const asset = {
      widget: {
        authorConfiguration: {
          dataSourceId: "source-1",
          primaryField: "title",
          secondaryField: "source",
          leadingLabel: "News",
          separator: " • ",
          maxItems: 15,
          direction: "left",
          speed: "normal",
        },
      },
    } as unknown as Asset;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <V2ZonePreview
          provider="ticker"
          asset={asset}
          width={960}
          height={120}
        />
      </QueryClientProvider>,
    );
    const frame = await screen.findByRole("img", {
      name: "Live Widget preview",
    });
    await waitFor(() => frame.querySelector("tc-widget-ticker"));
    const ticker = container.querySelector("tc-widget-ticker");
    expect(ticker).toBeInTheDocument();
    expect(ticker?.shadowRoot?.querySelector(".label")?.textContent).toBe(
      "News",
    );
    expect(ticker?.shadowRoot?.querySelector(".track")?.textContent).toContain(
      "Pool reopens Monday",
    );
  });

  it("mounts the Ticker element for saved RSS Ticker content", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog());
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    vi.spyOn(api, "previewSavedDataSource").mockResolvedValue({
      fields: [
        { key: "title", label: "Title", type: "text" },
        { key: "date", label: "Date", type: "datetime" },
        { key: "source", label: "Source", type: "text" },
      ],
      records: [
        {
          id: "s1",
          values: {
            title: "Council meets Tuesday",
            date: "2026-09-26T18:00:00Z",
            source: "City Wire",
          },
        },
      ],
      cachedAt: "2026-09-28T15:00:00Z",
      usingCachedData: false,
      attribution: "City Wire",
      unavailable: false,
    });
    // Saved content keeps its content mode; the alias template projects it
    // into the shared ticker contract with the managed source grant.
    const asset = {
      widget: {
        managedDataSourceId: "source-1",
        authorConfiguration: {
          managedDataSourceId: "source-1",
          feedUrl: "https://example.com/feed.xml",
          leadingLabel: "NEWS",
          contentMode: "title_source",
          separator: " • ",
          speed: "normal",
          direction: "left",
          maxStories: 15,
        },
      },
    } as unknown as Asset;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <V2ZonePreview
          provider="rss-ticker"
          asset={asset}
          width={960}
          height={120}
        />
      </QueryClientProvider>,
    );
    const frame = await screen.findByRole("img", {
      name: "Live Widget preview",
    });
    await waitFor(() => frame.querySelector("tc-widget-ticker"));
    const ticker = container.querySelector("tc-widget-ticker");
    expect(ticker).toBeInTheDocument();
    expect(ticker?.shadowRoot?.querySelector(".track")?.textContent).toContain(
      "Council meets Tuesday",
    );
    expect(ticker?.shadowRoot?.querySelector(".track")?.textContent).toContain(
      "City Wire",
    );
  });

  it("renders nothing while definitions load or the provider is unknown", () => {
    vi.spyOn(api, "contentDefinitions").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <V2ZonePreview provider="clock" width={480} height={270} />
      </QueryClientProvider>,
    );
    expect(container.querySelector("tc-widget-clock")).toBeNull();
  });
});

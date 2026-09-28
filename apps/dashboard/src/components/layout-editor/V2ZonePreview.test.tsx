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
    await waitFor(() => frame.querySelector("tc-widget-clock"));
    expect(container.querySelector("tc-widget-clock")).toBeInTheDocument();
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

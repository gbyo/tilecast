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

function catalog(): ContentDefinitionCatalog {
  return {
    revision: "test",
    compilerVersion: "99",
    fingerprint: "test",
    widgets: [clockDefinition()],
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

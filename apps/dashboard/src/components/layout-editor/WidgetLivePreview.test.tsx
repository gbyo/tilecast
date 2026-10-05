// @vitest-environment jsdom
// A Layout thumbnail waits for V2 zones through the capture coordinator.
// The Widget below becomes ready asynchronously after the zone renders: the
// wait must hold the capture, then release it once the mount settles.
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type {
  Asset,
  ContentDefinitionField,
  LayoutPlacement,
  WidgetDefinition,
} from "../../api/types";
import listManifest from "../../../../../widgets/list/tilecast.widget.json";
import { AppPlacementPreview, WidgetLivePreview } from "./WidgetLivePreview";
import { LayoutCaptureCoordinator } from "./layoutCaptureReadiness";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function listDefinition(): WidgetDefinition {
  return {
    id: "list",
    version: 1,
    apiVersion: 1,
    name: "List",
    description: "Show records as rows.",
    category: "Data",
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
      empty: "render",
    },
    compatibility: { fallback: "legacy" },
    presentationSchemaVersion: 1,
    requiredCapabilities: {},
    emptyStateBehavior: "text",
  };
}

describe("WidgetLivePreview capture tracking", () => {
  it("ignores legacy placement overrides and uses the shared Widget appearance", () => {
    const asset = {
      id: "clock-asset",
      name: "Lobby Clock",
      type: "widget",
      widget: {
        provider: "clock",
        configuration: {
          backgroundColor: "#123456",
          foregroundColor: "#ddeeff",
        },
      },
    } as unknown as Asset;
    const item = {
      id: "clock-placement",
      type: "widget",
      name: "Lobby Clock",
      x: 0,
      y: 0,
      width: 480,
      height: 270,
      layer: 0,
      opacity: 1,
      visible: true,
      locked: false,
      overrides: {
        fit: "cover",
        alignment: "right",
        foregroundColor: "#ff0000",
        backgroundColor: "#00ff00",
        fallbackVisibility: "hide",
        muted: false,
      },
    } as LayoutPlacement;
    const { container } = render(
      <AppPlacementPreview asset={asset} item={item} />,
    );
    const preview = container.querySelector(
      ".layout-app-placement",
    ) as HTMLElement;
    expect(preview.style.backgroundColor).toBe("rgb(18, 52, 86)");
    expect(preview.style.color).toBe("rgb(221, 238, 255)");
    expect(preview.style.alignItems).toBe("");
  });

  it("holds the thumbnail wait until an async Widget settles", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue({
      revision: "test",
      compilerVersion: "99",
      fingerprint: "test",
      widgets: [listDefinition()],
      dataSources: [],
    });
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    // The Data Source resolves only after the zone has rendered.
    let resolveSource!: (value: unknown) => void;
    vi.spyOn(api, "previewSavedDataSource").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSource = resolve as (value: unknown) => void;
        }),
    );
    const coordinator = new LayoutCaptureCoordinator();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const asset = {
      id: "asset-list",
      widget: {
        provider: "list",
        authorConfiguration: { dataSourceId: "source-1" },
      },
    } as unknown as Asset;
    const item = { width: 480, height: 270 } as LayoutPlacement;
    render(
      <QueryClientProvider client={client}>
        <WidgetLivePreview
          asset={asset}
          item={item}
          captureTracking={{ coordinator, zoneId: "zone-1" }}
        />
      </QueryClientProvider>,
    );
    // The zone registers as pending while its source is still in flight.
    await waitFor(() => expect(coordinator.status("zone-1")).toBe("pending"));
    const waited = coordinator.waitForSettled(["zone-1"], 5000);
    let settled = false;
    void waited.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    // The source lands after render; the mount settles and releases the wait.
    resolveSource({
      fields: [{ key: "title", label: "Title", type: "text" }],
      records: [],
      cachedAt: "2026-09-28T15:00:00Z",
      usingCachedData: false,
      attribution: "Projects sheet",
      unavailable: false,
    });
    await expect(waited).resolves.toEqual({ ok: true, failedIds: [] });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not track zones without a capture coordinator", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue({
      revision: "test",
      compilerVersion: "99",
      fingerprint: "test",
      widgets: [listDefinition()],
      dataSources: [],
    });
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    vi.spyOn(api, "previewSavedDataSource").mockResolvedValue({
      fields: [{ key: "title", label: "Title", type: "text" }],
      records: [],
      cachedAt: "2026-09-28T15:00:00Z",
      usingCachedData: false,
      attribution: "Projects sheet",
      unavailable: false,
    });
    const coordinator = new LayoutCaptureCoordinator();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const asset = {
      id: "asset-list",
      widget: {
        provider: "list",
        authorConfiguration: { dataSourceId: "source-1" },
      },
    } as unknown as Asset;
    const item = { width: 480, height: 270 } as LayoutPlacement;
    const { container } = render(
      <QueryClientProvider client={client}>
        <WidgetLivePreview asset={asset} item={item} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector("tc-widget-list")).toBeInTheDocument(),
    );
    expect(coordinator.status("zone-1")).toBeUndefined();
  });
});

// @vitest-environment jsdom
// Playlist widget items render through the shared V2 preview surface when
// the provider is migrated, and keep the legacy compiled preview otherwise.
// A failed required Data Source is an item error, never readiness (#619).
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type {
  Asset,
  ContentDefinitionField,
  PlaylistItem,
  WidgetDefinition,
} from "../api/types";
import clockManifest from "../../../../widgets/clock/tilecast.widget.json";
import listManifest from "../../../../widgets/list/tilecast.widget.json";
import { PlaylistWidgetPreview } from "./PlaylistWidgetPreview";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function definition(
  id: string,
  manifest: {
    configurationSchema: unknown;
    defaultConfiguration: unknown;
    component: { configTemplate: unknown; dataSourceFields?: unknown };
  },
  type: string,
  tagName: string,
): WidgetDefinition {
  return {
    id,
    version: 1,
    apiVersion: 1,
    name: id,
    description: `${id} widget`,
    category: "Test",
    icon: "test",
    runtime: "native",
    configurationSchema: manifest.configurationSchema as {
      fields: ContentDefinitionField[];
    },
    defaultConfiguration: manifest.defaultConfiguration as Record<
      string,
      unknown
    >,
    component: {
      type,
      version: 1,
      tagName,
      entrypoint: "./runtime/index.ts",
      configTemplate: manifest.component.configTemplate as Record<
        string,
        unknown
      >,
      dataSourceFields:
        (manifest.component.dataSourceFields as string[] | undefined) ?? [],
      empty: "render",
    },
    compatibility: { fallback: "legacy" },
    presentationSchemaVersion: 1,
    requiredCapabilities: {},
    emptyStateBehavior: "text",
  };
}

function catalog() {
  return {
    revision: "test",
    compilerVersion: "99",
    fingerprint: "test",
    widgets: [
      definition("clock", clockManifest, "tilecast.clock", "tc-widget-clock"),
      definition("list", listManifest, "tilecast.list", "tc-widget-list"),
    ],
    dataSources: [],
  };
}

function item(assetId: string): PlaylistItem {
  return {
    id: "item-1",
    assetId,
    assetType: "widget",
  } as unknown as PlaylistItem;
}

function widgetAsset(
  provider: string,
  configuration: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Asset {
  return {
    id: "asset-1",
    name: "Test widget",
    type: "widget",
    widget: { provider, configuration, ...extra },
  } as unknown as Asset;
}

function frame(props: {
  asset: Asset;
  onReady?: () => void;
  onError?: () => void;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onReady = props.onReady ?? vi.fn();
  const onError = props.onError ?? vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <PlaylistWidgetPreview
        item={item(props.asset.id)}
        active
        csrfToken="test-csrf"
        regional={{ locale: "en-US", timezone: "UTC" }}
        className="stage"
        onReady={onReady}
        onError={onError}
      />
    </QueryClientProvider>,
  );
  return { ...view, onReady, onError };
}

function emptyRecords() {
  return {
    fields: [{ key: "title", label: "Title", type: "text" }],
    records: [],
    cachedAt: "2026-09-28T15:00:00Z",
    usingCachedData: false,
    attribution: "Projects sheet",
    unavailable: false,
  };
}

describe("PlaylistWidgetPreview", () => {
  it("renders a migrated Widget through its real Web Component", async () => {
    vi.spyOn(api, "asset").mockResolvedValue(widgetAsset("clock"));
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog());
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    const compile = vi.spyOn(api, "compileWidgetPreview");
    const onReady = vi.fn();
    const onError = vi.fn();
    const { container } = frame({
      asset: widgetAsset("clock"),
      onReady,
      onError,
    });
    await waitFor(() =>
      expect(container.querySelector("tc-widget-clock")).toBeInTheDocument(),
    );
    // The V2 path never calls the server compiler for the preview.
    expect(compile).not.toHaveBeenCalled();
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    expect(onError).not.toHaveBeenCalled();
  });

  it("wires every connected source of a multi-source Widget", async () => {
    const asset = widgetAsset(
      "list",
      { dataSourceId: "source-b" },
      { managedDataSourceId: "source-a" },
    );
    vi.spyOn(api, "asset").mockResolvedValue(asset);
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog());
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    const sourcePreview = vi
      .spyOn(api, "previewSavedDataSource")
      .mockResolvedValue(emptyRecords());
    const { container } = frame({ asset });
    await waitFor(() =>
      expect(container.querySelector("tc-widget-list")).toBeInTheDocument(),
    );
    expect(sourcePreview).toHaveBeenCalledWith("source-a", undefined);
    expect(sourcePreview).toHaveBeenCalledWith("source-b", undefined);
  });

  it("reports a failed required source as an item error, not readiness", async () => {
    const asset = widgetAsset("list", { dataSourceId: "source-1" });
    vi.spyOn(api, "asset").mockResolvedValue(asset);
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog());
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    vi.spyOn(api, "previewSavedDataSource").mockRejectedValue(
      new Error("source unavailable"),
    );
    const onReady = vi.fn();
    const onError = vi.fn();
    const { container } = frame({ asset, onReady, onError });
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onReady).not.toHaveBeenCalled();
    // The failed Widget never mounts as a fake-empty element.
    expect(container.querySelector("tc-widget-list")).toBeNull();
  });

  it("keeps the legacy compiled preview for non-migrated Widgets", async () => {
    const asset = widgetAsset("website", { url: "https://example.org" });
    vi.spyOn(api, "asset").mockResolvedValue(asset);
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog());
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    const compile = vi
      .spyOn(api, "compileWidgetPreview")
      .mockResolvedValue({ kind: "native", native: {} } as never);
    frame({ asset });
    await waitFor(() => expect(compile).toHaveBeenCalled());
    expect(compile).toHaveBeenCalledWith(
      "website",
      expect.objectContaining({ url: "https://example.org" }),
      "test-csrf",
    );
  });

  it("reports a failed legacy source as an item error", async () => {
    const asset = widgetAsset("website", { dataSourceId: "source-1" });
    vi.spyOn(api, "asset").mockResolvedValue(asset);
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog());
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    vi.spyOn(api, "compileWidgetPreview").mockResolvedValue({
      kind: "native",
      native: {},
    } as never);
    vi.spyOn(api, "previewSavedDataSource").mockRejectedValue(
      new Error("source unavailable"),
    );
    const onReady = vi.fn();
    const onError = vi.fn();
    frame({ asset, onReady, onError });
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onReady).not.toHaveBeenCalled();
  });

  it("disposes the Widget mount on unmount", async () => {
    vi.spyOn(api, "asset").mockResolvedValue(widgetAsset("clock"));
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog());
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    const { container, unmount } = frame({ asset: widgetAsset("clock") });
    await waitFor(() =>
      expect(container.querySelector("tc-widget-clock")).toBeInTheDocument(),
    );
    unmount();
    expect(container.querySelector("tc-widget-clock")).toBeNull();
  });
});

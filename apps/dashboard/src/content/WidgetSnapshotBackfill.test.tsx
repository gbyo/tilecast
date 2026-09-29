// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type {
  Asset,
  ContentDefinitionCatalog,
  ContentDefinitionField,
  WidgetDefinition,
} from "../api/types";
import clockManifest from "../../../../widgets/clock/tilecast.widget.json";
import listManifest from "../../../../widgets/list/tilecast.widget.json";
import { WidgetSnapshotBackfill } from "./WidgetSnapshotBackfill";

const captureWidgetPreview = vi.hoisted(() => vi.fn());

vi.mock("./widgetPreviewCapture", () => ({
  captureWidgetPreview,
}));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { authenticated: true, csrfToken: "csrf-token" },
  }),
}));

function widgetDefinition(
  manifest: typeof clockManifest | typeof listManifest,
): WidgetDefinition {
  return {
    id: manifest.id,
    version: manifest.version,
    apiVersion: 1,
    name: manifest.name,
    description: manifest.description,
    category: manifest.category,
    icon: manifest.icon,
    runtime: "native",
    configurationSchema: manifest.configurationSchema as {
      fields: ContentDefinitionField[];
    },
    defaultConfiguration: manifest.defaultConfiguration,
    component: {
      type: manifest.component.type,
      version: manifest.component.version,
      tagName: manifest.component.tagName,
      entrypoint: "./runtime/index.ts",
      configTemplate: manifest.component.configTemplate,
      dataSourceFields:
        "dataSourceFields" in manifest.component
          ? manifest.component.dataSourceFields
          : [],
      empty: manifest.component.empty as "render" | "skip-eligible",
    },
    compatibility: { fallback: "legacy" },
    presentationSchemaVersion: 1,
    requiredCapabilities: {},
    emptyStateBehavior: "text",
  };
}

const definitions: ContentDefinitionCatalog = {
  revision: "snapshot-test",
  compilerVersion: "1",
  fingerprint: "snapshot-test",
  widgets: [widgetDefinition(clockManifest), widgetDefinition(listManifest)],
  dataSources: [],
};

function assetFor(
  manifest: typeof clockManifest | typeof listManifest,
  id: string,
): Asset {
  return {
    id,
    name: manifest.name,
    type: "widget",
    thumbnailUrl: undefined,
    widget: {
      provider: manifest.id,
      configuration: manifest.defaultConfiguration,
      authorConfiguration: manifest.defaultConfiguration,
    },
  } as unknown as Asset;
}

let animationFrames: Array<{
  id: number;
  callback: FrameRequestCallback;
}>;
let nextAnimationFrameId: number;

function runNextAnimationFrame(now: number) {
  const frame = animationFrames.shift();
  expect(frame).toBeDefined();
  act(() => frame?.callback(now));
}

function renderBackfill(asset: Asset) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WidgetSnapshotBackfill assets={[asset]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  animationFrames = [];
  nextAnimationFrameId = 1;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextAnimationFrameId++;
      animationFrames.push({ id, callback });
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      animationFrames = animationFrames.filter((frame) => frame.id !== id);
    }),
  );
  vi.spyOn(api, "contentDefinitions").mockResolvedValue(definitions);
  vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
  vi.spyOn(api, "uploadWidgetPreview").mockResolvedValue(undefined);
  captureWidgetPreview.mockResolvedValue(
    new Blob(["preview"], { type: "image/jpeg" }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  captureWidgetPreview.mockReset();
});

describe("WidgetSnapshotBackfill", () => {
  it("captures a V2 Widget only after the real WidgetMount reports ready", async () => {
    renderBackfill(assetFor(clockManifest, "clock-asset"));

    await waitFor(() =>
      expect(document.querySelector("tc-widget-clock")).toBeInTheDocument(),
    );
    const widget = document.querySelector("tc-widget-clock");
    expect(widget).toBeInTheDocument();
    await waitFor(() => expect(animationFrames).toHaveLength(1));
    expect(captureWidgetPreview).not.toHaveBeenCalled();

    runNextAnimationFrame(1);
    expect(captureWidgetPreview).not.toHaveBeenCalled();
    expect(animationFrames).toHaveLength(1);

    runNextAnimationFrame(2);
    await waitFor(() => expect(captureWidgetPreview).toHaveBeenCalledTimes(1));
    const captureRoot = captureWidgetPreview.mock.calls[0]?.[0] as HTMLElement;
    expect(captureRoot.querySelector("tc-widget-clock")).toBe(widget);
    await waitFor(() =>
      expect(api.uploadWidgetPreview).toHaveBeenCalledWith(
        "clock-asset",
        expect.any(Blob),
        "csrf-token",
      ),
    );
  });

  it("treats the real mount's empty state as settled before capture", async () => {
    let emptyEvents = 0;
    const onEmpty = () => {
      emptyEvents += 1;
    };
    document.addEventListener("tilecast-widget-empty", onEmpty);
    try {
      renderBackfill(assetFor(listManifest, "list-asset"));

      await waitFor(() =>
        expect(document.querySelector("tc-widget-list")).toBeInTheDocument(),
      );
      const widget = document.querySelector("tc-widget-list");
      expect(widget).toBeInTheDocument();
      await waitFor(() => expect(emptyEvents).toBeGreaterThan(0));
      await waitFor(() => expect(animationFrames).toHaveLength(1));
      expect(captureWidgetPreview).not.toHaveBeenCalled();

      captureWidgetPreview.mockImplementationOnce(
        async (captureRoot: HTMLElement) => {
          expect(captureRoot.querySelector("tc-widget-list")).toBe(widget);
          return new Blob(["preview"], { type: "image/jpeg" });
        },
      );

      runNextAnimationFrame(1);
      runNextAnimationFrame(2);
      await waitFor(() =>
        expect(captureWidgetPreview).toHaveBeenCalledTimes(1),
      );
      await waitFor(() =>
        expect(api.uploadWidgetPreview).toHaveBeenCalledWith(
          "list-asset",
          expect.any(Blob),
          "csrf-token",
        ),
      );
    } finally {
      document.removeEventListener("tilecast-widget-empty", onEmpty);
    }
  });
});

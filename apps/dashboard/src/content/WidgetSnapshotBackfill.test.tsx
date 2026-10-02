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
import { WIDGET_PREVIEW_CAPTURE_VERSION } from "./widgetPreviewCapture";
import clockManifest from "../../../../widgets/clock/tilecast.widget.json";
import listManifest from "../../../../widgets/list/tilecast.widget.json";
import { WidgetSnapshotBackfill } from "./WidgetSnapshotBackfill";

const captureWidgetPreview = vi.hoisted(() => vi.fn());

vi.mock("./widgetPreviewCapture", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./widgetPreviewCapture")>();
  return {
    ...actual,
    captureWidgetPreview,
  };
});

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

function renderBackfillPages(pages: Asset[][]) {
  const total = pages.reduce((count, page) => count + page.length, 0);
  vi.spyOn(api, "assets").mockImplementation((params) => {
    const page = Number(params.get("page"));
    return Promise.resolve({
      items: pages[page - 1] ?? [],
      total,
      page,
      pageSize: 100,
    });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WidgetSnapshotBackfill />
    </QueryClientProvider>,
  );
}

function renderBackfill(assets: Asset | Asset[]) {
  return renderBackfillPages([Array.isArray(assets) ? assets : [assets]]);
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
  it("continues to the next Widget when V2 configuration compilation fails", async () => {
    const clock = widgetDefinition(clockManifest);
    const brokenClock: WidgetDefinition = {
      ...clock,
      component: {
        ...clock.component!,
        configTemplate: { requiredValue: { $config: "requiredValue" } },
      },
    };
    vi.spyOn(api, "contentDefinitions").mockResolvedValue({
      ...definitions,
      widgets: [brokenClock, widgetDefinition(listManifest)],
    });
    const invalid = assetFor(clockManifest, "invalid-clock");
    invalid.widget!.configuration = {};
    invalid.widget!.authorConfiguration = {};

    renderBackfill([invalid, assetFor(listManifest, "valid-list")]);

    await waitFor(() => expect(animationFrames).toHaveLength(1));
    runNextAnimationFrame(1);
    runNextAnimationFrame(2);
    await waitFor(() =>
      expect(api.uploadWidgetPreview).toHaveBeenCalledWith(
        "valid-list",
        expect.any(Blob),
        "csrf-token",
      ),
    );
    expect(api.uploadWidgetPreview).not.toHaveBeenCalledWith(
      "invalid-clock",
      expect.any(Blob),
      "csrf-token",
    );
  });

  it("finishes a capture when the library re-renders during its upload", async () => {
    // The library re-renders while a capture uploads (for example on the next
    // assets refetch). That render must not cancel the capture: the image is
    // already stored, so the list has to refresh and the backfill has to move
    // on to the next Widget.
    let finishUpload: () => void = () => undefined;
    vi.mocked(api.uploadWidgetPreview).mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishUpload = () => resolve(undefined);
        }),
    );
    vi.spyOn(api, "contentDefinitions").mockResolvedValue({
      ...definitions,
      widgets: [
        widgetDefinition(clockManifest),
        widgetDefinition(listManifest),
      ],
    });
    const assets = [
      assetFor(clockManifest, "first-clock"),
      assetFor(listManifest, "second-list"),
    ];
    vi.spyOn(api, "assets").mockResolvedValue({
      items: assets,
      total: assets.length,
      page: 1,
      pageSize: 100,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const tree = (
      <QueryClientProvider client={client}>
        <WidgetSnapshotBackfill />
      </QueryClientProvider>
    );
    const view = render(tree);

    await waitFor(() => expect(animationFrames).toHaveLength(1));
    runNextAnimationFrame(1);
    runNextAnimationFrame(2);
    await waitFor(() =>
      expect(api.uploadWidgetPreview).toHaveBeenCalledWith(
        "first-clock",
        expect.any(Blob),
        "csrf-token",
      ),
    );

    // A parent re-render hands the backfill fresh props and callbacks.
    view.rerender(
      <QueryClientProvider client={client}>
        <WidgetSnapshotBackfill enabled />
      </QueryClientProvider>,
    );
    await act(async () => {
      finishUpload();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["assets"] }),
    );
    await waitFor(() => expect(animationFrames).toHaveLength(1));
    runNextAnimationFrame(3);
    runNextAnimationFrame(4);
    await waitFor(() =>
      expect(api.uploadWidgetPreview).toHaveBeenCalledWith(
        "second-list",
        expect.any(Blob),
        "csrf-token",
      ),
    );
  });

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

    // Record the captured element at call time: the backfill settles and
    // tears the mount down right after the capture, so reading the live
    // node afterwards races the disposal.
    let capturedWidget: Element | null | undefined;
    captureWidgetPreview.mockImplementationOnce((captureRoot: HTMLElement) => {
      capturedWidget = captureRoot.querySelector("tc-widget-clock");
      return Promise.resolve(new Blob(["preview"], { type: "image/jpeg" }));
    });

    runNextAnimationFrame(2);
    await waitFor(() => expect(captureWidgetPreview).toHaveBeenCalledTimes(1));
    expect(capturedWidget).toBe(widget);
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
        (captureRoot: HTMLElement) => {
          expect(captureRoot.querySelector("tc-widget-list")).toBe(widget);
          return Promise.resolve(new Blob(["preview"], { type: "image/jpeg" }));
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

  it("finds Widgets beyond page 100 independently of visible library filters", async () => {
    const currentAssets = Array.from({ length: 100 }, (_, index) => ({
      ...assetFor(clockManifest, `current-${index}`),
      thumbnailUrl: `/thumbnail-${index}.jpg`,
      metadata: {
        widgetPreviewCaptureVersion: WIDGET_PREVIEW_CAPTURE_VERSION,
      },
    }));
    const staleAsset = assetFor(clockManifest, "stale-after-page-100");
    renderBackfillPages([currentAssets, [staleAsset]]);

    await waitFor(() =>
      expect(document.querySelector("tc-widget-clock")).toBeInTheDocument(),
    );
    await waitFor(() => expect(api.assets).toHaveBeenCalledTimes(2));
    const requests = vi.mocked(api.assets).mock.calls.map(([params]) => ({
      page: params.get("page"),
      pageSize: params.get("pageSize"),
      type: params.get("type"),
      search: params.get("search"),
      provider: params.get("provider"),
    }));
    expect(requests).toEqual([
      {
        page: "1",
        pageSize: "100",
        type: "widget",
        search: null,
        provider: null,
      },
      {
        page: "2",
        pageSize: "100",
        type: "widget",
        search: null,
        provider: null,
      },
    ]);
    await waitFor(() => expect(animationFrames).toHaveLength(1));

    runNextAnimationFrame(1);
    runNextAnimationFrame(2);
    await waitFor(() => expect(captureWidgetPreview).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(api.uploadWidgetPreview).toHaveBeenCalledWith(
        staleAsset.id,
        expect.any(Blob),
        "csrf-token",
      ),
    );
  });
});

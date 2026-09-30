// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import * as authModule from "../auth/AuthProvider";
import type {
  Asset,
  ContentDefinitionCatalog,
  Layout,
  LayoutDocument,
  Playlist,
  PlaylistList,
} from "../api/types";
import * as previewCapture from "../content/widgetPreviewCapture";
import {
  LayoutCaptureCoordinator,
  type LayoutCaptureWaitResult,
} from "../components/layout-editor/layoutCaptureReadiness";
import { createPrimitivePlacement, LayoutEditorPage } from "./LayoutEditorPage";

// Guards the initial preview capture in LayoutEditorPage: when an edit lands
// while the settle wait is still pending, cleanup cancels the stale attempt
// and the effect must retry with the current inputs instead of suppressing
// the capture forever.

const canvas: LayoutDocument["canvas"] = {
  width: 1920,
  height: 1080,
  orientation: "landscape",
  backgroundColor: "#101820",
  safeAreaPercent: 5,
};

function buildLayout(): Layout {
  const placement = {
    ...createPrimitivePlacement("text", canvas),
    x: 100,
    y: 100,
    width: 105,
    height: 155,
  };
  return {
    id: "layout-1",
    name: "Lobby",
    description: "",
    orientation: "landscape",
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    draft: { schemaVersion: 2, canvas, placements: [placement] },
    draftRevision: 1,
    hasUnpublishedChanges: false,
    dependencies: [],
    usage: { screens: [], schedules: [], campaigns: [] },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function mockAuth() {
  vi.spyOn(authModule, "useAuth").mockReturnValue({
    status: {
      authenticated: true,
      user: { id: "u1", name: "User", username: "user", role: "owner" },
      csrfToken: "tok",
    },
    isLoading: false,
  } as unknown as ReturnType<typeof authModule.useAuth>);
}

function renderLayoutEditor(
  options: {
    layout?: Layout;
    assets?: Asset[];
    contentDefinitions?: Promise<ContentDefinitionCatalog>;
    playlists?: Promise<PlaylistList>;
  } = {},
) {
  const layout = options.layout ?? buildLayout();
  vi.spyOn(api, "layout").mockResolvedValue(layout);
  vi.spyOn(api, "assets").mockImplementation((params) => {
    const type = params.get("type");
    const items = (options.assets ?? []).filter(
      (asset) => !type || asset.type === type,
    );
    const pageSize = Number(params.get("pageSize")) || 100;
    return Promise.resolve({
      items,
      total: items.length,
      page: 1,
      pageSize,
    });
  });
  vi.spyOn(api, "playlists").mockReturnValue(
    options.playlists ??
      Promise.resolve({
        items: [],
        total: 0,
        page: 1,
        pageSize: 100,
      }),
  );
  vi.spyOn(api, "listDataSources").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 100,
  });
  vi.spyOn(api, "contentDefinitions").mockReturnValue(
    options.contentDefinitions ??
      Promise.resolve({
        revision: "test",
        compilerVersion: "test",
        fingerprint: "test",
        widgets: [],
        dataSources: [],
      }),
  );
  // Autosave must never reach its own thumbnail capture: hang the draft save
  // so a save-triggered upload cannot masquerade as the initial-capture retry.
  vi.spyOn(api, "saveLayoutDraft").mockImplementation(
    () => new Promise(() => {}),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/layouts/layout-1"]}>
        <Routes>
          <Route path="/layouts/:id" element={<LayoutEditorPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: canvas.width,
    height: canvas.height,
    top: 0,
    left: 0,
    right: canvas.width,
    bottom: canvas.height,
    x: 0,
    y: 0,
    toJSON: () => "",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Layout editor initial preview capture", () => {
  it("waits for Widget definitions and playlist metadata before capture", async () => {
    mockAuth();
    let resolveDefinitions!: (value: ContentDefinitionCatalog) => void;
    let resolvePlaylists!: (value: PlaylistList) => void;
    const definitions = new Promise<ContentDefinitionCatalog>((resolve) => {
      resolveDefinitions = resolve;
    });
    const playlists = new Promise<PlaylistList>((resolve) => {
      resolvePlaylists = resolve;
    });
    const layout = buildLayout();
    layout.draft.placements = [
      {
        id: "direct-widget",
        type: "widget",
        name: "Clock",
        x: 0,
        y: 0,
        width: 480,
        height: 270,
        layer: 0,
        opacity: 1,
        visible: true,
        locked: false,
        widgetId: "widget-1",
      },
      {
        id: "playlist-zone",
        type: "playlistZone",
        name: "Lobby loop",
        x: 500,
        y: 0,
        width: 480,
        height: 270,
        layer: 1,
        opacity: 1,
        visible: true,
        locked: false,
        playlistId: "playlist-1",
      },
    ];
    const asset = {
      id: "widget-1",
      name: "Clock",
      type: "widget",
      processingStatus: "ready",
      widget: {
        provider: "clock",
        configVersion: 1,
        configuration: {},
        authorConfiguration: {},
      },
    } as unknown as Asset;
    const playlist: Playlist = {
      id: "playlist-1",
      name: "Lobby loop",
      description: "",
      revision: 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "playlist-item-1",
          assetId: "widget-1",
          position: 0,
          fitMode: "contain",
          transition: "none",
          audioEnabled: false,
          volume: 0,
          deliveryPolicy: "download",
          assetName: "Clock",
          assetType: "widget",
          widgetProvider: "clock",
          assetStatus: "ready",
          thumbnailUrl: "https://example.org/clock-preview.jpg",
        },
      ],
      itemCount: 1,
      warnings: [],
      layoutUsage: [],
    };
    const catalog = {
      revision: "test",
      compilerVersion: "test",
      fingerprint: "test",
      widgets: [
        {
          id: "clock",
          configurationSchema: { fields: [] },
          component: {
            type: "tilecast.clock",
            version: 1,
            configTemplate: {},
            dataSourceFields: [],
          },
        },
      ],
      dataSources: [],
    } as unknown as ContentDefinitionCatalog;
    const waitForSettled = vi.spyOn(
      LayoutCaptureCoordinator.prototype,
      "waitForSettled",
    );
    let playlistImagesAtCapture = 0;
    vi.spyOn(previewCapture, "captureLayoutPreview").mockImplementation(() => {
      playlistImagesAtCapture = document.querySelectorAll(
        ".layout-placement img.layout-asset-placement",
      ).length;
      return Promise.resolve(new Blob(["preview"], { type: "image/jpeg" }));
    });
    const upload = vi
      .spyOn(api, "uploadLayoutPreview")
      .mockResolvedValue(undefined);
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);

    renderLayoutEditor({
      layout,
      assets: [asset],
      contentDefinitions: definitions,
      playlists,
    });
    await waitFor(() => {
      expect(api.contentDefinitions).toHaveBeenCalledOnce();
      expect(api.playlists).toHaveBeenCalledOnce();
    });
    expect(waitForSettled).not.toHaveBeenCalled();

    resolveDefinitions(catalog);
    await waitFor(() =>
      expect(document.querySelector("tc-widget-clock")).toBeInTheDocument(),
    );
    expect(waitForSettled).not.toHaveBeenCalled();

    resolvePlaylists({
      items: [playlist],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    expect(waitForSettled).toHaveBeenCalledWith(
      ["direct-widget"],
      expect.any(Number),
    );
    expect(playlistImagesAtCapture).toBe(1);
  });

  it("retries with current inputs when an edit cancels the pending settle wait", async () => {
    mockAuth();
    let resolveFirstWait!: (result: LayoutCaptureWaitResult) => void;
    const firstWait = new Promise<LayoutCaptureWaitResult>((resolve) => {
      resolveFirstWait = resolve;
    });
    const waitForSettled = vi
      .spyOn(LayoutCaptureCoordinator.prototype, "waitForSettled")
      .mockImplementationOnce(() => firstWait)
      .mockResolvedValue({ ok: true, failedIds: [] });
    vi.spyOn(previewCapture, "captureLayoutPreview").mockResolvedValue(
      new Blob(["preview"], { type: "image/jpeg" }),
    );
    const upload = vi
      .spyOn(api, "uploadLayoutPreview")
      .mockResolvedValue(undefined);
    renderLayoutEditor();
    const placement = await screen.findByText("New text");
    const placementEl = placement.closest(".layout-placement")!;

    // The first attempt starts on mount and parks in the settle wait.
    await waitFor(() => expect(waitForSettled).toHaveBeenCalledTimes(1));

    // Edit the canvas while the wait is pending: cleanup cancels the stale
    // attempt, and the effect retries instead of suppressing the capture.
    fireEvent.pointerDown(placementEl, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 30, pointerId: 1 });

    await waitFor(() => expect(waitForSettled).toHaveBeenCalledTimes(2));
    // Resolving the cancelled wait must be a no-op, never a second upload.
    resolveFirstWait({ ok: true, failedIds: [] });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload).toHaveBeenCalledWith("layout-1", 1, expect.any(Blob), "tok");
  });
});

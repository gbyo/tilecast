// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { Layout } from "../api/types";
import * as authModule from "../auth/AuthProvider";
import { LAYOUT_PREVIEW_CAPTURE_VERSION } from "../content/widgetPreviewCapture";
import { LayoutEditorPage } from "./LayoutEditorPage";

// The editor panes render inside Base UI ScrollAreas, whose viewport probes
// this jsdom-missing API. It stays scoped to this file so other suites keep
// their menu and modal timing.
if (typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockServer() {
  vi.spyOn(authModule, "useAuth").mockReturnValue({
    status: {
      authenticated: true,
      setupRequired: false,
      user: { id: "u1", name: "Owner", username: "owner", role: "owner" },
      csrfToken: "token",
    },
    isLoading: false,
  } as unknown as ReturnType<typeof authModule.useAuth>);
  const layout: Layout = {
    id: "layout-1",
    name: "Lobby",
    description: "",
    orientation: "landscape",
    canvasWidth: 1920,
    canvasHeight: 1080,
    draft: {
      schemaVersion: 2,
      canvas: {
        width: 1920,
        height: 1080,
        orientation: "landscape",
        backgroundColor: "#101820",
        safeAreaPercent: 5,
      },
      placements: [],
    },
    draftRevision: 3,
    hasUnpublishedChanges: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    previewImageUrl: "https://example.com/preview.png",
    previewCaptureVersion: LAYOUT_PREVIEW_CAPTURE_VERSION,
    dependencies: [],
    usage: { screens: [], schedules: [], campaigns: [] },
  };
  vi.spyOn(api, "layout").mockResolvedValue(layout);
  const assets = vi.spyOn(api, "assets").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 100,
  });
  vi.spyOn(api, "playlists").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 30,
  });
  vi.spyOn(api, "listDataSources").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 100,
  });
  vi.spyOn(api, "contentDefinitions").mockResolvedValue({
    revision: "1",
    compilerVersion: "1",
    fingerprint: "test",
    widgets: [],
    dataSources: [],
  });
  return { assets };
}

function renderEditor() {
  const router = createMemoryRouter(
    [{ path: "/layouts/:id", element: <LayoutEditorPage /> }],
    { initialEntries: ["/layouts/layout-1"] },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("Layout editor Recent shelf", () => {
  it("loads per-section recent asset pools instead of an alphabetic page", async () => {
    const { assets } = mockServer();
    renderEditor();
    await waitFor(() =>
      expect(assets.mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    const pools = assets.mock.calls.map(([params]) => params);
    const pool = (type: string | null) =>
      pools.find((params) => (params.get("type") ?? null) === type);
    // Shelf pools: small, type-filtered, newest-first by creation (the
    // endpoint default, so no sort parameter is sent).
    for (const type of ["widget", "media"]) {
      const recent = pool(type);
      expect(recent, `recent ${type} pool requested`).toBeDefined();
      expect(recent!.get("status")).toBe("ready");
      expect(recent!.get("pageSize")).toBe("20");
      expect(recent!.has("sort")).toBe(false);
    }
    // The alphabetic page stays for by-id resolution of placed content.
    const resolution = pool(null);
    expect(resolution, "resolution page requested").toBeDefined();
    expect(resolution!.get("sort")).toBe("name");
    expect(resolution!.get("pageSize")).toBe("100");
  });
});

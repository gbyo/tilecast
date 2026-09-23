// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Playlist } from "../../api/types";
import * as authModule from "../../auth/AuthProvider";
import { PlaylistEditorPage } from "./PlaylistEditor";

const defaultMatchMedia = window.matchMedia.bind(window);

// See PlaylistTimeline.test.tsx: the timeline's ScrollArea needs this
// jsdom-missing API, scoped to this file so other suites keep their timing.
if (typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.matchMedia = defaultMatchMedia;
});

function playlist(): Playlist {
  const items = [
    {
      id: "item-a",
      assetId: "asset-a",
      position: 0,
      durationMs: 10_000,
      fitMode: "contain" as const,
      transition: "none" as const,
      audioEnabled: false,
      volume: 1,
      deliveryPolicy: "download" as const,
      assetName: "Alpha",
      assetType: "image" as const,
      assetStatus: "ready" as const,
      thumbnailUrl: "https://example.com/a.png",
    },
    {
      id: "item-b",
      assetId: "asset-b",
      position: 1,
      durationMs: 10_000,
      fitMode: "contain" as const,
      transition: "none" as const,
      audioEnabled: false,
      volume: 1,
      deliveryPolicy: "download" as const,
      assetName: "Beta",
      assetType: "image" as const,
      assetStatus: "ready" as const,
      thumbnailUrl: "https://example.com/b.png",
    },
  ];
  return {
    id: "p1",
    name: "Lobby loop",
    description: "",
    revision: 3,
    draftRevision: 3,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    items,
    itemCount: 2,
    warnings: [],
    layoutUsage: [],
    usage: { screens: [], schedules: [], campaigns: [] },
    sourceType: "static",
  };
}

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
  vi.spyOn(api, "playlist").mockResolvedValue(playlist());
  vi.spyOn(api, "layouts").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 100,
  });
  vi.spyOn(api, "contentTags").mockResolvedValue([]);
}

function renderEditor() {
  const router = createMemoryRouter(
    [{ path: "/playlists/:id", element: <PlaylistEditorPage /> }],
    { initialEntries: ["/playlists/p1"] },
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

function mockDesktop() {
  if (!("ResizeObserver" in window)) {
    (window as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  window.matchMedia = () => ({
    matches: true,
    media: "(min-width: 1024px)",
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  });
}

describe("PlaylistEditor panes", () => {
  it("shows the inspector inline with a Playlist settings empty state on desktop", async () => {
    mockDesktop();
    mockServer();
    renderEditor();

    expect(
      await screen.findByRole("group", {
        name: "Playlist sequence and inspector",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Playlist settings" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Inspect Alpha" }));
    expect(
      await screen.findByRole("complementary", { name: "Item inspector" }),
    ).toBeInTheDocument();
    // Inline on desktop: no dialog takes over the screen.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("falls back to a stacked layout with a Sheet inspector on narrow screens", async () => {
    mockServer();
    renderEditor();

    await screen.findByRole("button", { name: "Inspect Alpha" });
    expect(
      screen.queryByRole("group", {
        name: "Playlist sequence and inspector",
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Inspect Alpha" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

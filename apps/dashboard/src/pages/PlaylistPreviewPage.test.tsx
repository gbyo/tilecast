// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { Asset, WidgetPresentation } from "../api/types";
import * as authModule from "../auth/AuthProvider";
import {
  DeclarativePresentationPreview,
  formatCountdownPreview,
} from "../content/SourceEditors";
import { PlaylistPreviewPage } from "./PlaylistPreviewPage";
import { PLAYLIST_PREVIEW_FADE_MS } from "./PlaylistPreviewPage";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("renders only ready playlist items in the popup player", async () => {
  vi.spyOn(authModule, "useAuth").mockReturnValue({
    status: {
      authenticated: true,
      setupRequired: false,
      user: { id: "u1", name: "Owner", username: "owner", role: "owner" },
      csrfToken: "token",
    },
    isLoading: false,
  } as ReturnType<typeof authModule.useAuth>);
  vi.spyOn(api, "playlist").mockResolvedValue({
    id: "p1",
    name: "Lobby loop",
    description: "",
    revision: 3,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    itemCount: 2,
    warnings: [],
    layoutUsage: [],
    items: [
      {
        id: "ready",
        assetId: "asset-1",
        position: 0,
        durationMs: 10_000,
        fitMode: "contain",
        transition: "fade",
        audioEnabled: false,
        volume: 0,
        deliveryPolicy: "download",
        assetName: "Welcome",
        assetType: "image",
        assetStatus: "ready",
        thumbnailUrl: "/thumb-1",
      },
      {
        id: "processing",
        assetId: "asset-2",
        position: 1,
        durationMs: 10_000,
        fitMode: "contain",
        transition: "none",
        audioEnabled: false,
        volume: 0,
        deliveryPolicy: "download",
        assetName: "Not ready",
        assetType: "image",
        assetStatus: "processing",
        thumbnailUrl: "/thumb-2",
      },
    ],
  });
  const router = createMemoryRouter(
    [
      {
        path: "/playlists/:id/preview",
        element: <PlaylistPreviewPage />,
      },
    ],
    { initialEntries: ["/playlists/p1/preview"] },
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

  expect(await screen.findByText("Lobby loop")).toBeInTheDocument();
  expect(screen.getByText("1 of 1 · Welcome")).toBeInTheDocument();
  expect(screen.queryByText("Not ready")).not.toBeInTheDocument();
  expect(screen.getByRole("presentation")).toHaveAttribute(
    "src",
    "/api/v1/assets/asset-1/preview",
  );
  expect(screen.getByRole("button", { name: "Pause preview" })).toBeEnabled();
});

it("keeps the outgoing item visible until the incoming crossfade item is ready", async () => {
  vi.spyOn(authModule, "useAuth").mockReturnValue({
    status: {
      authenticated: true,
      setupRequired: false,
      user: { id: "u1", name: "Owner", username: "owner", role: "owner" },
      csrfToken: "token",
    },
    isLoading: false,
  } as ReturnType<typeof authModule.useAuth>);
  vi.spyOn(api, "playlist").mockResolvedValue({
    id: "p1",
    name: "Crossfade loop",
    description: "",
    revision: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    itemCount: 2,
    warnings: [],
    layoutUsage: [],
    items: [
      {
        id: "first",
        assetId: "asset-1",
        position: 0,
        durationMs: 10_000,
        fitMode: "contain",
        transition: "none",
        audioEnabled: false,
        volume: 0,
        deliveryPolicy: "download",
        assetName: "First",
        assetType: "image",
        assetStatus: "ready",
        thumbnailUrl: "/thumb-1",
      },
      {
        id: "second",
        assetId: "asset-2",
        position: 1,
        durationMs: 10_000,
        fitMode: "contain",
        transition: "crossfade",
        audioEnabled: false,
        volume: 0,
        deliveryPolicy: "download",
        assetName: "Second",
        assetType: "image",
        assetStatus: "ready",
        thumbnailUrl: "/thumb-2",
      },
    ],
  });
  const router = createMemoryRouter(
    [{ path: "/playlists/:id/preview", element: <PlaylistPreviewPage /> }],
    { initialEntries: ["/playlists/p1/preview"] },
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

  expect(await screen.findByText("1 of 2 · First")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next item" }));
  expect(screen.getByText("2 of 2 · Second")).toBeInTheDocument();
  expect(screen.getAllByRole("presentation")).toHaveLength(2);

  const incoming = screen
    .getAllByRole("presentation")
    .find((element) => element.getAttribute("src")?.includes("asset-2"));
  expect(incoming).toBeDefined();
  vi.useFakeTimers();
  fireEvent.load(incoming!);
  expect(
    document.querySelector(".playlist-preview-page__media--outgoing-active"),
  ).toBeInTheDocument();
  await act(() => vi.advanceTimersByTime(PLAYLIST_PREVIEW_FADE_MS));
  expect(screen.getAllByRole("presentation")).toHaveLength(1);
});

it("loads the saved configuration and renders a native Clock Widget", async () => {
  vi.spyOn(authModule, "useAuth").mockReturnValue({
    status: {
      authenticated: true,
      setupRequired: false,
      user: { id: "u1", name: "Owner", username: "owner", role: "owner" },
      csrfToken: "token",
    },
    isLoading: false,
  } as ReturnType<typeof authModule.useAuth>);
  vi.spyOn(api, "playlist").mockResolvedValue({
    id: "p1",
    name: "Widget loop",
    description: "",
    revision: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    itemCount: 1,
    warnings: [],
    layoutUsage: [],
    items: [
      {
        id: "clock-item",
        assetId: "clock-asset",
        position: 0,
        durationMs: 30_000,
        fitMode: "contain",
        transition: "none",
        audioEnabled: false,
        volume: 0,
        deliveryPolicy: "stream",
        assetName: "Lobby clock",
        assetType: "widget",
        widgetProvider: "clock",
        assetStatus: "ready",
        thumbnailUrl: "",
      },
    ],
  });
  vi.spyOn(api, "asset").mockResolvedValue({
    id: "clock-asset",
    name: "Lobby clock",
    description: "",
    type: "widget",
    originalFilename: "",
    declaredMimeType: "application/json",
    detectedMimeType: "application/json",
    sha256: "",
    originalSize: 0,
    metadata: {},
    processingStatus: "ready",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    variants: [],
    playlistUsage: 0,
    layoutUsage: [],
    tags: [],
    collectionIds: [],
    widget: {
      provider: "clock",
      configVersion: 1,
      configuration: {
        timezone: "UTC",
        format: "24",
        showSeconds: true,
        foregroundColor: "#ffffff",
        backgroundColor: "#111111",
      },
    },
  } satisfies Asset);
  vi.spyOn(api, "compileWidgetPreview").mockResolvedValue({
    schemaVersion: 1,
    kind: "native",
    requiredCapabilities: {},
    native: {
      root: {
        type: "surface",
        props: { backgroundColor: "#111111", padding: 10 },
        children: [
          {
            type: "text",
            props: { color: "#ffffff", role: "metric" },
            binding: {
              source: "environment",
              format: "time:24:true:UTC",
            },
          },
        ],
      },
    },
  });
  const router = createMemoryRouter(
    [{ path: "/playlists/:id/preview", element: <PlaylistPreviewPage /> }],
    { initialEntries: ["/playlists/p1/preview"] },
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

  expect(
    await screen.findByText((value) => /^\d{2}:\d{2}:\d{2}$/.test(value)),
  ).toBeInTheDocument();
  expect(api.asset).toHaveBeenCalledWith("clock-asset");
  expect(api.compileWidgetPreview).toHaveBeenCalledWith(
    "clock",
    expect.objectContaining({ timezone: "UTC", showSeconds: true }),
    "token",
  );
  expect(
    document.querySelector<HTMLElement>(".presentation-preview__surface"),
  ).toHaveStyle({ background: "#111111" });
  expect(
    screen.queryByText("This item could not be previewed in Studio."),
  ).not.toBeInTheDocument();
});

it("formats Countdown Widgets from their real target and completion state", () => {
  const now = new Date("2026-07-21T12:00:00Z");
  expect(
    formatCountdownPreview(
      "2026-07-23T14:03:04Z",
      "countdown",
      "Doors open",
      now,
    ),
  ).toBe("2d 2h 3m 4s");
  expect(
    formatCountdownPreview(
      "2026-07-20T12:00:00Z",
      "countdown",
      "Doors open",
      now,
    ),
  ).toBe("Doors open");
  expect(
    formatCountdownPreview("2026-07-20T12:00:00Z", "count_up", "Complete", now),
  ).toBe("1d 0h 0m 0s");
  expect(
    formatCountdownPreview(
      "2026-07-20T14:00:00Z",
      "countdown",
      "Complete",
      now,
      "daily",
      "UTC",
      "completed_text",
      "0110",
    ),
  ).toBe("2h 0m");
  expect(
    formatCountdownPreview(
      "2026-07-14T12:00:00Z",
      "countdown",
      "Complete",
      now,
      "weekly",
      "UTC",
    ),
  ).toBe("7d 0h 0m 0s");
});

it("renders shared compiled nodes for data-backed and catalog Widgets", () => {
  const presentation: WidgetPresentation = {
    schemaVersion: 1,
    kind: "native",
    requiredCapabilities: {},
    native: {
      root: {
        type: "surface",
        children: [
          {
            type: "text",
            props: { role: "metric" },
            binding: {
              source: "environment",
              format: "countdown:2026-07-23T14:03:04Z:UTC:countdown:Complete",
            },
          },
          {
            type: "repeat",
            repeat: { dataset: "source:records", limit: 2 },
            children: [
              {
                type: "text",
                binding: { source: "repeat", path: "title" },
              },
            ],
          },
          {
            type: "progress",
            props: { target: 100, showPercent: true },
            binding: { source: "dataset", path: "value" },
          },
          {
            type: "bar_chart",
            binding: { source: "dataset", fields: ["value"] },
          },
        ],
      },
    },
  };

  render(
    <DeclarativePresentationPreview
      presentation={presentation}
      source={{
        records: [{ id: "1", values: { title: "Welcome", value: "50" } }],
      }}
      now={new Date("2026-07-21T12:00:00Z")}
    />,
  );

  expect(screen.getByText("2d 2h 3m 4s")).toBeInTheDocument();
  expect(screen.getByText("Welcome")).toBeInTheDocument();
  expect(screen.getByText("50%")).toBeInTheDocument();
  expect(
    document.querySelectorAll(".presentation-preview__chart i"),
  ).toHaveLength(1);
});

it("applies authored typography and card styles in declarative previews", () => {
  const presentation: WidgetPresentation = {
    schemaVersion: 1,
    kind: "native",
    requiredCapabilities: {},
    native: {
      root: {
        type: "surface",
        children: [
          {
            type: "column",
            props: {
              background: "#19324d",
              padding: 14,
              radius: 10,
            },
            children: [
              {
                type: "text",
                props: { role: "metric", fontSize: 72 },
                binding: { source: "literal", value: "Period 3" },
              },
            ],
          },
        ],
      },
    },
  };

  render(
    <DeclarativePresentationPreview presentation={presentation} source={{}} />,
  );

  expect(screen.getByText("Period 3")).toHaveStyle({ fontSize: "72px" });
  expect(
    document.querySelector<HTMLElement>(".presentation-preview__column"),
  ).toHaveStyle({
    background: "#19324d",
    padding: "14px",
    borderRadius: "10px",
  });
});

it("renders compiled Website and YouTube presentations in a sandboxed frame", () => {
  const ready = vi.fn();
  render(
    <DeclarativePresentationPreview
      presentation={{
        schemaVersion: 1,
        kind: "web",
        requiredCapabilities: { "web.remote": 1 },
        web: {
          mode: "remote",
          url: "https://www.youtube.com/embed/video-id",
          allowedHosts: ["www.youtube.com"],
          externalNetworkAccess: true,
          onlineOnly: true,
          fallbackBehavior: "placeholder",
          loadTimeoutSeconds: 30,
          lifecycle: "destroy_on_hide",
          warmSeconds: 0,
        },
      }}
      source={undefined}
      onWebReady={ready}
    />,
  );

  const frame = screen.getByTitle("Web Widget preview");
  expect(frame).toHaveAttribute(
    "src",
    "https://www.youtube.com/embed/video-id",
  );
  expect(frame).toHaveAttribute(
    "sandbox",
    expect.stringContaining("allow-scripts"),
  );
  fireEvent.load(frame);
  expect(ready).toHaveBeenCalledOnce();
});

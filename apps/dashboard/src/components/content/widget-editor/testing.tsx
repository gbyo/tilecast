/**
 * Test support for the Widget editor: the catalog built from the
 * repository's own definition files, and a data-router harness that renders
 * the editor route the way Studio does.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryRouter,
  useLocation,
} from "react-router";
import { vi } from "vitest";
import { api } from "@/api/client";
import type {
  Asset,
  ContentDefinitionCatalog,
  DataSourceDefinition,
  User,
  WidgetDefinition,
} from "@/api/types";
import { AuthProvider } from "@/auth/AuthProvider";
import { WidgetEditorPage } from "@/pages/WidgetEditorPage";
import { WidgetSnapshotQueue } from "./WidgetSnapshotQueue";

// Base UI ScrollArea reads animations that jsdom does not implement.
if (
  typeof Element !== "undefined" &&
  typeof Element.prototype.getAnimations !== "function"
)
  Element.prototype.getAnimations = () => [];

const releaseFiles = import.meta.glob<{
  widgets?: WidgetDefinition[];
  dataSources?: DataSourceDefinition[];
}>("../../../../../server/internal/contentdefs/definitions/*.json", {
  eager: true,
  import: "default",
});
const moduleFiles = import.meta.glob<WidgetDefinition>(
  "../../../../../../widgets/*/tilecast.widget.json",
  { eager: true, import: "default" },
);

/**
 * Emulate a viewport width class. The editor mounts exactly one layout:
 * the resizable split on desktop, the stacked layout below it.
 */
export function useViewport(kind: "desktop" | "tablet" | "phone") {
  // The resizable split measures itself; jsdom has no observer to do so.
  if (!("ResizeObserver" in window))
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      query === "(min-width: 1024px)"
        ? kind === "desktop"
        : query === "(max-width: 639px)"
          ? kind === "phone"
          : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
}

/** Every Widget definition the release ships, as the catalog serves it. */
export function repositoryCatalog(): ContentDefinitionCatalog {
  const widgets = [
    ...Object.values(releaseFiles).flatMap((file) => file.widgets ?? []),
    ...Object.values(moduleFiles),
  ].map((definition) => structuredClone(definition));
  return {
    revision: "repository",
    compilerVersion: "test",
    fingerprint: "repository",
    widgets,
    dataSources: Object.values(releaseFiles).flatMap(
      (file) => file.dataSources ?? [],
    ),
  };
}

export function definitionFrom(
  catalog: ContentDefinitionCatalog,
  id: string,
): WidgetDefinition {
  const definition = catalog.widgets.find((entry) => entry.id === id);
  if (!definition) throw new Error(`no definition ${id}`);
  return definition;
}

export function savedWidget(
  provider: string,
  configuration: Record<string, unknown>,
  overrides: Partial<Asset> = {},
): Asset {
  return {
    id: "widget-1",
    name: "Lunch Countdown",
    description: "",
    type: "widget",
    originalFilename: "",
    declaredMimeType: "application/vnd.tilecast.widget+json",
    detectedMimeType: "application/vnd.tilecast.widget+json",
    sha256: "",
    originalSize: 0,
    metadata: {},
    processingStatus: "ready",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    variants: [],
    playlistUsage: 0,
    playlistsUsing: [],
    layoutUsage: [],
    tags: [],
    collectionIds: [],
    widget: {
      provider,
      configVersion: 1,
      configuration,
    },
    ...overrides,
  };
}

function CurrentPath() {
  const location = useLocation();
  return (
    <div data-testid="path">{`${location.pathname}${location.search}`}</div>
  );
}

export function mockEditorApi({
  catalog = repositoryCatalog(),
  asset,
  role = "owner",
}: {
  catalog?: ContentDefinitionCatalog;
  asset?: Asset;
  role?: User["role"];
} = {}) {
  vi.spyOn(api, "authStatus").mockResolvedValue({
    setupRequired: false,
    authenticated: true,
    csrfToken: "csrf",
    user: {
      id: "u1",
      name: "Author",
      username: "author",
      role,
      active: true,
      createdAt: "2026-01-01T00:00:00Z",
    },
  });
  vi.spyOn(api, "settings").mockResolvedValue({
    values: {
      "organization.locale": "en-US",
      "organization.timezone": "UTC",
      "organization.time_format": "locale",
    },
  } as never);
  vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog);
  vi.spyOn(api, "listDataSources").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 100,
  });
  vi.spyOn(api, "providerCatalog").mockResolvedValue({
    revision: 1,
    providers: [],
  });
  vi.spyOn(api, "previewSavedDataSource").mockRejectedValue(
    new Error("no sources connected"),
  );
  vi.spyOn(api, "compileWidgetPreview").mockResolvedValue(null);
  const getAsset = vi.spyOn(api, "asset");
  if (asset) getAsset.mockResolvedValue(asset);
  return { catalog };
}

/** Render the editor routes inside a data router, like production Studio. */
export function renderEditorRoute(url: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <>
            <CurrentPath />
            <Outlet />
            <WidgetSnapshotQueue />
          </>
        ),
        children: [
          // i18n-ignore
          { path: "widgets", element: <div>Widget list</div> },
          { path: "widgets/new", element: <WidgetEditorPage /> },
          { path: "widgets/new/:provider", element: <WidgetEditorPage /> },
          { path: "widgets/:id", element: <WidgetEditorPage /> },
          // i18n-ignore
          { path: "layouts/:id", element: <div>Layout editor</div> },
          // i18n-ignore
          { path: "playlists/:id", element: <div>Playlist editor</div> },
          // i18n-ignore
          { path: "assets", element: <div>Media</div> },
        ],
      },
    ],
    { initialEntries: [url] },
  );
  const view = render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

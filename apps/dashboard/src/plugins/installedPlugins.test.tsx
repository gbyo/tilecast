// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isValidElement, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studioRoutes } from "../App";
import type {
  GitHubInstallReview,
  InstalledPackage,
  PackageUpdateCheck,
  PluginMarketplaceStatus,
  PluginStoreCustom,
  PluginStoreEntry,
  PluginStoreMarketplace,
  PluginSummary,
  UnsupportedPluginInstallation,
} from "../api/types";
import { buildCommandResults } from "../components/StudioTopbar";
import { i18n } from "../i18n";
import { PluginsPage } from "../pages/PluginsPage";
import { PluginStoreDetailPage } from "../pages/PluginStoreDetailPage";
import { PluginStorePage } from "../pages/PluginStorePage";
import {
  catalogPlugin,
  customPackage,
  installReview,
  installedPackage,
  marketplaceListing,
  updateCheck,
} from "./catalogFixtures";
import { diffContributions } from "./pluginCatalog";
import { PluginActionsMenu, blockerInstruction } from "./PluginActionsMenu";
import { filterStoreEntries } from "./pluginCatalog";
import { PluginRouteGate } from "./PluginRouteGate";

/** A store entry in the server's shape, wrapping a catalog fixture. */
function storeEntry(item: PluginSummary): PluginStoreEntry {
  return {
    packageId: item.id,
    source: { kind: "included" },
    plugin: item,
  };
}

/** A marketplace store entry in the server's shape. */
function storeMarketplaceEntry(
  packageId: string,
  listing: PluginStoreMarketplace,
): PluginStoreEntry {
  return {
    packageId,
    source: { kind: "marketplace", catalogId: "tilecast-marketplace" },
    marketplace: listing,
  };
}

/** A custom store entry in the server's shape. */
function storeCustomEntry(
  packageId: string,
  custom: PluginStoreCustom,
  repository: string,
): PluginStoreEntry {
  return {
    packageId,
    source: { kind: "custom", repository },
    custom,
  };
}

const auth = vi.hoisted(() => ({ role: "owner" }));
vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      authenticated: true,
      csrfToken: "csrf",
      user: { id: "user", name: "User", role: auth.role },
    },
  }),
}));

type Handler = (request: { method: string; path: string }) => Response;

let catalog: PluginSummary[] = [];
let storeListings: { packageId: string; listing: PluginStoreMarketplace }[] =
  [];
let storeCustoms: {
  packageId: string;
  custom: PluginStoreCustom;
  repository: string;
}[] = [];
let packages: Record<string, InstalledPackage> = {};
let review: GitHubInstallReview | undefined;
let marketplaceResolveError:
  { status: number; code: string; message: string } | undefined;
let check: PackageUpdateCheck | undefined;
let marketplaceStatus: PluginMarketplaceStatus = {
  stale: false,
};
let unsupported: UnsupportedPluginInstallation[] = [];
let calls: { method: string; path: string }[] = [];
let override: Handler | undefined;

function json(status: number, body: unknown) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
  });
}

// jsdom has no ResizeObserver, which Embla needs to measure the Featured
// carousel. An idle one lets it mount; it never reports a resize.
class IdleResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", IdleResizeObserver);
  auth.role = "owner";
  unsupported = [];
  storeListings = [];
  storeCustoms = [];
  packages = {};
  review = undefined;
  marketplaceResolveError = undefined;
  check = undefined;
  marketplaceStatus = { stale: false };
  calls = [];
  override = undefined;
  catalog = [
    catalogPlugin({
      id: "forms",
      installed: true,
      configured: true,
      active: true,
      instanceCount: 2,
    }),
    catalogPlugin({
      id: "transit_alerts",
      name: "Transit Alerts",
      category: "Automation",
      managementPath: "/plugins/transit-alerts",
      installed: true,
    }),
    catalogPlugin({ id: "countdown_bar", installed: false }),
    catalogPlugin({ id: "emergency_alerts", installed: false }),
    catalogPlugin({
      id: "lobby_signs",
      name: "Lobby Signs",
      // i18n-ignore: test fixture label, not Studio copy
      description: "Show wayfinding signs in the lobby.",
      category: "Display",
      managementPath: "/plugins/lobby-signs",
      installed: false,
    }),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      // The transport calls absolute URLs; strip any origin first so the
      // path matching below works for relative and absolute forms.
      const path = new URL(url, "http://localhost").pathname.replace(
        "/api/v1",
        "",
      );
      const request = { method: init?.method ?? "GET", path };
      calls.push(request);
      if (override) return Promise.resolve(override(request));
      if (
        request.method === "POST" &&
        path === "/plugin-store/resolve-github"
      ) {
        if (!review)
          return Promise.resolve(
            json(404, {
              error: { code: "repository_not_found", message: "Not found." },
            }),
          );
        return Promise.resolve(json(200, { data: review }));
      }
      if (
        request.method === "POST" &&
        path.startsWith("/plugin-store/") &&
        path.endsWith("/resolve")
      ) {
        const id = decodeURIComponent(path.split("/")[2] ?? "");
        if (marketplaceResolveError)
          return Promise.resolve(
            json(marketplaceResolveError.status, {
              error: {
                code: marketplaceResolveError.code,
                message: marketplaceResolveError.message,
              },
            }),
          );
        const listed = storeListings.find(
          (candidate) => candidate.packageId === id,
        );
        if (!listed)
          return Promise.resolve(
            json(404, {
              error: { code: "plugin_not_found", message: "Not found." },
            }),
          );
        // The review carries the published manifest, as the server's
        // resolve does; the listing only names the artifact.
        const data =
          review?.packageId === id
            ? review
            : installReview({
                packageId: id,
                version: listed.listing.version,
                manifest: {
                  name: listed.listing.name,
                  description: listed.listing.description ?? "",
                  publisherId: listed.listing.publisherId,
                  publisherName: listed.listing.publisherName,
                  license: listed.listing.license ?? "",
                  tilecastRange: listed.listing.tilecastRange,
                },
                compatible: listed.listing.compatible,
                digest: listed.listing.digest,
                repositoryUrl: listed.listing.repository,
              });
        return Promise.resolve(json(200, { data }));
      }
      if (
        request.method === "POST" &&
        path.startsWith("/plugin-store/") &&
        path.endsWith("/install")
      ) {
        const id = decodeURIComponent(path.split("/")[2] ?? "");
        const listed = storeListings.find(
          (candidate) => candidate.packageId === id,
        );
        const bound = storeCustoms.find(
          (candidate) => candidate.packageId === id,
        );
        if (listed) {
          listed.listing = {
            ...listed.listing,
            installed: true,
            installedVersion: listed.listing.version,
          };
        }
        if (bound) {
          bound.custom = {
            ...bound.custom,
            installed: true,
            installedVersion: bound.custom.version,
          };
        }
        if (!listed && !bound && review?.packageId === id) {
          // Installing a reviewed repository binds it: the store gains a
          // custom entry, as the server's custom source does.
          storeCustoms.push({
            packageId: id,
            custom: {
              version: review.version,
              name: review.manifest.name,
              description: review.manifest.description,
              publisherId: review.manifest.publisherId,
              publisherName: review.manifest.publisherName,
              license: review.manifest.license,
              tilecastRange: review.manifest.tilecastRange,
              digest: review.digest,
              compatible: review.compatible,
              installed: true,
              installedVersion: review.version,
            },
            repository: review.repositoryUrl,
          });
        }
        const version =
          listed?.listing.version ?? bound?.custom.version ?? review?.version;
        if (version === undefined)
          return Promise.resolve(
            json(404, {
              error: { code: "plugin_not_found", message: "Not found." },
            }),
          );
        packages[id] = {
          ...(packages[id] ?? installedPackage({ packageId: id })),
          version,
        };
        return Promise.resolve(json(201, { data: packages[id] }));
      }
      if (request.method === "POST" && path.endsWith("/install")) {
        const id = path.split("/")[2];
        catalog = catalog.map((item) =>
          item.id === id ? { ...item, installed: true } : item,
        );
        return Promise.resolve(
          json(201, { data: catalog.find((item) => item.id === id) }),
        );
      }
      if (request.method === "DELETE" && path.startsWith("/packages/")) {
        const id = decodeURIComponent(path.split("/")[2] ?? "");
        delete packages[id];
        for (const listed of storeListings) {
          if (listed.packageId === id)
            listed.listing = { ...listed.listing, installed: false };
        }
        for (const bound of storeCustoms) {
          if (bound.packageId === id)
            bound.custom = { ...bound.custom, installed: false };
        }
        return Promise.resolve(json(204, {}));
      }
      if (path === "/packages")
        return Promise.resolve(json(200, { data: Object.values(packages) }));
      if (request.method === "GET" && path.startsWith("/packages/")) {
        const id = decodeURIComponent(path.split("/")[2] ?? "");
        const installed = packages[id];
        if (!installed)
          return Promise.resolve(
            json(404, {
              error: { code: "package_not_installed", message: "Not found." },
            }),
          );
        return Promise.resolve(json(200, { data: installed }));
      }
      if (
        request.method === "POST" &&
        path.startsWith("/packages/") &&
        path.endsWith("/update-check")
      ) {
        const id = decodeURIComponent(path.split("/")[2] ?? "");
        const installed = packages[id];
        if (!installed)
          return Promise.resolve(
            json(404, {
              error: { code: "package_not_installed", message: "Not found." },
            }),
          );
        const result = check ?? {
          installed,
          available: false,
          upToDate: true,
          lastChecked: new Date().toISOString(),
        };
        return Promise.resolve(json(200, { data: result }));
      }
      if (
        request.method === "POST" &&
        path.startsWith("/packages/") &&
        path.endsWith("/update")
      ) {
        const id = decodeURIComponent(path.split("/")[2] ?? "");
        const installed = packages[id];
        if (!installed || !check?.latest)
          return Promise.resolve(
            json(404, {
              error: { code: "package_not_installed", message: "Not found." },
            }),
          );
        packages[id] = {
          ...installed,
          version: check.latest.version,
          digest: check.latest.digest,
          hasRollback: true,
        };
        const listed = storeListings.find(
          (candidate) => candidate.packageId === id,
        );
        if (listed)
          listed.listing = {
            ...listed.listing,
            version: check.latest.version,
            installedVersion: check.latest.version,
            updateAvailable: false,
          };
        const bound = storeCustoms.find(
          (candidate) => candidate.packageId === id,
        );
        if (bound)
          bound.custom = {
            ...bound.custom,
            version: check.latest.version,
            installedVersion: check.latest.version,
          };
        return Promise.resolve(
          json(200, { data: { package: packages[id], updated: true } }),
        );
      }
      if (
        request.method === "POST" &&
        path.startsWith("/packages/") &&
        path.endsWith("/rollback")
      ) {
        const id = decodeURIComponent(path.split("/")[2] ?? "");
        const installed = packages[id];
        if (!installed)
          return Promise.resolve(
            json(404, {
              error: { code: "package_not_installed", message: "Not found." },
            }),
          );
        packages[id] = { ...installed, hasRollback: false };
        return Promise.resolve(json(200, { data: packages[id] }));
      }
      if (request.method === "DELETE") return Promise.resolve(json(204, {}));
      if (path === "/plugins")
        return Promise.resolve(
          json(200, {
            data: { items: catalog, unsupportedInstallations: unsupported },
          }),
        );
      if (
        request.method === "POST" &&
        path === "/plugin-store/marketplace/refresh"
      ) {
        // A successful refresh clears the stale flag and the last error,
        // as the server's cache row does.
        marketplaceStatus = {
          stale: false,
          lastFetchedAt: new Date().toISOString(),
        };
        return Promise.resolve(
          json(200, { data: { marketplace: marketplaceStatus } }),
        );
      }
      if (path === "/plugin-store")
        return Promise.resolve(
          json(200, {
            data: {
              items: [
                ...catalog.map(storeEntry),
                ...storeListings.map(({ packageId, listing }) =>
                  storeMarketplaceEntry(packageId, listing),
                ),
                ...storeCustoms.map(({ packageId, custom, repository }) =>
                  storeCustomEntry(packageId, custom, repository),
                ),
              ],
              marketplace: marketplaceStatus,
              unsupportedInstallations: unsupported,
            },
          }),
        );
      if (path.startsWith("/plugin-store/")) {
        const id = decodeURIComponent(path.split("/")[2] ?? "");
        const item = catalog.find((plugin) => plugin.id === id);
        if (item) return Promise.resolve(json(200, { data: storeEntry(item) }));
        const listed = storeListings.find(
          (candidate) => candidate.packageId === id,
        );
        if (listed)
          return Promise.resolve(
            json(200, {
              data: storeMarketplaceEntry(listed.packageId, listed.listing),
            }),
          );
        const bound = storeCustoms.find(
          (candidate) => candidate.packageId === id,
        );
        if (bound)
          return Promise.resolve(
            json(200, {
              data: storeCustomEntry(
                bound.packageId,
                bound.custom,
                bound.repository,
              ),
            }),
          );
        return Promise.resolve(
          json(404, {
            error: { code: "plugin_not_found", message: "Not found." },
          }),
        );
      }
      return Promise.resolve(json(200, { data: { items: [], total: 0 } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function LocationValue() {
  const location = useLocation();
  return (
    <output aria-label="Current route">
      {location.pathname}
      {location.search}
    </output>
  );
}

function renderAt(path: string, routes: ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>{routes}</Routes>
        <LocationValue />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderPlugins(path = "/plugins") {
  return renderAt(
    path,
    <>
      <Route path="/plugins" element={<PluginsPage />} />
      <Route path="/plugins/:page" element={<p>Management page</p>} />
    </>,
  );
}

function renderStore(path = "/plugins/store") {
  return renderAt(
    path,
    <>
      <Route path="/plugins" element={<PluginsPage />} />
      <Route path="/plugins/store" element={<PluginStorePage />} />
      <Route path="/plugins/store/:id" element={<PluginStoreDetailPage />} />
      <Route path="/plugins/:page" element={<p>Management page</p>} />
    </>,
  );
}

describe("Installed plugins list", () => {
  it("shows only installed plugins with their status", async () => {
    renderPlugins();
    expect(await screen.findByText("Forms")).toBeVisible();
    expect(screen.getByText("Transit Alerts")).toBeVisible();
    expect(screen.queryByText("Countdown Bar")).toBeNull();
    expect(screen.getByText("2 forms")).toBeVisible();
    expect(screen.getByText("Active")).toBeVisible();
    expect(screen.getByText("Needs setup")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Forms" })).toHaveAttribute(
      "href",
      "/plugins/forms",
    );
  });

  it("tells retired plugins apart from plugins of a newer release", async () => {
    unsupported = [
      {
        pluginId: "noise_meter",
        installedAt: "2026-01-01T00:00:00Z",
        retired: true,
      },
      {
        pluginId: "brand_bug",
        installedAt: "2026-01-01T00:00:00Z",
        retired: true,
      },
      { pluginId: "some_future_plugin", installedAt: "2026-01-01T00:00:00Z" },
    ];
    renderPlugins();
    expect(
      await screen.findByText("Plugins removed from Tilecast"),
    ).toBeVisible();
    expect(
      screen.getByText(
        "noise_meter, brand_bug are recorded as installed but were removed from Tilecast. They no longer run, and their data is kept.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("Plugins from a newer Tilecast release"),
    ).toBeVisible();
    expect(
      screen.getByText(/some_future_plugin is recorded as installed/),
    ).toBeVisible();
  });

  it("uses an empty state when nothing is installed", async () => {
    catalog = catalog.map((item) => ({ ...item, installed: false }));
    renderPlugins();
    expect(await screen.findByText("No plugins installed")).toBeVisible();
    expect(screen.getByRole("link", { name: "Add plugin" })).toHaveAttribute(
      "href",
      "/plugins/store",
    );
  });

  it("renders only the load error when the catalog query fails", async () => {
    override = () => json(500, { error: "offline" });
    renderPlugins();
    expect(
      await screen.findByText("Plugins could not be loaded."),
    ).toBeVisible();
    expect(
      screen.queryByRole("list", { name: "Installed plugins" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("No plugins installed")).not.toBeInTheDocument();
  });

  it("falls back to a generic icon for an icon Studio does not know", async () => {
    catalog = [
      catalogPlugin({
        id: "future_plugin",
        name: "Future Plugin",
        icon: "hologram",
        managementPath: "/plugins/future",
        installed: true,
      }),
    ];
    renderPlugins();
    expect(await screen.findByText("Future Plugin")).toBeVisible();
    // A route this bundle does not have is described, not linked.
    expect(
      screen.queryByRole("link", { name: "Open Future Plugin" }),
    ).toBeNull();
  });
});

describe("Plugin store", () => {
  it("explores all plugins with installed state, search, and category filters", async () => {
    const user = userEvent.setup();
    renderStore();
    expect(await screen.findByText("Countdown Bar")).toBeVisible();
    expect(screen.getByText("Emergency Alerts")).toBeVisible();
    expect(screen.getByText("Transit Alerts")).toBeVisible();
    expect(screen.getAllByText("Installed")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Automation" }));
    expect(screen.getByText("Emergency Alerts")).toBeVisible();
    expect(screen.getByText("Transit Alerts")).toBeVisible();
    expect(screen.queryByText("Countdown Bar")).toBeNull();

    await user.click(screen.getByRole("button", { name: "All" }));
    await user.clear(screen.getByRole("textbox", { name: "Search plugins" }));
    await user.type(
      screen.getByRole("textbox", { name: "Search plugins" }),
      "transit",
    );
    expect(screen.getByText("Transit Alerts")).toBeVisible();
    expect(screen.getByText("Installed")).toBeVisible();
    expect(screen.queryByText("Countdown Bar")).toBeNull();
  });

  it("links each entry to its detail page", async () => {
    const user = userEvent.setup();
    renderStore();
    await user.click(
      await screen.findByRole("link", { name: /Emergency Alerts/ }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Current route")).toHaveTextContent(
        "/plugins/store/emergency_alerts",
      ),
    );
    expect(await screen.findByText("Requirements")).toBeVisible();
  });

  it("shows requirements before installing and opens the management page after", async () => {
    const user = userEvent.setup();
    renderStore("/plugins/store/emergency_alerts");
    expect(await screen.findByText("Requirements")).toBeVisible();
    expect(screen.getByText("United States")).toBeVisible();
    expect(
      screen.getByText("Internet access from Tilecast Server"),
    ).toBeVisible();
    expect(screen.getByText("Included with Tilecast")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Current route")).toHaveTextContent(
        "/plugins/emergency-alerts",
      ),
    );
    expect(calls).toContainEqual({
      method: "POST",
      path: "/plugins/emergency_alerts/install",
    });
  });

  it("explains an unknown store entry instead of installing", async () => {
    renderStore("/plugins/store/no_such_plugin");
    expect(await screen.findByText("Plugin not found")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("shows a load error instead of not-found for a failed store request", async () => {
    override = () =>
      json(500, { error: { code: "internal_error", message: "Offline." } });
    renderStore("/plugins/store/emergency_alerts");
    expect(
      await screen.findByText("This plugin could not be loaded."),
    ).toBeVisible();
    expect(screen.queryByText("Plugin not found")).toBeNull();
  });

  it("redirects legacy ?add= addresses to the store", async () => {
    renderStore("/plugins?add=emergency_alerts");
    await waitFor(() =>
      expect(screen.getByLabelText("Current route")).toHaveTextContent(
        "/plugins/store/emergency_alerts",
      ),
    );
    expect(await screen.findByText("Requirements")).toBeVisible();
  });

  it("redirects a bare ?add= to Explore", async () => {
    renderStore("/plugins?add=1");
    await waitFor(() =>
      expect(screen.getByLabelText("Current route")).toHaveTextContent(
        "/plugins/store",
      ),
    );
    expect(await screen.findByText("Explore plugins")).toBeVisible();
  });

  it("does not offer Install to someone who cannot install", async () => {
    auth.role = "editor";
    renderStore("/plugins/store/countdown_bar");
    expect(
      await screen.findByText("An Owner or Administrator can install plugins."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("filters by name, description, category, and source", () => {
    const entries = catalog.map(storeEntry);
    expect(
      filterStoreEntries(entries, "", "All").map((entry) => entry.packageId),
    ).toEqual([
      "forms",
      "transit_alerts",
      "countdown_bar",
      "emergency_alerts",
      "lobby_signs",
    ]);
    expect(
      filterStoreEntries(entries, "", "Display").map(
        (entry) => entry.packageId,
      ),
    ).toEqual(["countdown_bar", "lobby_signs"]);
    expect(
      filterStoreEntries(entries, "weather", "All").map(
        (entry) => entry.packageId,
      ),
    ).toEqual(["emergency_alerts"]);
    expect(
      filterStoreEntries(entries, "", "All", "included").map(
        (entry) => entry.packageId,
      ),
    ).toEqual([
      "forms",
      "transit_alerts",
      "countdown_bar",
      "emergency_alerts",
      "lobby_signs",
    ]);
    expect(filterStoreEntries(entries, "", "All", "marketplace")).toEqual([]);
  });
});

describe("Marketplace", () => {
  const weatherEntry: PluginStoreEntry = {
    packageId: "acme.weather",
    source: { kind: "marketplace", catalogId: "tilecast-marketplace" },
    marketplace: marketplaceListing({
      name: "Weather",
      categories: ["data"],
      featured: true,
    }),
  };

  function serveMarketplace(marketplace: unknown) {
    override = (request) => {
      if (
        request.method === "POST" &&
        request.path === "/plugin-store/marketplace/refresh"
      ) {
        return json(200, { data: { marketplace: { stale: false } } });
      }
      if (request.method === "GET" && request.path === "/plugin-store") {
        return json(200, {
          data: {
            items: [...catalog.map(storeEntry), weatherEntry],
            unsupportedInstallations: [],
            marketplace,
          },
        });
      }
      if (request.path === "/plugin-store/acme.weather") {
        return json(200, { data: weatherEntry });
      }
      return json(200, { data: { items: [], total: 0 } });
    };
  }

  it("lists marketplace entries beside included plugins without any setup state", async () => {
    serveMarketplace({ stale: false });
    renderStore();
    // The featured listing appears in the carousel and in the full grid.
    expect((await screen.findAllByText("Weather"))[0]).toBeVisible();
    expect(screen.getByText("Countdown Bar")).toBeVisible();
    expect(screen.queryByText("Marketplace couldn't be refreshed")).toBeNull();
    expect(screen.queryByText(/not configured/i)).toBeNull();
  });

  it("shows marketplace presentation metadata on the detail page", async () => {
    serveMarketplace({ stale: false });
    renderStore("/plugins/store/acme.weather");
    expect(await screen.findByText("Weather")).toBeVisible();
    expect(screen.getAllByText("Acme").length).toBeGreaterThan(0);
    // Featured is an Explore cue; the page itself is already the destination.
    expect(screen.queryByText("Featured")).toBeNull();
    expect(screen.getByText("data")).toBeVisible();
    expect(
      screen.getByText("Listed in the official Tilecast Marketplace."),
    ).toBeVisible();
  });

  it("explains a failed refresh while installed packages keep working", async () => {
    serveMarketplace({
      stale: true,
      error: "The marketplace catalog could not be refreshed.",
    });
    renderStore();
    expect(
      await screen.findByText("Marketplace couldn't be refreshed"),
    ).toBeVisible();
    expect(
      screen.getByText("The marketplace catalog could not be refreshed."),
    ).toBeVisible();
    // Installed entries still render beside the notice.
    expect(screen.getByText("Countdown Bar")).toBeVisible();
    expect(screen.getAllByText("Weather")[0]).toBeVisible();
  });

  it("lets managers refresh the catalog but not viewers", async () => {
    serveMarketplace({
      stale: true,
      error: "The marketplace catalog could not be refreshed.",
    });
    const user = userEvent.setup();
    renderStore();
    const refresh = await screen.findByRole("button", {
      name: "Refresh catalog",
    });
    await user.click(refresh);
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/plugin-store/marketplace/refresh",
      }),
    );

    cleanup();
    auth.role = "viewer";
    renderStore();
    expect(
      await screen.findByText("Marketplace couldn't be refreshed"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Refresh catalog" }),
    ).toBeNull();
  });

  it("filters marketplace entries by source and category text", () => {
    const entries = [weatherEntry];
    expect(
      filterStoreEntries(entries, "", "All", "marketplace").map(
        (entry) => entry.packageId,
      ),
    ).toEqual(["acme.weather"]);
    expect(filterStoreEntries(entries, "", "All", "included")).toEqual([]);
    expect(
      filterStoreEntries(entries, "data", "All").map(
        (entry) => entry.packageId,
      ),
    ).toEqual(["acme.weather"]);
  });
});

describe("Marketplace store", () => {
  beforeEach(() => {
    marketplaceStatus = { stale: false };
    storeListings = [
      { packageId: "acme.weather", listing: marketplaceListing() },
      {
        packageId: "acme.countdown-pro",
        listing: marketplaceListing({
          // i18n-ignore: development fixture label, not Studio copy
          name: "Countdown Pro",
          // i18n-ignore: development fixture label, not Studio copy
          description: "A bigger countdown.",
          version: "2.0.0",
          installed: true,
          installedVersion: "1.0.0",
          updateAvailable: true,
        }),
      },
      {
        packageId: "acme.future",
        listing: marketplaceListing({
          name: "Future Thing",
          compatible: false,
          tilecastRange: ">=99.0.0",
        }),
      },
    ];
  });

  function marketplaceEntries() {
    return [
      ...catalog.map(storeEntry),
      ...storeListings.map(({ packageId, listing }) =>
        storeMarketplaceEntry(packageId, listing),
      ),
    ];
  }

  it("filters marketplace entries by source, category, and publisher search", () => {
    const entries = marketplaceEntries();
    const ids = (list: typeof entries) => list.map((entry) => entry.packageId);
    // Listings carry no category, so a category filter shows included
    // plugins only.
    expect(ids(filterStoreEntries(entries, "", "Display"))).toEqual([
      "countdown_bar",
      "lobby_signs",
    ]);
    // Installed listings stay in the default list, marked installed.
    expect(ids(filterStoreEntries(entries, "", "All", "marketplace"))).toEqual([
      "acme.weather",
      "acme.countdown-pro",
      "acme.future",
    ]);
    // Publisher search matches listings, installed or not.
    expect(ids(filterStoreEntries(entries, "acme", "All"))).toEqual([
      "acme.weather",
      "acme.countdown-pro",
      "acme.future",
    ]);
    expect(ids(filterStoreEntries(entries, "weather", "All"))).toEqual([
      "emergency_alerts",
      "acme.weather",
    ]);
  });

  it("lists marketplace entries with publisher and provenance", async () => {
    renderStore();
    expect(await screen.findByText("Weather")).toBeVisible();
    expect(screen.getByText("Future Thing")).toBeVisible();
    // An installed listing stays in the default list, marked installed.
    expect(screen.getByText("Countdown Pro")).toBeVisible();
    expect(screen.getAllByText("Marketplace")[0]).toBeVisible();
    expect(screen.getAllByText(/Acme/)[0]).toBeVisible();
    // Version, digest, and requirements belong to the detail page.
    expect(screen.queryByText(/Version 1\.0\.0/)).toBeNull();
  });

  it("marks installed marketplace listings with their update state on search", async () => {
    const user = userEvent.setup();
    renderStore();
    await screen.findByText("Weather");
    await user.type(
      screen.getByRole("textbox", { name: "Search plugins" }),
      "countdown",
    );
    expect(screen.getByText("Countdown Pro")).toBeVisible();
    expect(screen.getAllByText("Installed").length).toBeGreaterThan(0);
    expect(screen.getByText("Update available")).toBeVisible();
  });

  it("shows the listing overview with links and install state on its detail page", async () => {
    const user = userEvent.setup();
    renderStore();
    await user.click(await screen.findByRole("link", { name: /Weather/ }));
    await waitFor(() =>
      expect(screen.getByLabelText("Current route")).toHaveTextContent(
        "/plugins/store/acme.weather",
      ),
    );
    expect(
      await screen.findByText("Listed in the official Tilecast Marketplace."),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Repository" })).toHaveAttribute(
      "href",
      "https://github.com/acme/tilecast-weather",
    );
    expect(screen.getByRole("link", { name: "Documentation" })).toHaveAttribute(
      "href",
      "https://example.com/acme/weather/docs",
    );
    expect(screen.getByText("MIT")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Review & install" }),
    ).toBeVisible();
  });

  it("reviews a marketplace listing before installing it", async () => {
    const user = userEvent.setup();
    renderStore("/plugins/store/acme.weather");
    await user.click(
      await screen.findByRole("button", { name: "Review & install" }),
    );
    // The review shows the published manifest: release, provenance,
    // contributions, and the catalog update plane.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Release")).toBeVisible();
    expect(within(dialog).getByText("Lobby")).toBeVisible();
    expect(
      within(dialog).getByText(
        "The Marketplace listing stays the update plane, so update checks re-read it.",
      ),
    ).toBeVisible();
    expect(calls.filter((call) => call.path.endsWith("/install"))).toHaveLength(
      0,
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Install plugin" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      await screen.findByRole("heading", { name: "Danger zone" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Check for updates" }),
    ).toBeVisible();
    // Installed packages show status, never a dead Install button.
    expect(
      screen.queryByRole("button", { name: "Review & install" }),
    ).toBeNull();
  });

  it("explains a failed marketplace review without installing", async () => {
    const user = userEvent.setup();
    marketplaceResolveError = {
      status: 422,
      code: "package_unsigned",
      message: "The package has no verifying provenance.",
    };
    renderStore("/plugins/store/acme.weather");
    await user.click(
      await screen.findByRole("button", { name: "Review & install" }),
    );
    expect(
      await screen.findByText("The package has no verifying provenance."),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.filter((call) => call.path.endsWith("/install"))).toHaveLength(
      0,
    );
  });

  it("cancels a marketplace review without installing", async () => {
    const user = userEvent.setup();
    renderStore("/plugins/store/acme.weather");
    await user.click(
      await screen.findByRole("button", { name: "Review & install" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Release")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((call) => call.path.endsWith("/install"))).toHaveLength(
      0,
    );
  });

  it("explains incompatible listings and disables the action", async () => {
    renderStore("/plugins/store/acme.future");
    expect(
      await screen.findByText("Not compatible with this Tilecast version"),
    ).toBeVisible();
    expect(
      screen.getByText("This plugin requires Tilecast >=99.0.0."),
    ).toBeVisible();
    const action = screen.getByRole("button", { name: "Review & install" });
    expect(action).toBeDisabled();
    expect(action).toHaveAccessibleDescription(
      /Not compatible with this Tilecast version/,
    );
  });

  it("offers refresh while the catalog is stale and clears the banner after", async () => {
    const user = userEvent.setup();
    marketplaceStatus = { stale: true };
    renderStore();
    expect(
      await screen.findByText("Marketplace catalog may be out of date"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh catalog" }));
    expect(
      calls.some(
        (call) =>
          call.method === "POST" &&
          call.path === "/plugin-store/marketplace/refresh",
      ),
    ).toBe(true);
    await waitFor(() =>
      expect(
        screen.queryByText("Marketplace catalog may be out of date"),
      ).toBeNull(),
    );
  });

  it("shows the refresh error and hides refresh from viewers", async () => {
    auth.role = "viewer";
    marketplaceStatus = {
      stale: true,
      error: "fetch answered HTTP 500",
    };
    renderStore();
    expect(
      await screen.findByText("Marketplace couldn't be refreshed"),
    ).toBeVisible();
    expect(screen.getByText("fetch answered HTTP 500")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Refresh catalog" }),
    ).toBeNull();
  });
});

describe("Custom repositories", () => {
  beforeEach(() => {
    storeCustoms = [
      {
        packageId: "acme.kiosk",
        custom: customPackage(),
        repository: "https://github.com/acme/tilecast-kiosk",
      },
    ];
    review = installReview();
  });

  function customEntries() {
    return [
      ...catalog.map(storeEntry),
      ...storeCustoms.map(({ packageId, custom, repository }) =>
        storeCustomEntry(packageId, custom, repository),
      ),
    ];
  }

  it("filters custom entries by source, category, and publisher search", () => {
    const entries = customEntries();
    const ids = (list: typeof entries) => list.map((entry) => entry.packageId);
    // Custom entries carry no category, so a category filter shows
    // included plugins only.
    expect(ids(filterStoreEntries(entries, "", "Display"))).toEqual([
      "countdown_bar",
      "lobby_signs",
    ]);
    expect(ids(filterStoreEntries(entries, "", "All", "custom"))).toEqual([
      "acme.kiosk",
    ]);
    expect(ids(filterStoreEntries(entries, "acme", "All"))).toEqual([
      "acme.kiosk",
    ]);
    const bound = storeCustoms[0];
    if (!bound) throw new Error("custom fixture missing");
    bound.custom = { ...bound.custom, installed: true };
    // Installed customs stay in the default list, marked installed.
    expect(ids(filterStoreEntries(customEntries(), "", "All"))).toContain(
      "acme.kiosk",
    );
  });

  it("lists custom entries with publisher and provenance", async () => {
    renderStore();
    const link = await screen.findByRole("link", { name: "Lobby Kiosk" });
    const card = link.closest("[data-slot='card']") as HTMLElement;
    expect(card).toHaveTextContent("Acme");
    expect(card).toHaveTextContent("Custom");
    expect(card).not.toHaveTextContent("Version 1.2.0");
  });

  it("adds a repository through lookup, review, and install", async () => {
    const user = userEvent.setup();
    storeCustoms = [];
    renderStore();
    await user.click(
      await screen.findByRole("button", { name: "Add from GitHub" }),
    );
    await user.type(
      await screen.findByLabelText("Repository URL"),
      "https://github.com/acme/tilecast-kiosk",
    );
    await user.click(screen.getByRole("button", { name: "Look up" }));
    expect(await screen.findByText("Release")).toBeVisible();
    expect(screen.getByText(/v1\.2\.0/)).toBeVisible();
    expect(
      screen.getByText("Signed by https://github.com/acme/tilecast-kiosk"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Install package" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Current route")).toHaveTextContent(
        "/plugins/store/acme.kiosk",
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "Danger zone" }),
    ).toBeVisible();
  });

  it("explains a lookup failure without closing the dialog", async () => {
    const user = userEvent.setup();
    review = undefined;
    renderStore();
    await user.click(
      await screen.findByRole("button", { name: "Add from GitHub" }),
    );
    await user.type(
      await screen.findByLabelText("Repository URL"),
      "https://github.com/acme/no-such-repo",
    );
    await user.click(screen.getByRole("button", { name: "Look up" }));
    expect(await screen.findByText("Not found.")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Install package" }),
    ).toBeDisabled();
  });

  it("does not offer adding to someone who cannot install", async () => {
    auth.role = "viewer";
    renderStore();
    await screen.findByRole("link", { name: /Lobby Kiosk/ });
    expect(
      screen.queryByRole("button", { name: "Add from GitHub" }),
    ).toBeNull();
  });

  it("shows the custom entry with its repository and install state", async () => {
    renderStore("/plugins/store/acme.kiosk");
    expect(
      await screen.findByText(
        "Added from a repository you chose. Tilecast verifies its release provenance before installing.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Repository" })).toHaveAttribute(
      "href",
      "https://github.com/acme/tilecast-kiosk",
    );
    expect(screen.getByRole("button", { name: "Install" })).toBeVisible();
  });

  it("explains incompatible custom entries and disables the action", async () => {
    const bound = storeCustoms[0];
    if (!bound) throw new Error("custom fixture missing");
    bound.custom = customPackage({
      compatible: false,
      tilecastRange: ">=99.0.0",
    });
    renderStore("/plugins/store/acme.kiosk");
    expect(
      await screen.findByText("This plugin requires Tilecast >=99.0.0."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
  });
});

describe("Package management", () => {
  beforeEach(() => {
    storeCustoms = [
      {
        packageId: "acme.kiosk",
        custom: customPackage({ installed: true, installedVersion: "1.2.0" }),
        repository: "https://github.com/acme/tilecast-kiosk",
      },
    ];
    packages["acme.kiosk"] = installedPackage();
  });

  it("lists installed packages on the Installed tab", async () => {
    renderPlugins();
    const section = await screen.findByRole("region", {
      name: "Extension packages",
    });
    expect(section).toHaveTextContent("Lobby Kiosk");
    expect(section).toHaveTextContent("Version 1.2.0");
    expect(section).toHaveTextContent("Custom");
  });

  it("checks for updates and applies the checked digest", async () => {
    const user = userEvent.setup();
    check = updateCheck({
      installed: installedPackage(),
      available: true,
      upToDate: false,
      latest: installReview({
        version: "1.3.0",
        releaseTag: "v1.3.0",
        // i18n-ignore: test fixture value, not Studio copy
        digest:
          "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      }),
    });
    renderStore("/plugins/store/acme.kiosk");
    await user.click(
      await screen.findByRole("button", { name: "Check for updates" }),
    );
    // A found update is reviewed in a dialog, never applied inline.
    await user.click(
      await screen.findByRole("button", { name: "Review update" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Update to 1.3.0" }),
    );
    await waitFor(() => expect(packages["acme.kiosk"]?.version).toBe("1.3.0"));
    expect(packages["acme.kiosk"]?.hasRollback).toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says when the package is up to date", async () => {
    const user = userEvent.setup();
    check = updateCheck({ installed: installedPackage() });
    renderStore("/plugins/store/acme.kiosk");
    await user.click(
      await screen.findByRole("button", { name: "Check for updates" }),
    );
    expect(await screen.findByText("Up to date · 1.2.0")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Review update" })).toBeNull();
  });

  it("restores the previous activation when one exists", async () => {
    const user = userEvent.setup();
    packages["acme.kiosk"] = installedPackage({ hasRollback: true });
    renderStore("/plugins/store/acme.kiosk");
    await user.click(
      await screen.findByRole("button", { name: "Restore previous version" }),
    );
    // Restoring asks first.
    const dialog = await screen.findByRole("alertdialog");
    expect(
      calls.filter((call) => call.path.endsWith("/rollback")),
    ).toHaveLength(0);
    await user.click(
      within(dialog).getByRole("button", { name: "Restore previous version" }),
    );
    await waitFor(() =>
      expect(packages["acme.kiosk"]?.hasRollback).toBe(false),
    );
  });

  it("hides rollback without a previous activation", async () => {
    renderStore("/plugins/store/acme.kiosk");
    await screen.findByRole("button", { name: "Check for updates" });
    expect(
      screen.queryByRole("button", { name: "Restore previous version" }),
    ).toBeNull();
  });

  it("removes the package after confirmation and returns to Explore", async () => {
    const user = userEvent.setup();
    renderStore("/plugins/store/acme.kiosk");
    await user.click(
      await screen.findByRole("button", { name: "Remove package" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Remove this package?")).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: "Remove package" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Current route")).toHaveTextContent(
        "/plugins/store",
      ),
    );
    expect(packages["acme.kiosk"]).toBeUndefined();
  });

  it("hides management actions from someone who cannot install", async () => {
    auth.role = "viewer";
    renderStore("/plugins/store/acme.kiosk");
    await screen.findByRole("region", { name: "Package status" });
    expect(
      screen.queryByRole("button", { name: "Check for updates" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove package" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Danger zone" })).toBeNull();
  });

  it("names the remaining content when removal is blocked", async () => {
    const user = userEvent.setup();
    renderStore("/plugins/store/acme.kiosk");
    const remove = await screen.findByRole("button", {
      name: "Remove package",
    });
    override = ({ method }) =>
      method === "DELETE"
        ? json(409, {
            error: {
              code: "package_in_use",
              message: "Lobby Kiosk cannot be removed while 1 Widget remains.",
              details: {
                packageId: "acme.kiosk",
                resources: [
                  {
                    kind: "widget",
                    count: 1,
                    label: "Widget",
                    resolution: "delete",
                  },
                ],
              },
            },
          })
        : json(500, { error: "offline" });
    await user.click(remove);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Remove package" }),
    );
    expect(
      await screen.findByText(
        "Lobby Kiosk cannot be removed while 1 Widget remains.",
      ),
    ).toBeVisible();
    expect(screen.getByText("1 Widget")).toBeVisible();
    expect(
      screen.getByText("Delete the remaining content, then try again."),
    ).toBeVisible();
  });

  it("shows what an update adds and drops", async () => {
    const user = userEvent.setup();
    check = updateCheck({
      installed: installedPackage(),
      available: true,
      upToDate: false,
      latest: installReview({
        version: "1.3.0",
        contributions: [
          { type: "widget", path: "concierge" },
          { type: "dataSource", path: "schedule" },
        ],
      }),
    });
    renderStore("/plugins/store/acme.kiosk");
    await user.click(
      await screen.findByRole("button", { name: "Check for updates" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Review update" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("New in this version"),
    ).toBeVisible();
    expect(within(dialog).getByText("Concierge")).toBeVisible();
    expect(within(dialog).getByText("Removed in this version")).toBeVisible();
    expect(within(dialog).getByText("Lobby")).toBeVisible();
    expect(
      within(dialog).getByText(
        "Updating deletes nothing: if anything still uses a removed contribution, the update waits until you delete it.",
      ),
    ).toBeVisible();
  });
});

describe("Contribution diffs", () => {
  it("matches kinds and paths with ./ normalization", () => {
    const { added, removed } = diffContributions(
      [
        { kind: "widget", path: "./widgets/lobby" },
        { kind: "dataSource", path: "./data-sources/schedule" },
      ],
      [
        { type: "widget", path: "widgets/lobby" },
        { type: "widget", path: "./widgets/concierge" },
      ],
    );
    expect(added).toEqual([{ kind: "widget", path: "./widgets/concierge" }]);
    expect(removed).toEqual([
      { kind: "dataSource", path: "./data-sources/schedule" },
    ]);
  });

  it("reports a changed qualified ID even when the path stays put", () => {
    const { added, removed } = diffContributions(
      [{ kind: "widget", path: "./widgets/lobby", id: "acme.lobby" }],
      [{ type: "widget", path: "./widgets/lobby", id: "acme.lobby_v2" }],
    );
    expect(added).toEqual([
      { kind: "widget", path: "./widgets/lobby", id: "acme.lobby_v2" },
    ]);
    expect(removed).toEqual([
      { kind: "widget", path: "./widgets/lobby", id: "acme.lobby" },
    ]);
  });

  it("compares by path alone when the review carries no ID", () => {
    const { added, removed } = diffContributions(
      [{ kind: "widget", path: "./widgets/lobby", id: "acme.lobby" }],
      [{ type: "widget", path: "./widgets/lobby" }],
    );
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("reports nothing when contributions match", () => {
    const { added, removed } = diffContributions(
      [{ kind: "widget", path: "lobby" }],
      [{ type: "widget", path: "./lobby" }],
    );
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });
});

describe("Plugin route gate", () => {
  const gated = (
    <Route
      path="/plugins/countdown-bar"
      element={
        <PluginRouteGate pluginId="countdown_bar">
          <p>Countdown management</p>
        </PluginRouteGate>
      }
    />
  );

  it("offers installation instead of an uninstalled plugin's page", async () => {
    const user = userEvent.setup();
    renderAt("/plugins/countdown-bar", gated);
    expect(
      await screen.findByText("Countdown Bar isn't installed"),
    ).toBeVisible();
    expect(screen.queryByText("Countdown management")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Install Countdown Bar" }),
    );
    expect(await screen.findByText("Countdown management")).toBeVisible();
  });

  it("explains without an install action for someone who cannot install", async () => {
    auth.role = "viewer";
    renderAt("/plugins/countdown-bar", gated);
    expect(
      await screen.findByText("Countdown Bar isn't installed"),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Install/ })).toBeNull();
  });
});

describe("Remove plugin", () => {
  function renderMenu() {
    return renderAt(
      "/plugins/forms",
      <>
        <Route
          path="/plugins/forms"
          element={<PluginActionsMenu pluginId="forms" />}
        />
        <Route path="/plugins" element={<p>Plugins list</p>} />
      </>,
    );
  }

  async function openRemove() {
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Forms plugin actions" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove plugin" }),
    );
    return user;
  }

  it("removes an empty plugin and returns to Plugins", async () => {
    renderMenu();
    const user = await openRemove();
    await user.click(
      await screen.findByRole("button", { name: "Remove plugin" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Current route")).toHaveTextContent(
        /^\/plugins$/,
      ),
    );
    expect(calls).toContainEqual({
      method: "DELETE",
      path: "/plugins/forms/installation",
    });
  });

  it("explains what still uses the plugin when removal is blocked", async () => {
    renderMenu();
    const user = await openRemove();
    override = ({ method, path }) =>
      method === "DELETE"
        ? json(409, {
            error: {
              code: "plugin_in_use",
              message: "Forms cannot be removed while 2 forms remain.",
              details: {
                pluginId: "forms",
                resources: [
                  {
                    kind: "form",
                    count: 2,
                    label: "forms",
                    resolution: "delete",
                  },
                ],
              },
            },
          })
        : path === "/plugins"
          ? json(200, {
              data: { items: catalog, unsupportedInstallations: [] },
            })
          : json(200, { data: {} });
    await user.click(
      await screen.findByRole("button", { name: "Remove plugin" }),
    );
    expect(await screen.findByText("Forms can't be removed")).toBeVisible();
    expect(
      screen.getByText(
        /2 forms still use this plugin\. Delete the remaining forms/,
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "View forms" }));
    await waitFor(() =>
      expect(screen.queryByText("Forms can't be removed")).toBeNull(),
    );
  });

  it("is not offered to someone who cannot manage plugins", async () => {
    auth.role = "editor";
    renderMenu();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(
      screen.queryByRole("button", { name: "Forms plugin actions" }),
    ).toBeNull();
  });

  it("gives steps that match how each blocker resolves", () => {
    const t = i18n.getFixedT("en", "plugins");
    expect(
      blockerInstruction(t, [
        {
          kind: "alert_monitor",
          count: 1,
          label: "enabled monitor",
          resolution: "disable",
        },
        {
          kind: "alert_rule",
          count: 2,
          label: "alert rules",
          resolution: "delete",
        },
        {
          kind: "alert_activation",
          count: 1,
          label: "active alert",
          resolution: "wait",
        },
      ]),
    ).toBe(
      "Turn off the enabled monitor and delete the remaining alert rules on this page, then remove the plugin.",
    );
    expect(
      blockerInstruction(t, [
        {
          kind: "alert_activation",
          count: 1,
          label: "active alert",
          resolution: "wait",
        },
      ]),
    ).toBe("Wait for the active alert to clear, then remove the plugin.");
  });
});

describe("Plugin navigation", () => {
  it("redirects the old Dependency Graph address to Settings", () => {
    const plugins = studioRoutes
      .flatMap((route) => route.children ?? [])
      .find((route) => route.path === "plugins");
    const legacy = plugins?.children?.find(
      (route) => route.path === "dependency-graph",
    );
    expect(isValidElement(legacy?.element)).toBe(true);
    expect((legacy?.element as { props: { to: string } }).props.to).toBe(
      "/settings/dependency-graph",
    );
  });

  it("distinguishes installed and uninstalled plugins in global search", () => {
    const results = buildCommandResults(
      studioRoutes,
      [],
      "forms",
      undefined,
      catalog,
      i18n.getFixedT("en", "navigation"),
    );
    const forms = results.find((result) => result.id === "plugin:forms");
    expect(forms).toMatchObject({
      description: "Plugin",
      to: "/plugins/forms",
    });
    const countdown = buildCommandResults(
      studioRoutes,
      [],
      "countdown",
      undefined,
      catalog,
      i18n.getFixedT("en", "navigation"),
    ).find((result) => result.id === "plugin:countdown_bar");
    expect(countdown).toMatchObject({
      description: "Plugin · Not installed",
      to: "/plugins/store/countdown_bar",
    });
  });
});

describe("Explore card grid", () => {
  const artworkPath = "/api/v1/plugin-store/acme.weather/artwork/icon?v=abc123";

  function serveStore(listings: PluginStoreMarketplace[]) {
    const items = [
      ...catalog.map(storeEntry),
      ...listings.map((listing, index) =>
        storeMarketplaceEntry(`acme.listing-${index}`, listing),
      ),
    ];
    override = (request) => {
      if (request.method === "GET" && request.path === "/plugin-store") {
        return json(200, {
          data: {
            items,
            unsupportedInstallations: [],
            marketplace: { stale: false },
          },
        });
      }
      return json(200, { data: { items: [], total: 0 } });
    };
  }

  const featuredListing = (name: string, extra = {}) =>
    marketplaceListing({
      name,
      categories: ["data"],
      featured: true,
      ...extra,
    });

  it("renders every entry as a card in a responsive grid", async () => {
    serveStore([marketplaceListing({ name: "Weather" })]);
    renderStore();
    expect(await screen.findByText("Weather")).toBeVisible();

    const list = screen.getByRole("list");
    // One column by default, two when medium, three when wide, measured on
    // the space the page leaves the grid rather than on the viewport.
    expect(list).toHaveClass("grid", "@lg:grid-cols-2", "@4xl:grid-cols-3");
    expect(list.className).not.toMatch(/(^|\s)grid-cols-/);
    expect(list.parentElement?.parentElement).toHaveClass("@container");

    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(catalog.length + 1);
    for (const item of items) {
      expect(item.querySelector("[data-slot='card']")).not.toBeNull();
      expect(item.querySelector("[data-slot='item']")).toBeNull();
    }
  });

  it("leads with a Featured carousel built from featured listings", async () => {
    serveStore([
      featuredListing("Weather"),
      featuredListing("Scoreboard"),
      marketplaceListing({ name: "Quiet Listing" }),
    ]);
    renderStore();

    const region = await screen.findByRole("region", {
      name: "Featured plugins",
    });
    expect(region).toHaveAttribute("aria-roledescription", "carousel");
    expect(
      within(region).getByRole("heading", { name: "Featured" }),
    ).toBeVisible();
    expect(
      within(region).getByRole("button", { name: "Previous slide" }),
    ).toBeVisible();
    expect(
      within(region).getByRole("button", { name: "Next slide" }),
    ).toBeVisible();

    const slides = within(region).getAllByRole("group");
    expect(slides).toHaveLength(2);
    expect(slides[0]).toHaveClass(
      "basis-full",
      "@lg:basis-1/2",
      "@4xl:basis-1/3",
    );
    expect(
      slides.map((slide) =>
        slide.querySelector("[data-slot='card']")?.getAttribute("data-variant"),
      ),
    ).toEqual(["featured", "featured"]);
    expect(within(region).queryByText("Quiet Listing")).toBeNull();

    // The carousel never advances on its own.
    expect(region.querySelector("[data-autoplay]")).toBeNull();

    // The full grid below still lists everything, under its own heading.
    expect(screen.getByRole("heading", { name: "All plugins" })).toBeVisible();
    expect(
      within(screen.getByRole("list")).getByText("Quiet Listing"),
    ).toBeVisible();
  });

  it("shows no Featured section when nothing is featured", async () => {
    serveStore([marketplaceListing({ name: "Weather" })]);
    renderStore();
    await screen.findByText("Weather");
    expect(
      screen.queryByRole("region", { name: "Featured plugins" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "Featured" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "All plugins" })).toBeNull();
  });

  it("drops the Featured section once the person searches or narrows filters", async () => {
    const user = userEvent.setup();
    serveStore([
      featuredListing("Weather"),
      marketplaceListing({ name: "Quiet" }),
    ]);
    renderStore();
    const featured = () =>
      screen.queryByRole("region", { name: "Featured plugins" });
    expect(
      await screen.findByRole("region", { name: "Featured plugins" }),
    ).toBeVisible();

    // Searching.
    const search = screen.getByRole("textbox", { name: "Search plugins" });
    await user.type(search, "weather");
    await waitFor(() => expect(featured()).toBeNull());
    // Results are the filtered grid alone: the listing and the included
    // plugin whose description mentions weather, one card each.
    expect(
      within(screen.getByRole("list")).getAllByRole("listitem"),
    ).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "All plugins" })).toBeNull();

    // Clearing the search brings it back.
    await user.clear(search);
    expect(
      await screen.findByRole("region", { name: "Featured plugins" }),
    ).toBeVisible();

    // A whitespace-only search narrows nothing, so it keeps the section.
    await user.type(search, "   ");
    expect(featured()).not.toBeNull();
    await user.clear(search);

    // A category filter.
    await user.click(screen.getByRole("button", { name: "Display" }));
    await waitFor(() => expect(featured()).toBeNull());
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(
      await screen.findByRole("region", { name: "Featured plugins" }),
    ).toBeVisible();

    // A source filter.
    await user.click(screen.getByRole("combobox", { name: "Source" }));
    await user.click(
      await screen.findByRole("option", { name: "Marketplace" }),
    );
    await waitFor(() => expect(featured()).toBeNull());
    expect(screen.getAllByText("Weather").length).toBeGreaterThan(0);
  });

  it("filters the card grid by search, category, and source", async () => {
    const user = userEvent.setup();
    serveStore([marketplaceListing({ name: "Weather" })]);
    renderStore();
    await screen.findByText("Weather");
    const cards = () =>
      within(screen.getByRole("list")).getAllByRole("listitem");
    expect(cards()).toHaveLength(catalog.length + 1);

    await user.click(screen.getByRole("button", { name: "Automation" }));
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(screen.getByText("Transit Alerts")).toBeVisible();
    expect(screen.getByText("Emergency Alerts")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "All" }));

    await user.type(
      screen.getByRole("textbox", { name: "Search plugins" }),
      "zzz",
    );
    expect(await screen.findByText("No matching plugins")).toBeVisible();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows card-shaped placeholders while the store loads", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    renderStore();
    const status = screen.getByRole("status", { name: "Loading plugins" });
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveClass("grid", "@lg:grid-cols-2", "@4xl:grid-cols-3");
    const placeholders = status.querySelectorAll("[data-slot='card']");
    expect(placeholders).toHaveLength(6);
    for (const placeholder of placeholders) {
      expect(placeholder).toHaveAttribute("aria-hidden", "true");
      expect(
        placeholder.querySelector("[data-slot='card-footer']"),
      ).not.toBeNull();
    }
    expect(status.querySelector("[data-slot='item']")).toBeNull();
  });

  it("shows marketplace artwork, and falls back when it fails to load", async () => {
    serveStore([
      marketplaceListing({
        name: "Weather",
        artwork: { iconUrl: artworkPath },
      }),
      marketplaceListing({ name: "Plain" }),
    ]);
    renderStore();
    await screen.findByText("Weather");
    const weather = screen
      .getByRole("link", { name: "Weather" })
      .closest("[data-slot='card']") as HTMLElement;
    const image = weather.querySelector("img") as HTMLImageElement;
    expect(image.getAttribute("src")).toBe(artworkPath);
    // No page request ever targets an address the catalog named.
    for (const img of document.querySelectorAll("img")) {
      expect(img.getAttribute("src")?.startsWith("/api/v1/plugin-store/")).toBe(
        true,
      );
    }

    fireEvent.error(image);
    expect(weather.querySelector("img")).toBeNull();
    expect(weather.querySelector("svg.lucide-puzzle")).not.toBeNull();
    // The rest of the store is unaffected.
    expect(screen.getByRole("link", { name: "Plain" })).toBeVisible();
    expect(screen.getByText("Countdown Bar")).toBeVisible();
  });

  it("marks installed, updatable, and incompatible listings on their cards", async () => {
    serveStore([
      marketplaceListing({
        name: "Updatable",
        installed: true,
        installedVersion: "0.9.0",
        updateAvailable: true,
      }),
      marketplaceListing({ name: "Too New", compatible: false }),
    ]);
    renderStore();
    await screen.findByText("Updatable");
    const card = (name: string) =>
      screen
        .getByRole("link", { name })
        .closest("[data-slot='card']") as HTMLElement;
    expect(within(card("Updatable")).getByText("Installed")).toBeVisible();
    expect(
      within(card("Updatable")).getByText("Update available"),
    ).toBeVisible();
    expect(within(card("Too New")).getByText("Incompatible")).toBeVisible();
    expect(within(card("Too New")).queryByText("Installed")).toBeNull();
  });

  it("opens a plugin from the keyboard", async () => {
    const user = userEvent.setup();
    serveStore([]);
    renderStore();
    await screen.findByText("Countdown Bar");
    const link = screen.getByRole("link", { name: "Countdown Bar" });
    link.focus();
    expect(link).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Back to Explore")).toBeVisible();
  });

  it("gives each card one focus stop", async () => {
    serveStore([marketplaceListing({ name: "Weather" })]);
    renderStore();
    await screen.findByText("Weather");
    const list = screen.getByRole("list");
    for (const item of within(list).getAllByRole("listitem")) {
      expect(within(item).getAllByRole("link")).toHaveLength(1);
    }
  });
});

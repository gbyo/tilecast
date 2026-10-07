// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitHubInstallReview,
  InstalledPackage,
  PackageCapabilities,
  PackageJob,
  PackageUpdateCheck,
  PluginStoreEntry,
} from "../../api/types";
import { i18n } from "../../i18n";
import { PluginStoreDetailPage } from "../../pages/PluginStoreDetailPage";
import {
  catalogPlugin,
  customPackage,
  installReview,
  installedPackage,
  marketplaceListing,
  updateCheck,
} from "../catalogFixtures";

const auth = vi.hoisted(() => ({ role: "owner" }));
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      authenticated: true,
      csrfToken: "csrf",
      user: { id: "user", name: "User", role: auth.role },
    },
  }),
}));

const jobsStub = vi.hoisted(() =>
  vi.fn((): Promise<PackageJob[]> => Promise.resolve([])),
);
vi.mock("../../api/domains/fleet", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../api/domains/fleet")>();
  return { ...mod, listPackageJobs: jobsStub };
});

type Call = { method: string; path: string };

let entries: Record<string, PluginStoreEntry> = {};
let packages: Record<string, InstalledPackage> = {};
let reviews: Record<string, GitHubInstallReview> = {};
let check: PackageUpdateCheck | undefined;
let removeError: unknown;
let rollbackError: unknown;
let calls: Call[] = [];
/** Holds every review resolution until released, to settle it after a navigation. */
let resolveGate: Promise<void> | undefined;
let viewport: { compact: boolean; wide: boolean } = {
  compact: false,
  wide: false,
};

function json(status: number, body: unknown) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
  });
}

class IdleResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function stubViewport(next: Partial<typeof viewport>) {
  viewport = { ...viewport, ...next };
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      (query === "(max-width: 639px)" && viewport.compact) ||
      (query === "(min-width: 1280px)" && viewport.wide),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  }));
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal("ResizeObserver", IdleResizeObserver);
  auth.role = "owner";
  entries = {};
  packages = {};
  reviews = {};
  check = undefined;
  removeError = undefined;
  rollbackError = undefined;
  calls = [];
  resolveGate = undefined;
  viewport = { compact: false, wide: false };
  stubViewport({});
  jobsStub.mockReset();
  jobsStub.mockResolvedValue([]);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      const path = new URL(url, "http://localhost").pathname.replace(
        "/api/v1",
        "",
      );
      const method = init?.method ?? "GET";
      calls.push({ method, path });
      const id = decodeURIComponent(path.split("/")[2] ?? "");
      const missing = () =>
        Promise.resolve(
          json(404, { error: { code: "plugin_not_found", message: "Gone." } }),
        );

      if (path.startsWith("/plugin-store/") && method === "GET") {
        const entry = entries[id];
        return entry ? Promise.resolve(json(200, { data: entry })) : missing();
      }
      if (path.endsWith("/resolve") && method === "POST") {
        const found = reviews[id];
        const respond = () =>
          found
            ? json(200, { data: found })
            : json(404, {
                error: { code: "plugin_not_found", message: "Gone." },
              });
        return resolveGate
          ? resolveGate.then(respond)
          : Promise.resolve(respond());
      }
      if (path.endsWith("/install") && method === "POST") {
        const entry = entries[id];
        if (!entry) return missing();
        if (entry.marketplace)
          entry.marketplace = { ...entry.marketplace, installed: true };
        if (entry.custom) entry.custom = { ...entry.custom, installed: true };
        packages[id] = installedPackage({ packageId: id });
        return Promise.resolve(json(201, { data: packages[id] }));
      }
      if (path.startsWith("/packages/") && method === "DELETE") {
        if (removeError) return Promise.resolve(json(409, removeError));
        delete packages[id];
        return Promise.resolve(json(204, {}));
      }
      if (path.endsWith("/update-check") && method === "POST") {
        const installed = packages[id];
        if (!installed) return missing();
        return Promise.resolve(
          json(200, {
            data: check ?? updateCheck({ installed }),
          }),
        );
      }
      if (path.endsWith("/update") && method === "POST") {
        const installed = packages[id];
        if (!installed || !check?.latest) return missing();
        packages[id] = {
          ...installed,
          version: check.latest.version,
          digest: check.latest.digest,
          hasRollback: true,
        };
        return Promise.resolve(
          json(200, { data: { package: packages[id], updated: true } }),
        );
      }
      if (path.endsWith("/rollback") && method === "POST") {
        if (rollbackError) return Promise.resolve(json(409, rollbackError));
        const installed = packages[id];
        if (!installed) return missing();
        packages[id] = { ...installed, hasRollback: false };
        return Promise.resolve(json(200, { data: packages[id] }));
      }
      if (path.startsWith("/packages/") && method === "GET") {
        const installed = packages[id];
        return installed
          ? Promise.resolve(json(200, { data: installed }))
          : missing();
      }
      return Promise.resolve(json(200, { data: { items: [], total: 0 } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let navigateTo: (to: string) => void = () => undefined;

/** Lets a test move between detail routes while a modal holds the page. */
function NavigationHandle() {
  const navigate = useNavigate();
  useEffect(() => {
    navigateTo = (to) => void navigate(to);
  }, [navigate]);
  return null;
}

function LocationValue() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}</output>;
}

function renderDetail(packageId: string) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[`/plugins/store/${packageId}`]}>
        <Routes>
          <Route path="/plugins/store" element={<p>Explore</p>} />
          <Route
            path="/plugins/store/:id"
            element={<PluginStoreDetailPage />}
          />
          <Route path="/plugins/:page" element={<p>Management page</p>} />
        </Routes>
        <LocationValue />
        <NavigationHandle />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const marketplaceEntry = (
  overrides: Parameters<typeof marketplaceListing>[0] = {},
): PluginStoreEntry => ({
  packageId: "acme.weather",
  source: { kind: "marketplace", catalogId: "tilecast-marketplace" },
  marketplace: marketplaceListing({
    categories: ["data"],
    ...overrides,
  }),
});

const customEntry = (
  overrides: Parameters<typeof customPackage>[0] = {},
): PluginStoreEntry => ({
  packageId: "acme.kiosk",
  source: {
    kind: "custom",
    repository: "https://github.com/acme/tilecast-kiosk",
  },
  custom: customPackage(overrides),
});

const includedEntry = (
  overrides: Parameters<typeof catalogPlugin>[0] = { id: "emergency_alerts" },
): PluginStoreEntry => ({
  packageId: overrides.id,
  source: { kind: "included" },
  plugin: catalogPlugin(overrides),
});

const screenshots = [
  { url: "/api/v1/marketplace/artwork/acme.weather/shot-1", alt: "Forecast" },
  { url: "/api/v1/marketplace/artwork/acme.weather/shot-2", alt: "Radar map" },
  { url: "/api/v1/marketplace/artwork/acme.weather/shot-3", alt: "Alerts" },
];

const richCapabilities: PackageCapabilities = {
  network: { hosts: ["api.weather.example"] },
  storage: true,
  background: { jobs: [{ id: "refresh-scores", intervalMinutes: 5 }] },
  studioUI: { entry: "./studio/index.html" },
};

describe("Included detail page", () => {
  beforeEach(() => {
    entries["emergency_alerts"] = includedEntry({
      id: "emergency_alerts",
      installed: false,
    });
  });

  it("shows the shared shell without any package trust wording", async () => {
    renderDetail("emergency_alerts");
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Emergency Alerts",
      }),
    ).toBeVisible();
    // The badge names the source; the card explains it.
    const badges = screen.getByRole("list", { name: "Plugin details" });
    expect(within(badges).getByText("Included")).toBeVisible();
    expect(within(badges).getByText("Automation")).toBeVisible();
    expect(screen.getByText("Included with Tilecast")).toBeVisible();
    expect(screen.getByText(/No external package is downloaded/)).toBeVisible();
    // Nothing a registry or signer would explain.
    expect(screen.queryByText("Digest")).toBeNull();
    expect(screen.queryByText("Signer")).toBeNull();
    expect(screen.queryByText("Registry")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Technical details" }),
    ).toBeNull();
    expect(screen.queryByText("Featured")).toBeNull();
    expect(screen.queryByText("What this plugin adds")).toBeNull();
  });

  it("lists requirements and the behaviors the release declares", async () => {
    renderDetail("emergency_alerts");
    expect(
      await screen.findByRole("heading", { name: "Requirements" }),
    ).toBeVisible();
    expect(screen.getByText("United States")).toBeVisible();
    expect(
      screen.getByText("Internet access from Tilecast Server"),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Permissions & behavior" }),
    ).toBeVisible();
    expect(screen.getByText("Background NWS polling")).toBeVisible();
  });

  it("says so when an included plugin needs nothing special", async () => {
    entries["countdown_bar"] = includedEntry({
      id: "countdown_bar",
      installed: false,
    });
    renderDetail("countdown_bar");
    expect(await screen.findByText("No special permissions")).toBeVisible();
    expect(
      screen.getByText(
        "This plugin doesn't request network access, local storage, background jobs, or a custom Studio interface.",
      ),
    ).toBeVisible();
    // Nothing to list, so no Requirements section to restate it.
    expect(screen.queryByRole("heading", { name: "Requirements" })).toBeNull();
  });

  it("credits Tilecast as the builder of an included plugin", async () => {
    entries["countdown_bar"] = includedEntry({
      id: "countdown_bar",
      installed: false,
    });
    renderDetail("countdown_bar");
    expect(await screen.findByText("by Tilecast")).toBeVisible();
    const about = screen.getByRole("region", {
      name: "Included with Tilecast",
    });
    expect(within(about).getByText("Tilecast")).toBeVisible();
  });

  it("installs and opens the management page", async () => {
    const user = userEvent.setup();
    renderDetail("emergency_alerts");
    await user.click(await screen.findByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Current route")).toHaveTextContent(
        "/plugins/emergency-alerts",
      ),
    );
  });

  it("offers Open for an installed plugin with a management page", async () => {
    entries["emergency_alerts"] = includedEntry({
      id: "emergency_alerts",
      installed: true,
    });
    renderDetail("emergency_alerts");
    const open = await screen.findByRole("link", {
      name: "Open Emergency Alerts",
    });
    expect(open).toHaveAttribute("href", "/plugins/emergency-alerts");
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("shows status, not a disabled button, for an installed plugin with no page", async () => {
    entries["emergency_alerts"] = includedEntry({
      id: "emergency_alerts",
      installed: true,
      managementPath: "/plugins/not-in-this-bundle",
    });
    renderDetail("emergency_alerts");
    const status = await screen.findByRole("region", {
      name: "Package status",
    });
    expect(within(status).getByText("Installed")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Installed" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Open/ })).toBeNull();
  });

  it("explains who can install instead of offering the action", async () => {
    auth.role = "viewer";
    renderDetail("emergency_alerts");
    expect(
      await screen.findByText("An Owner or Administrator can install plugins."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });
});

describe("Marketplace detail page", () => {
  beforeEach(() => {
    entries["acme.weather"] = marketplaceEntry({
      featured: true,
      artwork: {
        iconUrl: "/api/v1/marketplace/artwork/acme.weather/icon",
        screenshots,
      },
    });
    reviews["acme.weather"] = installReview({
      packageId: "acme.weather",
      version: "1.0.0",
    });
  });

  it("shows hero, publisher, badges, and the package cards", async () => {
    renderDetail("acme.weather");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Weather" }),
    ).toBeVisible();
    const publisher = screen.getByRole("link", {
      name: "Acme, repository (opens in a new tab)",
    });
    expect(publisher.closest("p")).toHaveTextContent("by Acme");
    const badges = screen.getByRole("list", { name: "Plugin details" });
    expect(within(badges).getByText("Marketplace")).toBeVisible();
    expect(within(badges).getByText("data")).toBeVisible();
    // Featured is an Explore cue, not a detail-page badge. A package that is
    // not installed shows no state badge at all.
    expect(within(badges).queryByText("Featured")).toBeNull();
    expect(within(badges).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getAllByText("Current conditions.").length).toBeGreaterThan(
      0,
    );

    const status = screen.getByRole("region", { name: "Package status" });
    expect(within(status).getByText("Not installed")).toBeVisible();
    expect(within(status).getByText("Version 1.0.0")).toBeVisible();
    expect(
      within(status).getByText("Compatible with this server"),
    ).toBeVisible();
    expect(within(status).getByText("Requires Tilecast >=0.0.0")).toBeVisible();

    const about = screen.getByRole("region", { name: "About this package" });
    expect(within(about).getByText("Acme")).toBeVisible();
    expect(within(about).getByText("MIT")).toBeVisible();
    expect(
      within(about).getByText("Official Tilecast Marketplace"),
    ).toBeVisible();
    // Where the listing comes from lives here, not in the main About.
    expect(
      within(about).getByText("Listed in the official Tilecast Marketplace."),
    ).toBeVisible();
    for (const [name, href] of [
      ["Repository", "https://github.com/acme/tilecast-weather"],
      ["Documentation", "https://example.com/acme/weather/docs"],
      ["Report an issue", "https://github.com/acme/tilecast-weather/issues"],
    ] as const) {
      expect(within(about).getByRole("link", { name })).toHaveAttribute(
        "href",
        href,
      );
    }
  });

  it("states that contributions and permissions come with the install review", async () => {
    renderDetail("acme.weather");
    expect(
      await screen.findByRole("heading", { name: "What this plugin adds" }),
    ).toBeVisible();
    expect(
      screen.getByText(/What it adds is listed in the install review/),
    ).toBeVisible();
    expect(screen.getByText(/Requested permissions are listed/)).toBeVisible();
  });

  it("uses the Marketplace artwork and falls back to the generic icon", async () => {
    renderDetail("acme.weather");
    await screen.findByRole("heading", { level: 1, name: "Weather" });
    const artwork = document.querySelector(
      "header [data-slot='plugin-artwork'] img",
    ) as HTMLImageElement;
    expect(artwork).toHaveAttribute(
      "src",
      "/api/v1/marketplace/artwork/acme.weather/icon",
    );
    artwork.dispatchEvent(new Event("error"));
    await waitFor(() =>
      expect(
        document.querySelector("header [data-slot='plugin-artwork'] img"),
      ).toBeNull(),
    );
  });

  it("renders the screenshots as a carousel without autoplay", async () => {
    renderDetail("acme.weather");
    const carousel = await screen.findByRole("region", {
      name: "Screenshots",
    });
    const slides = within(carousel).getAllByRole("group");
    expect(slides).toHaveLength(3);
    expect(slides[0]).toHaveAttribute("aria-roledescription", "slide");
    expect(
      within(carousel).getByRole("button", { name: "Previous slide" }),
    ).toBeVisible();
    expect(
      within(carousel).getByRole("button", { name: "Next slide" }),
    ).toBeVisible();
    // 16:9 frames.
    expect(
      within(slides[0] as HTMLElement).getByRole("button").className,
    ).toContain("aspect-video");
    expect(carousel.querySelector("img")).toHaveAttribute("loading", "lazy");
  });

  it("opens a screenshot in a larger dialog and closes it with Escape", async () => {
    const user = userEvent.setup();
    renderDetail("acme.weather");
    const opener = await screen.findByRole("button", {
      name: "Enlarge screenshot: Radar map",
    });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("img", { name: "Radar map" }),
    ).toHaveAttribute("src", screenshots[1]?.url);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();
  });

  it("omits the screenshots section when a listing has none", async () => {
    entries["acme.weather"] = marketplaceEntry({
      artwork: { screenshots: [] },
    });
    renderDetail("acme.weather");
    await screen.findByRole("heading", { level: 1, name: "Weather" });
    expect(screen.queryByRole("region", { name: "Screenshots" })).toBeNull();
    expect(screen.queryByText("Screenshots")).toBeNull();
  });

  it("keeps a failed screenshot in its slot with a placeholder", async () => {
    renderDetail("acme.weather");
    const carousel = await screen.findByRole("region", {
      name: "Screenshots",
    });
    carousel.querySelector("img")?.dispatchEvent(new Event("error"));
    expect(
      await within(carousel).findByText("Screenshot unavailable"),
    ).toBeVisible();
    expect(within(carousel).getAllByRole("group")).toHaveLength(3);
  });

  it("shows the update status for an installed listing", async () => {
    entries["acme.weather"] = marketplaceEntry({
      version: "1.4.0",
      installed: true,
      installedVersion: "1.3.0",
      updateAvailable: true,
    });
    packages["acme.weather"] = installedPackage({
      packageId: "acme.weather",
      version: "1.3.0",
      sourceKind: "marketplace",
    });
    renderDetail("acme.weather");
    const status = await screen.findByRole("region", {
      name: "Package status",
    });
    // State first, then the one thing to do about it.
    expect(within(status).getByText("Update available")).toBeVisible();
    expect(within(status).getByText("From 1.3.0 to 1.4.0")).toBeInTheDocument();
    expect(
      within(status).getByRole("button", { name: "Review update" }),
    ).toBeVisible();
    // Checking again is not the main action once an update is known.
    expect(
      within(status).queryByRole("button", { name: "Check for updates" }),
    ).toBeNull();
    // The hero carries just the one state badge.
    const badges = screen.getByRole("list", { name: "Plugin details" });
    expect(within(badges).getByText("Update available")).toBeVisible();
    expect(within(badges).queryByText("Installed")).toBeNull();
  });

  it("opens the review straight from a listing's known update", async () => {
    entries["acme.weather"] = marketplaceEntry({
      version: "1.4.0",
      installed: true,
      installedVersion: "1.3.0",
      updateAvailable: true,
    });
    packages["acme.weather"] = installedPackage({
      packageId: "acme.weather",
      version: "1.3.0",
      sourceKind: "marketplace",
    });
    check = updateCheck({
      installed: packages["acme.weather"],
      available: true,
      upToDate: false,
      latest: installReview({
        packageId: "acme.weather",
        version: "1.4.0",
        manifest: {
          name: "Weather",
          description: "",
          publisherId: "acme",
          publisherName: "Acme",
          license: "MIT",
          tilecastRange: ">=0.0.0",
        },
      }),
    });
    const user = userEvent.setup();
    renderDetail("acme.weather");
    await user.click(
      await screen.findByRole("button", { name: "Review update" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Update Weather");
    expect(
      within(dialog).getByRole("button", { name: "Update to 1.4.0" }),
    ).toBeEnabled();
  });

  it("limits the hero to two categories", async () => {
    entries["acme.weather"] = marketplaceEntry({
      categories: ["data", "weather", "maps"],
    });
    renderDetail("acme.weather");
    const badges = await screen.findByRole("list", { name: "Plugin details" });
    expect(within(badges).getByText("data")).toBeVisible();
    expect(within(badges).getByText("weather")).toBeVisible();
    expect(within(badges).queryByText("maps")).toBeNull();
  });
});

describe("Incompatible package", () => {
  it("shows an alert near the top and disables the action with the reason", async () => {
    entries["acme.weather"] = marketplaceEntry({
      compatible: false,
      tilecastRange: ">=99.0.0",
    });
    renderDetail("acme.weather");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Not compatible with this Tilecast version",
    );
    expect(alert).toHaveTextContent("This plugin requires Tilecast >=99.0.0.");
    const action = screen.getByRole("button", { name: "Review & install" });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("aria-describedby", alert.id);
    const status = screen.getByRole("region", { name: "Package status" });
    expect(within(status).getByText("Not compatible")).toBeVisible();
    expect(
      within(status).getByText("Not compatible with this server"),
    ).toBeVisible();
  });
});

describe("Custom detail page", () => {
  beforeEach(() => {
    entries["acme.kiosk"] = customEntry();
  });

  it("shows a custom notice and none of the Marketplace curation", async () => {
    renderDetail("acme.kiosk");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Lobby Kiosk" }),
    ).toBeVisible();
    const badges = screen.getByRole("list", { name: "Plugin details" });
    expect(within(badges).getByText("Custom")).toBeVisible();
    expect(within(badges).queryByText("Featured")).toBeNull();
    const about = screen.getByRole("region", { name: "Custom package" });
    expect(
      within(about).getByText("Not reviewed or curated by the Marketplace."),
    ).toBeVisible();
    expect(within(about).getByText("Custom GitHub repository")).toBeVisible();
    expect(within(about).getByText("Verified when you install")).toBeVisible();
    expect(
      within(about).getByRole("link", { name: "Repository" }),
    ).toHaveAttribute("href", "https://github.com/acme/tilecast-kiosk");
    expect(screen.queryByText(/Official Tilecast Marketplace/)).toBeNull();
    expect(
      screen.queryByText("Listed in the official Tilecast Marketplace."),
    ).toBeNull();
    // Custom packages never carry screenshots.
    expect(screen.queryByRole("region", { name: "Screenshots" })).toBeNull();
  });

  it("installs directly, with no review step", async () => {
    const user = userEvent.setup();
    renderDetail("acme.kiosk");
    await user.click(await screen.findByRole("button", { name: "Install" }));
    expect(
      await screen.findByRole("heading", { name: "Danger zone" }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toContainEqual({
      method: "POST",
      path: "/plugin-store/acme.kiosk/install",
    });
  });

  it("states verified provenance once the package is installed", async () => {
    entries["acme.kiosk"] = customEntry({ installed: true });
    packages["acme.kiosk"] = installedPackage();
    renderDetail("acme.kiosk");
    const about = await screen.findByRole("region", {
      name: "Custom package",
    });
    expect(
      await within(about).findByText("Verified release provenance"),
    ).toBeVisible();
  });
});

describe("Installed package", () => {
  beforeEach(() => {
    entries["acme.weather"] = marketplaceEntry({
      installed: true,
      installedVersion: "1.2.0",
    });
    packages["acme.weather"] = installedPackage({
      packageId: "acme.weather",
      sourceKind: "marketplace",
      contributions: [
        {
          kind: "widget",
          id: "acme.weather.scoreboard",
          path: "./widgets/scoreboard",
        },
        {
          kind: "dataSource",
          id: "acme.weather.sports-scores",
          path: "./data/sports-scores",
        },
      ],
      capabilities: richCapabilities,
      runtime: { module: "./runtime/plugin.wasm" },
    });
  });

  it("lists what the plugin adds by name and kind, not by path", async () => {
    renderDetail("acme.weather");
    const section = await screen.findByRole("region", {
      name: "What this plugin adds",
    });
    expect(await within(section).findByText("Scoreboard")).toBeVisible();
    expect(within(section).getByText("Widget")).toBeVisible();
    expect(
      within(section).getByText("Adds a widget you can place in layouts."),
    ).toBeVisible();
    expect(within(section).getByText("Sports scores")).toBeVisible();
    expect(within(section).getByText("Data source")).toBeVisible();
    expect(
      within(section).getByText("Supplies data to compatible widgets."),
    ).toBeVisible();
    // Exact paths and ids wait behind Technical details.
    expect(screen.queryByText(/\.\/widgets\/scoreboard/)).toBeNull();
  });

  it("translates capabilities into plain language", async () => {
    renderDetail("acme.weather");
    const section = await screen.findByRole("region", {
      name: "Permissions & behavior",
    });
    expect(await within(section).findByText("Network access")).toBeVisible();
    expect(within(section).getByText("Can connect to:")).toBeVisible();
    expect(within(section).getByText("api.weather.example")).toBeVisible();
    expect(within(section).getByText("Local storage")).toBeVisible();
    expect(
      within(section).getByText(
        "Stores this plugin's own data on the Tilecast server.",
      ),
    ).toBeVisible();
    expect(within(section).getByText("Background activity")).toBeVisible();
    // How many jobs, not when: the schedule lives in Background jobs.
    expect(within(section).getByText("Runs 1 scheduled job.")).toBeVisible();
    expect(within(section).queryByText(/Every 5 minutes/)).toBeNull();
    expect(within(section).queryByText(/Refresh scores/)).toBeNull();
    expect(within(section).getByText("Studio interface")).toBeVisible();
    expect(
      within(section).getByText(
        "Adds its own configuration interface to Studio.",
      ),
    ).toBeVisible();
    expect(within(section).queryByText("./studio/index.html")).toBeNull();
  });

  it("states when an installed package asks for nothing special", async () => {
    packages["acme.weather"] = installedPackage({
      packageId: "acme.weather",
      capabilities: undefined,
    });
    renderDetail("acme.weather");
    expect(await screen.findByText("No special permissions")).toBeVisible();
  });

  it("keeps low-level package facts under Technical details", async () => {
    const user = userEvent.setup();
    renderDetail("acme.weather");
    const trigger = await screen.findByRole("button", {
      name: "Technical details",
    });
    expect(screen.queryByText("Signer")).toBeNull();
    await user.click(trigger);
    expect(screen.getByText("Package ID")).toBeVisible();
    expect(screen.getByText("acme.weather")).toBeVisible();
    expect(screen.getByText("Digest")).toBeVisible();
    expect(
      screen.getByText(
        "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      ),
    ).toBeVisible();
    expect(screen.getByText("Registry")).toBeVisible();
    expect(screen.getByText("ghcr.io/acme/tilecast-kiosk")).toBeVisible();
    expect(screen.getByText("Signer")).toBeVisible();
    expect(screen.getByText("Runtime module")).toBeVisible();
    expect(screen.getByText("./runtime/plugin.wasm")).toBeVisible();
    expect(
      screen.getByText(
        "widget · acme.weather.scoreboard · ./widgets/scoreboard",
      ),
    ).toBeVisible();
  });

  it("puts the sandboxed Studio UI in a labelled settings card", async () => {
    renderDetail("acme.weather");
    const card = await screen.findByRole("region", {
      name: "Plugin settings",
    });
    expect(
      within(card).getByText("Configure this plugin without leaving Tilecast."),
    ).toBeVisible();
    const frame = within(card).getByTitle("Package interface");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute(
      "src",
      "/api/v1/packages/acme.weather/studio/frame",
    );
  });

  it("hides the Studio UI card from someone who cannot manage packages", async () => {
    auth.role = "viewer";
    renderDetail("acme.weather");
    await screen.findByRole("region", { name: "Package status" });
    expect(
      screen.queryByRole("region", { name: "Plugin settings" }),
    ).toBeNull();
  });

  it("omits settings and jobs for a package without those capabilities", async () => {
    packages["acme.weather"] = installedPackage({
      packageId: "acme.weather",
      capabilities: { storage: true },
    });
    renderDetail("acme.weather");
    await screen.findByText("Local storage");
    expect(
      screen.queryByRole("region", { name: "Plugin settings" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Background jobs" }),
    ).toBeNull();
  });

  it("lists background jobs with their schedule and outcome", async () => {
    jobsStub.mockResolvedValue([
      {
        jobId: "refresh-scores",
        intervalMinutes: 5,
        nextRunAt: new Date(Date.now() + 3 * 60_000).toISOString(),
        lastRunAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        lastStatus: "ok",
        lastError: "",
        consecutiveFailures: 0,
      },
    ]);
    renderDetail("acme.weather");
    expect(
      await screen.findByRole("heading", { name: "Background jobs" }),
    ).toBeVisible();
    expect(
      await screen.findByText("Last run 2 minutes ago · Successful"),
    ).toBeVisible();
    expect(screen.getByText("Next run in 3 minutes")).toBeVisible();
  });
});

describe("Install review", () => {
  beforeEach(() => {
    entries["acme.weather"] = marketplaceEntry();
    reviews["acme.weather"] = installReview({
      packageId: "acme.weather",
      version: "1.0.0",
      manifest: {
        name: "Weather",
        description: "Current conditions.",
        publisherId: "acme",
        publisherName: "Acme",
        license: "MIT",
        tilecastRange: ">=0.0.0",
      },
      contributions: [{ type: "widget", path: "./widgets/scoreboard" }],
      capabilities: richCapabilities,
      runtime: { module: "./runtime/plugin.wasm" },
    });
  });

  it("opens a Dialog on a wide viewport with a footer that stays in view", async () => {
    const user = userEvent.setup();
    renderDetail("acme.weather");
    await user.click(
      await screen.findByRole("button", { name: "Review & install" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Review Weather",
    });
    expect(dialog).toHaveAttribute("data-slot", "dialog-content");
    expect(document.querySelector("[data-slot='drawer-popup']")).toBeNull();
    // Identity, provenance, contributions, permissions, one place.
    expect(
      within(dialog).getByText("Acme · acme/tilecast-kiosk"),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        "Signed by https://github.com/acme/tilecast-kiosk",
      ),
    ).toBeVisible();
    expect(within(dialog).getByText("Scoreboard")).toBeVisible();
    expect(within(dialog).getByText("Network access")).toBeVisible();
    expect(within(dialog).getByText("api.weather.example")).toBeVisible();
    expect(within(dialog).getByText("Local storage")).toBeVisible();
    expect(within(dialog).getByText("Background activity")).toBeVisible();
    expect(within(dialog).getByText("Studio interface")).toBeVisible();
    // Footer outside the scrolling body.
    const footer = dialog.querySelector("[data-slot='dialog-footer']");
    expect(footer).not.toBeNull();
    expect(
      within(footer as HTMLElement).getByRole("button", { name: "Cancel" }),
    ).toBeVisible();
    expect(
      within(footer as HTMLElement).getByRole("button", {
        name: "Install plugin",
      }),
    ).toBeVisible();
    expect((footer as HTMLElement).previousElementSibling?.className).toContain(
      "overflow-y-auto",
    );
  });

  it("opens a Drawer on a phone", async () => {
    stubViewport({ compact: true });
    const user = userEvent.setup();
    renderDetail("acme.weather");
    await user.click(
      await screen.findByRole("button", { name: "Review & install" }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Review Weather",
    });
    expect(drawer).toHaveAttribute("data-slot", "drawer-popup");
    expect(document.querySelector("[data-slot='dialog-content']")).toBeNull();
    const footer = drawer.querySelector("[data-slot='drawer-footer']");
    expect(
      within(footer as HTMLElement).getByRole("button", {
        name: "Install plugin",
      }),
    ).toBeVisible();
    expect(
      within(footer as HTMLElement).getByRole("button", { name: "Cancel" }),
    ).toBeVisible();
  });

  it("keeps the technical details collapsed by default", async () => {
    const user = userEvent.setup();
    renderDetail("acme.weather");
    await user.click(
      await screen.findByRole("button", { name: "Review & install" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("Runtime module")).toBeNull();
    await user.click(
      within(dialog).getByRole("button", { name: "Technical details" }),
    );
    expect(within(dialog).getByText("./runtime/plugin.wasm")).toBeVisible();
  });

  it("moves focus into the dialog and gives it back on Escape", async () => {
    const user = userEvent.setup();
    renderDetail("acme.weather");
    const trigger = await screen.findByRole("button", {
      name: "Review & install",
    });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog");
    // Focus starts on the scrollable body, so a long review opens at its
    // top and a keyboard can scroll it.
    const body = within(dialog).getByRole("region", { name: "Review Weather" });
    await waitFor(() => expect(body).toHaveFocus());
    expect(body).toHaveAttribute("tabindex", "0");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(calls.filter((call) => call.path.endsWith("/install"))).toHaveLength(
      0,
    );
  });

  it("installs from the footer and closes", async () => {
    const user = userEvent.setup();
    renderDetail("acme.weather");
    await user.click(
      await screen.findByRole("button", { name: "Review & install" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Install plugin" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls).toContainEqual({
      method: "POST",
      path: "/plugin-store/acme.weather/install",
    });
  });

  it("will not install an incompatible review", async () => {
    reviews["acme.weather"] = installReview({
      packageId: "acme.weather",
      compatible: false,
      manifest: {
        name: "Weather",
        description: "",
        publisherId: "acme",
        publisherName: "Acme",
        license: "MIT",
        tilecastRange: ">=99.0.0",
      },
    });
    const user = userEvent.setup();
    renderDetail("acme.weather");
    await user.click(
      await screen.findByRole("button", { name: "Review & install" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Not compatible with this Tilecast version"),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Install plugin" }),
    ).toBeDisabled();
  });
});

describe("Update review", () => {
  const latest = (overrides: Partial<GitHubInstallReview> = {}) =>
    installReview({
      packageId: "acme.kiosk",
      version: "1.3.0",
      releaseTag: "v1.3.0",
      // i18n-ignore: test fixture value, not Studio copy
      digest:
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      ...overrides,
    });

  beforeEach(() => {
    entries["acme.kiosk"] = customEntry({
      installed: true,
      installedVersion: "1.2.0",
    });
    packages["acme.kiosk"] = installedPackage({
      capabilities: { network: { hosts: ["api.old.example"] }, storage: true },
    });
  });

  async function openUpdateReview(user: ReturnType<typeof userEvent.setup>) {
    renderDetail("acme.kiosk");
    await user.click(
      await screen.findByRole("button", { name: "Check for updates" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Review update" }),
    );
    return screen.findByRole("dialog");
  }

  it("never renders the review inline: only after Review update", async () => {
    check = updateCheck({
      installed: installedPackage(),
      available: true,
      upToDate: false,
      latest: latest(),
    });
    const user = userEvent.setup();
    renderDetail("acme.kiosk");
    await user.click(
      await screen.findByRole("button", { name: "Check for updates" }),
    );
    const status = await screen.findByRole("region", {
      name: "Package status",
    });
    await within(status).findByRole("button", { name: "Review update" });
    expect(within(status).getByText("Update available")).toBeVisible();
    expect(within(status).getByText("From 1.2.0 to 1.3.0")).toBeInTheDocument();
    // The check is no longer the main action; it stays as a quiet retry.
    expect(
      within(status).queryByRole("button", { name: "Check for updates" }),
    ).toBeNull();
    expect(
      within(status).getByRole("button", { name: "Check again" }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("New in this version")).toBeNull();
  });

  it("shows the version change, contribution diff, permission diff, compatibility, and provenance", async () => {
    check = updateCheck({
      installed: installedPackage(),
      available: true,
      upToDate: false,
      latest: latest({
        contributions: [
          { type: "widget", path: "./widgets/concierge" },
          { type: "dataSource", path: "./data/schedule" },
        ],
        capabilities: {
          network: { hosts: ["api.old.example", "cdn.new.example"] },
          background: { jobs: [{ id: "refresh", intervalMinutes: 30 }] },
        },
      }),
    });
    const user = userEvent.setup();
    const dialog = await openUpdateReview(user);
    expect(dialog).toHaveAccessibleName("Update Lobby Kiosk");
    expect(within(dialog).getByText("From 1.2.0 to 1.3.0")).toBeInTheDocument();
    expect(within(dialog).getByText("1.2.0")).toBeVisible();
    expect(within(dialog).getByText("1.3.0")).toBeVisible();

    // Contributions: what arrives, and what leaves.
    expect(within(dialog).getByText("New in this version")).toBeVisible();
    expect(within(dialog).getByText("Concierge")).toBeVisible();
    expect(within(dialog).getByText("Schedule")).toBeVisible();
    expect(within(dialog).getByText("Removed in this version")).toBeVisible();
    expect(within(dialog).getByText("Lobby")).toBeVisible();

    // Capabilities: added, widened, and dropped.
    expect(within(dialog).getByText("New permissions")).toBeVisible();
    expect(within(dialog).getByText("Background activity")).toBeVisible();
    expect(within(dialog).getByText("Changed permissions")).toBeVisible();
    expect(within(dialog).getByText("cdn.new.example")).toBeVisible();
    expect(
      within(dialog).getByText("Previously: api.old.example"),
    ).toBeVisible();
    expect(within(dialog).getByText("Removed permissions")).toBeVisible();
    expect(within(dialog).getByText("Local storage")).toBeVisible();

    // Compatibility and provenance.
    expect(
      within(dialog).queryByText("Not compatible with this Tilecast version"),
    ).toBeNull();
    expect(
      within(dialog).getByText(
        "Signed by https://github.com/acme/tilecast-kiosk",
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Update to 1.3.0" }),
    ).toBeEnabled();
  });

  it("says when contributions and permissions did not change", async () => {
    check = updateCheck({
      installed: installedPackage(),
      available: true,
      upToDate: false,
      latest: latest({
        contributions: [{ type: "widget", path: "lobby" }],
        capabilities: {
          network: { hosts: ["api.old.example"] },
          storage: true,
        },
      }),
    });
    const user = userEvent.setup();
    const dialog = await openUpdateReview(user);
    expect(
      within(dialog).getByText("No changes to what this package adds."),
    ).toBeVisible();
    expect(
      within(dialog).getByText("Permissions are unchanged."),
    ).toBeVisible();
  });

  it("applies the checked digest, closes, and clears the update state", async () => {
    check = updateCheck({
      installed: installedPackage(),
      available: true,
      upToDate: false,
      latest: latest(),
    });
    const user = userEvent.setup();
    const dialog = await openUpdateReview(user);
    await user.click(
      within(dialog).getByRole("button", { name: "Update to 1.3.0" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(packages["acme.kiosk"]?.version).toBe("1.3.0");
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Review update" }),
      ).toBeNull(),
    );
  });

  it("uses a Drawer for the update review on a phone", async () => {
    stubViewport({ compact: true });
    check = updateCheck({
      installed: installedPackage(),
      available: true,
      upToDate: false,
      latest: latest(),
    });
    const user = userEvent.setup();
    const drawer = await openUpdateReview(user);
    expect(drawer).toHaveAttribute("data-slot", "drawer-popup");
  });

  it("reports an inline success when the package is already current", async () => {
    const user = userEvent.setup();
    renderDetail("acme.kiosk");
    await user.click(
      await screen.findByRole("button", { name: "Check for updates" }),
    );
    const message = await screen.findByText("Up to date · 1.2.0");
    expect(message.closest("[role='status']")).not.toBeNull();
    // A compact success state, with a quiet way to check again.
    expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Check for updates" }),
    ).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Review update" })).toBeNull();
  });

  it("says why an update check failed", async () => {
    vi.mocked(fetch).mockImplementationOnce(() =>
      Promise.resolve(json(200, { data: entries["acme.kiosk"] })),
    );
    const user = userEvent.setup();
    renderDetail("acme.kiosk");
    await screen.findByRole("button", { name: "Check for updates" });
    delete packages["acme.kiosk"];
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Gone.")).toBeVisible();
  });
});

describe("Danger zone", () => {
  beforeEach(() => {
    entries["acme.kiosk"] = customEntry({ installed: true });
    packages["acme.kiosk"] = installedPackage({ hasRollback: true });
  });

  it("keeps ordinary recovery apart from destructive removal", async () => {
    renderDetail("acme.kiosk");
    const zone = (
      await screen.findByRole("heading", { name: "Danger zone" })
    ).closest("section") as HTMLElement;
    const management = screen
      .getByRole("heading", { name: "Package management" })
      .closest("section") as HTMLElement;
    const status = screen.getByRole("region", { name: "Package status" });
    // Neither lives with the everyday actions.
    for (const name of ["Remove package", "Restore previous version"]) {
      expect(within(status).queryByRole("button", { name })).toBeNull();
    }
    // Restore is a neutral row; only removal sits in the danger zone.
    expect(
      within(management).getByRole("button", {
        name: "Restore previous version",
      }),
    ).toBeVisible();
    expect(
      within(management).queryByRole("button", { name: "Remove package" }),
    ).toBeNull();
    expect(
      within(zone).getByRole("button", { name: "Remove package" }),
    ).toBeVisible();
    expect(
      within(zone).queryByRole("button", { name: "Restore previous version" }),
    ).toBeNull();
    expect(
      management.compareDocumentPosition(zone) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(zone).toHaveTextContent("Remove this plugin");
    expect(zone).toHaveTextContent(
      "Content still using it must be removed first.",
    );
  });

  it("does not outline the page in red: only the removal row is tinted", async () => {
    renderDetail("acme.kiosk");
    const zone = (
      await screen.findByRole("heading", { name: "Danger zone" })
    ).closest("section") as HTMLElement;
    expect(zone.className).not.toMatch(/border|ring|bg-/);
    const management = screen
      .getByRole("heading", { name: "Package management" })
      .closest("section") as HTMLElement;
    // Count classes that apply as written, not state variants such as
    // aria-invalid: that every button carries.
    const tinted = (root: HTMLElement) =>
      [...root.querySelectorAll<HTMLElement>("*")].filter((element) =>
        [...element.classList].some((name) =>
          /^(border|text|bg|ring)-destructive/.test(name),
        ),
      );
    expect(tinted(management)).toHaveLength(0);
    // The danger zone tints its removal row and button, not the whole page.
    expect(tinted(zone).length).toBeLessThanOrEqual(4);
  });

  it("confirms removal in an AlertDialog whose final action is destructive", async () => {
    const user = userEvent.setup();
    renderDetail("acme.kiosk");
    const trigger = await screen.findByRole("button", {
      name: "Remove package",
    });
    expect(trigger).toHaveAttribute("data-slot", "alert-dialog-trigger");
    await user.click(trigger);
    const dialog = await screen.findByRole("alertdialog");
    const action = within(dialog).getByRole("button", {
      name: "Remove package",
    });
    expect(action).toHaveAttribute("data-slot", "alert-dialog-action");
    expect(action.className).toMatch(/destructive/);
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveAttribute("data-slot", "alert-dialog-cancel");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(packages["acme.kiosk"]).toBeDefined();
  });

  it("names the content that blocks a restore, in package management", async () => {
    rollbackError = {
      error: {
        code: "package_in_use",
        message: "Lobby Kiosk cannot be restored while 1 Widget remains.",
        details: {
          packageId: "acme.kiosk",
          resources: [
            { kind: "widget", count: 1, label: "Widget", resolution: "delete" },
          ],
        },
      },
    };
    const user = userEvent.setup();
    renderDetail("acme.kiosk");
    await user.click(
      await screen.findByRole("button", { name: "Restore previous version" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Restore previous version",
      }),
    );
    const management = screen
      .getByRole("heading", { name: "Package management" })
      .closest("section") as HTMLElement;
    expect(
      await within(management).findByText(
        "Lobby Kiosk cannot be restored while 1 Widget remains.",
      ),
    ).toBeVisible();
    expect(within(management).getByText("1 Widget")).toBeVisible();
    expect(
      within(management).getByText(
        "Delete the remaining content, then try again.",
      ),
    ).toBeVisible();
    expect(packages["acme.kiosk"]?.hasRollback).toBe(true);
  });

  it("asks before restoring the previous version", async () => {
    const user = userEvent.setup();
    renderDetail("acme.kiosk");
    await user.click(
      await screen.findByRole("button", { name: "Restore previous version" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Restore the previous version?"),
    ).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(packages["acme.kiosk"]?.hasRollback).toBe(true);
    expect(
      calls.filter((call) => call.path.endsWith("/rollback")),
    ).toHaveLength(0);
  });

  it("asks before removing, then returns to Explore", async () => {
    const user = userEvent.setup();
    renderDetail("acme.kiosk");
    await user.click(
      await screen.findByRole("button", { name: "Remove package" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Remove this package?")).toBeVisible();
    expect(packages["acme.kiosk"]).toBeDefined();
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

  it("names the content that blocks removal, in the danger zone", async () => {
    removeError = {
      error: {
        code: "package_in_use",
        message: "Lobby Kiosk cannot be removed while 2 Widgets remain.",
        details: {
          packageId: "acme.kiosk",
          resources: [
            {
              kind: "widget",
              count: 2,
              label: "Widgets",
              resolution: "delete",
            },
          ],
        },
      },
    };
    const user = userEvent.setup();
    renderDetail("acme.kiosk");
    await user.click(
      await screen.findByRole("button", { name: "Remove package" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Remove package",
      }),
    );
    const zone = screen
      .getByRole("heading", { name: "Danger zone" })
      .closest("section") as HTMLElement;
    expect(
      await within(zone).findByText(
        "Lobby Kiosk cannot be removed while 2 Widgets remain.",
      ),
    ).toBeVisible();
    expect(within(zone).getByText("2 Widgets")).toBeVisible();
    expect(
      within(zone).getByText("Delete the remaining content, then try again."),
    ).toBeVisible();
    expect(packages["acme.kiosk"]).toBeDefined();
  });

  it("offers neither action to someone who cannot manage packages", async () => {
    auth.role = "editor";
    renderDetail("acme.kiosk");
    await screen.findByRole("region", { name: "Package status" });
    expect(screen.queryByRole("heading", { name: "Danger zone" })).toBeNull();
  });

  it("hides rollback when there is nothing to restore", async () => {
    packages["acme.kiosk"] = installedPackage({ hasRollback: false });
    renderDetail("acme.kiosk");
    await screen.findByRole("heading", { name: "Danger zone" });
    expect(
      screen.queryByRole("button", { name: "Restore previous version" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove package" }),
    ).toBeVisible();
  });
});

describe("About and requirements", () => {
  it("shows the long description as plain paragraphs", async () => {
    entries["acme.weather"] = marketplaceEntry({
      longDescription:
        "Shows conditions for any city.\n\nWorks <b>offline</b> for an hour.",
    });
    renderDetail("acme.weather");
    const about = (
      await screen.findByRole("heading", { name: "About" })
    ).closest("section") as HTMLElement;
    expect(
      within(about).getByText("Shows conditions for any city."),
    ).toBeVisible();
    // Markup is text, never rendered.
    expect(
      within(about).getByText("Works <b>offline</b> for an hour."),
    ).toBeVisible();
    expect(about.querySelector("b")).toBeNull();
    // The sidebar, not About, says where the listing comes from.
    expect(
      within(about).queryByText("Listed in the official Tilecast Marketplace."),
    ).toBeNull();
  });

  it("omits About rather than repeating the hero's short description", async () => {
    entries["acme.weather"] = marketplaceEntry();
    renderDetail("acme.weather");
    await screen.findByRole("region", { name: "Package status" });
    expect(screen.queryByRole("heading", { name: "About" })).toBeNull();
    // The hero is the one place the short description appears.
    expect(screen.getAllByText("Current conditions.")).toHaveLength(1);
  });

  it.each([
    ["case and spacing", "  current   CONDITIONS. "],
    ["trailing punctuation", "Current conditions"],
    ["an identical copy", "Current conditions."],
  ])(
    "treats a long description differing only in %s as a repeat",
    async (_, longDescription) => {
      entries["acme.weather"] = marketplaceEntry({ longDescription });
      renderDetail("acme.weather");
      await screen.findByRole("region", { name: "Package status" });
      expect(screen.queryByRole("heading", { name: "About" })).toBeNull();
    },
  );

  it("keeps About for a long description that says more", async () => {
    entries["acme.weather"] = marketplaceEntry({
      longDescription: "Current conditions. Updates every ten minutes.",
    });
    renderDetail("acme.weather");
    const about = (
      await screen.findByRole("heading", { name: "About" })
    ).closest("section") as HTMLElement;
    expect(
      within(about).getByText("Current conditions. Updates every ten minutes."),
    ).toBeVisible();
  });

  it("omits About for an included plugin, which has no long description", async () => {
    entries["emergency_alerts"] = includedEntry({ id: "emergency_alerts" });
    renderDetail("emergency_alerts");
    await screen.findByRole("region", { name: "Package status" });
    expect(screen.queryByRole("heading", { name: "About" })).toBeNull();
  });

  it("still shows an included plugin's attention notes without an About heading", async () => {
    entries["emergency_alerts"] = includedEntry({
      id: "emergency_alerts",
      attention: [{ code: "needs_region", message: "Choose a region first." }],
    });
    renderDetail("emergency_alerts");
    expect(await screen.findByText("Choose a region first.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "About" })).toBeNull();
  });

  it("does not restate Tilecast compatibility as a Requirements section", async () => {
    entries["acme.weather"] = marketplaceEntry();
    renderDetail("acme.weather");
    await screen.findByRole("region", { name: "Package status" });
    expect(screen.queryByRole("heading", { name: "Requirements" })).toBeNull();
    const status = screen.getByRole("region", { name: "Package status" });
    expect(within(status).getByText("Requires Tilecast >=0.0.0")).toBeVisible();
  });

  it("keeps the Requirements section for real requirements", async () => {
    entries["emergency_alerts"] = includedEntry({
      id: "emergency_alerts",
      installed: false,
    });
    renderDetail("emergency_alerts");
    const section = (
      await screen.findByRole("heading", { name: "Requirements" })
    ).closest("section") as HTMLElement;
    expect(within(section).getByText("United States")).toBeVisible();
    expect(
      within(section).getByText("Internet access from Tilecast Server"),
    ).toBeVisible();
  });
});

describe("Technical details", () => {
  it("is one collapsed Collapsible, closed by default", async () => {
    entries["acme.kiosk"] = customEntry({ installed: true });
    packages["acme.kiosk"] = installedPackage({
      capabilities: {
        background: { jobs: [{ id: "refresh-scores", intervalMinutes: 5 }] },
      },
    });
    const user = userEvent.setup();
    renderDetail("acme.kiosk");
    const trigger = await screen.findByRole("button", {
      name: "Technical details",
    });
    expect(trigger).toHaveAttribute("data-slot", "collapsible-trigger");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Background job IDs")).toBeNull();
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Background job IDs")).toBeVisible();
    expect(screen.getByText("refresh-scores")).toBeVisible();
    expect(document.querySelector("[data-slot='accordion']")).toBeNull();
  });
});

describe("Screenshot carousel sizing", () => {
  it("is a start-aligned carousel that never autoplays, with 16:9 frames", async () => {
    entries["acme.weather"] = marketplaceEntry({
      artwork: { screenshots },
    });
    renderDetail("acme.weather");
    const carousel = await screen.findByRole("region", {
      name: "Screenshots",
    });
    const slides = within(carousel).getAllByRole("group");
    // A phone shows most of one slide with the next peeking in.
    expect(slides[0]?.className).toContain("basis-[88%]");
    // Wide viewports keep each frame well under 300px tall.
    expect(slides[0]?.className).toContain("xl:basis-[38%]");
    expect(slides[0]?.className).toContain("ps-3");
    expect(
      carousel.querySelector("[data-slot='carousel-content']"),
    ).not.toBeNull();
    expect(
      within(slides[0] as HTMLElement).getByRole("button").className,
    ).toContain("aspect-video");
    // Nothing moves on its own.
    expect(carousel.querySelector("[data-autoplay]")).toBeNull();
  });
});

describe("Right-to-left reading", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("dir");
  });

  it("uses logical spacing and mirrors directional icons", async () => {
    document.documentElement.setAttribute("dir", "rtl");
    entries["acme.weather"] = marketplaceEntry({
      artwork: { screenshots },
    });
    renderDetail("acme.weather");
    const carousel = await screen.findByRole("region", {
      name: "Screenshots",
    });
    // Spacing and arrow placement follow the reading direction.
    const content = carousel.querySelector("[data-slot='carousel-content']");
    expect(content?.firstElementChild?.className).toContain("-ms-3");
    expect(within(carousel).getAllByRole("group")[0]?.className).not.toMatch(
      /(^|\s)(pl|ml)-/,
    );
    const next = within(carousel).getByRole("button", { name: "Next slide" });
    expect(next.className).toContain("end-2");
    expect(next.querySelector("svg")?.getAttribute("class")).toContain(
      "rtl:rotate-180",
    );
    // External links mirror their arrow too.
    const about = screen.getByRole("region", { name: "About this package" });
    expect(
      within(about)
        .getByRole("link", { name: "Repository" })
        .querySelector("svg")
        ?.getAttribute("class"),
    ).toContain("rtl:-scale-x-100");
  });
});

describe("Responsive layout", () => {
  beforeEach(() => {
    entries["acme.weather"] = marketplaceEntry();
  });

  it("puts the primary action in the status card on a narrow viewport", async () => {
    renderDetail("acme.weather");
    const status = await screen.findByRole("region", {
      name: "Package status",
    });
    const action = within(status).getByRole("button", {
      name: "Review & install",
    });
    expect(action.className).toContain("w-full");
    // One copy only: the hero does not repeat it.
    expect(
      screen.getAllByRole("button", { name: "Review & install" }),
    ).toHaveLength(1);
    expect(document.querySelector("header")?.contains(action)).toBe(false);
  });

  it("puts the primary action in the hero on a wide viewport", async () => {
    stubViewport({ wide: true });
    renderDetail("acme.weather");
    const action = await screen.findByRole("button", {
      name: "Review & install",
    });
    expect(document.querySelector("header")?.contains(action)).toBe(true);
    expect(
      screen.getAllByRole("button", { name: "Review & install" }),
    ).toHaveLength(1);
    const status = screen.getByRole("region", { name: "Package status" });
    expect(
      within(status).queryByRole("button", { name: "Review & install" }),
    ).toBeNull();
  });

  it("orders the narrow reading order with the status card first", async () => {
    entries["acme.weather"] = marketplaceEntry({
      compatible: false,
      longDescription: "More about the forecast.",
      artwork: { screenshots },
    });
    renderDetail("acme.weather");
    await screen.findByRole("region", { name: "Package status" });
    const orderOf = (element: Element | null) => {
      let node: Element | null = element;
      while (node && !/(^|\s)order-\d/.test(node.className.toString())) {
        node = node.parentElement;
      }
      return Number(
        /(?:^|\s)order-(\d)/.exec(node?.className.toString() ?? "")?.[1],
      );
    };
    const status = orderOf(
      screen.getByRole("region", { name: "Package status" }),
    );
    const alert = orderOf(screen.getByRole("alert"));
    const shots = orderOf(screen.getByRole("region", { name: "Screenshots" }));
    const about = orderOf(screen.getByRole("heading", { name: "About" }));
    const meta = orderOf(
      screen.getByRole("region", { name: "About this package" }),
    );
    expect(status).toBeLessThan(alert);
    expect(alert).toBeLessThan(shots);
    expect(shots).toBeLessThan(about);
    expect(about).toBeLessThan(meta);
  });

  it("uses the wide container and a sticky sidebar", async () => {
    renderDetail("acme.weather");
    const main = (await screen.findByRole("heading", { level: 1 })).closest(
      "main",
    ) as HTMLElement;
    expect(main.className).toContain("max-w-6xl");
    const sidebar = screen
      .getByRole("region", { name: "Package status" })
      .closest(".xl\\:sticky");
    expect(sidebar).not.toBeNull();
  });

  it("keeps the back link first in the tab order", async () => {
    const user = userEvent.setup();
    renderDetail("acme.weather");
    await screen.findByRole("heading", { level: 1 });
    await user.tab();
    expect(screen.getByRole("link", { name: "Back to Explore" })).toHaveFocus();
  });
});

describe("Unknown entries", () => {
  it("explains a missing entry with a way back", async () => {
    renderDetail("nothing.here");
    expect(await screen.findByText("Plugin not found")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Back to Explore" }),
    ).toHaveAttribute("href", "/plugins/store");
  });
});

describe("Hero polish", () => {
  it("leaves Featured to Explore, even for a featured listing", async () => {
    entries["acme.weather"] = marketplaceEntry({ featured: true });
    renderDetail("acme.weather");
    await screen.findByRole("heading", { level: 1, name: "Weather" });
    expect(screen.queryByText("Featured")).toBeNull();
  });

  it("links the publisher to the package repository, outside the page", async () => {
    entries["acme.weather"] = marketplaceEntry();
    renderDetail("acme.weather");
    const link = await screen.findByRole("link", {
      name: "Acme, repository (opens in a new tab)",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/tilecast-weather",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
    // Directly under the title, and still in the package card.
    const title = screen.getByRole("heading", { level: 1, name: "Weather" });
    expect(title.nextElementSibling).toContainElement(link);
    const about = screen.getByRole("region", { name: "About this package" });
    expect(within(about).getByText("Acme")).toBeVisible();
  });

  it("links a custom package's publisher to the repository it came from", async () => {
    entries["acme.kiosk"] = customEntry();
    renderDetail("acme.kiosk");
    expect(
      await screen.findByRole("link", {
        name: "Acme, repository (opens in a new tab)",
      }),
    ).toHaveAttribute("href", "https://github.com/acme/tilecast-kiosk");
  });

  it("names Tilecast as the publisher of an included plugin without a link", async () => {
    entries["emergency_alerts"] = includedEntry({ id: "emergency_alerts" });
    renderDetail("emergency_alerts");
    const byline = await screen.findByText(/^by Tilecast$/);
    expect(byline.querySelector("a")).toBeNull();
  });

  it("does not link a publisher to an address that is not https", async () => {
    entries["acme.weather"] = marketplaceEntry({
      repository: "http://example.com/acme/weather",
    });
    renderDetail("acme.weather");
    const byline = await screen.findByText("by Acme");
    expect(byline.querySelector("a")).toBeNull();
  });
});

describe("Open structured lists", () => {
  const openRows = (section: HTMLElement) => {
    const rows = within(section).getAllByRole("listitem");
    for (const row of rows) {
      const item = row.querySelector("[data-slot='item']");
      expect(item).not.toBeNull();
      expect(item).toHaveAttribute("data-variant", "default");
    }
    return rows;
  };

  beforeEach(() => {
    entries["acme.weather"] = marketplaceEntry({
      installed: true,
      installedVersion: "1.2.0",
    });
    packages["acme.weather"] = installedPackage({
      packageId: "acme.weather",
      sourceKind: "marketplace",
      contributions: [
        { kind: "widget", id: "acme.weather.a", path: "./widgets/scoreboard" },
        { kind: "dataSource", id: "acme.weather.b", path: "./data/scores" },
      ],
      capabilities: richCapabilities,
      runtime: { module: "./runtime/plugin.wasm" },
    });
  });

  it("lists contributions and permissions as unfilled rows with separators", async () => {
    renderDetail("acme.weather");
    const adds = await screen.findByRole("region", {
      name: "What this plugin adds",
    });
    await within(adds).findByText("Scoreboard");
    expect(openRows(adds)).toHaveLength(2);
    expect(adds.querySelectorAll("[data-slot='item-separator']")).toHaveLength(
      1,
    );
    expect(adds.querySelector("[data-slot='card']")).toBeNull();

    const permissions = screen.getByRole("region", {
      name: "Permissions & behavior",
    });
    await within(permissions).findByText("Network access");
    expect(openRows(permissions)).toHaveLength(4);
    expect(
      permissions.querySelectorAll("[data-slot='item-separator']"),
    ).toHaveLength(3);
    // The separator sits inside a list item, so the list stays valid.
    for (const separator of permissions.querySelectorAll(
      "[data-slot='item-separator']",
    )) {
      expect(separator.parentElement?.tagName).toBe("LI");
    }
  });

  it("lists requirements as unfilled rows", async () => {
    entries["emergency_alerts"] = includedEntry({
      id: "emergency_alerts",
      installed: false,
    });
    renderDetail("emergency_alerts");
    const section = (
      await screen.findByRole("heading", { name: "Requirements" })
    ).closest("section") as HTMLElement;
    expect(openRows(section).length).toBeGreaterThan(1);
    expect(
      section.querySelectorAll("[data-slot='item-separator']"),
    ).toHaveLength(openRows(section).length - 1);
  });

  it("keeps a healthy job open and gives only a failed one a fill", async () => {
    jobsStub.mockResolvedValue([
      {
        jobId: "refresh-scores",
        intervalMinutes: 5,
        nextRunAt: new Date(Date.now() + 3 * 60_000).toISOString(),
        lastRunAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        lastStatus: "ok",
        lastError: "",
        consecutiveFailures: 0,
      },
      {
        jobId: "sync-teams",
        intervalMinutes: 60,
        nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
        lastRunAt: new Date(Date.now() - 600_000).toISOString(),
        lastStatus: "error",
        lastError: "boom",
        consecutiveFailures: 1,
      },
    ]);
    renderDetail("acme.weather");
    const healthy = (await screen.findByText("Refresh scores")).closest(
      "[data-slot='item']",
    );
    const failed = screen.getByText("Sync teams").closest("[data-slot='item']");
    expect(healthy).toHaveAttribute("data-variant", "default");
    expect(failed).toHaveAttribute("data-variant", "muted");
    expect(failed).toHaveAttribute("data-status", "failed");
  });
});

describe("Screenshot lightbox", () => {
  beforeEach(() => {
    entries["acme.weather"] = marketplaceEntry({ artwork: { screenshots } });
  });

  async function openShot(
    user: ReturnType<typeof userEvent.setup>,
    alt: string,
  ) {
    renderDetail("acme.weather");
    const opener = await screen.findByRole("button", {
      name: `Enlarge screenshot: ${alt}`,
    });
    await user.click(opener);
    return { opener, dialog: await screen.findByRole("dialog") };
  }

  it("shows the position and steps with Previous and Next, without closing", async () => {
    const user = userEvent.setup();
    const { dialog } = await openShot(user, "Forecast");
    expect(within(dialog).getByText("1 of 3")).toBeVisible();
    expect(
      within(dialog).getByRole("img", { name: "Forecast" }),
    ).toHaveAttribute("src", screenshots[0]?.url);

    await user.click(
      within(dialog).getByRole("button", { name: "Next screenshot" }),
    );
    expect(within(dialog).getByText("2 of 3")).toBeVisible();
    expect(
      within(dialog).getByRole("img", { name: "Radar map" }),
    ).toHaveAttribute("src", screenshots[1]?.url);
    expect(screen.getByRole("dialog")).toBe(dialog);

    await user.click(
      within(dialog).getByRole("button", { name: "Previous screenshot" }),
    );
    expect(within(dialog).getByText("1 of 3")).toBeVisible();
  });

  it("disables the control at each end and keeps focus inside", async () => {
    const user = userEvent.setup();
    const { dialog } = await openShot(user, "Radar map");
    const previous = within(dialog).getByRole("button", {
      name: "Previous screenshot",
    });
    const next = within(dialog).getByRole("button", {
      name: "Next screenshot",
    });
    expect(previous).toBeEnabled();
    expect(next).toBeEnabled();

    await user.click(next);
    expect(within(dialog).getByText("3 of 3")).toBeVisible();
    expect(next).toBeDisabled();
    await waitFor(() => expect(previous).toHaveFocus());

    await user.click(previous);
    await user.click(previous);
    expect(within(dialog).getByText("1 of 3")).toBeVisible();
    expect(previous).toBeDisabled();
    await waitFor(() => expect(next).toHaveFocus());
  });

  it("moves with the arrow keys and stops at the ends", async () => {
    const user = userEvent.setup();
    const { dialog } = await openShot(user, "Forecast");
    await user.keyboard("{ArrowRight}");
    expect(within(dialog).getByText("2 of 3")).toBeVisible();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(within(dialog).getByText("3 of 3")).toBeVisible();
    await user.keyboard("{ArrowLeft}");
    expect(within(dialog).getByText("2 of 3")).toBeVisible();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(within(dialog).getByText("1 of 3")).toBeVisible();
    expect(within(dialog).getByRole("img", { name: "Forecast" })).toBeVisible();
  });

  it("closes with Escape from a later screenshot and returns focus to its slide", async () => {
    const user = userEvent.setup();
    const { dialog } = await openShot(user, "Forecast");
    await user.keyboard("{ArrowRight}");
    expect(within(dialog).getByText("2 of 3")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Focus returns to the control that opened the dialog.
    expect(
      screen.getByRole("button", { name: "Enlarge screenshot: Forecast" }),
    ).toHaveFocus();
  });

  it("offers no stepping for a single screenshot", async () => {
    const user = userEvent.setup();
    entries["acme.weather"] = marketplaceEntry({
      artwork: { screenshots: [screenshots[0]!] },
    });
    const { dialog } = await openShot(user, "Forecast");
    expect(
      within(dialog).queryByRole("button", { name: "Next screenshot" }),
    ).toBeNull();
    expect(within(dialog).queryByText(/^\d+ of \d+$/)).toBeNull();
    await user.keyboard("{ArrowRight}");
    expect(within(dialog).getByRole("img", { name: "Forecast" })).toBeVisible();
  });

  it("reverses the arrow keys in a right-to-left document", async () => {
    document.documentElement.setAttribute("dir", "rtl");
    try {
      const user = userEvent.setup();
      const { dialog } = await openShot(user, "Forecast");
      await user.keyboard("{ArrowLeft}");
      expect(within(dialog).getByText("2 of 3")).toBeVisible();
      await user.keyboard("{ArrowRight}");
      expect(within(dialog).getByText("1 of 3")).toBeVisible();
    } finally {
      document.documentElement.removeAttribute("dir");
    }
  });
});

describe("Review state across listings", () => {
  beforeEach(() => {
    entries["acme.weather"] = marketplaceEntry();
    entries["acme.clock"] = {
      ...marketplaceEntry({ name: "Clock", description: "Tells the time." }),
      packageId: "acme.clock",
    };
    for (const [id, name] of [
      ["acme.weather", "Weather"],
      ["acme.clock", "Clock"],
    ] as const) {
      reviews[id] = installReview({
        packageId: id,
        version: "1.0.0",
        manifest: {
          name,
          description: "",
          publisherId: "acme",
          publisherName: "Acme",
          license: "MIT",
          tilecastRange: ">=0.0.0",
        },
      });
    }
  });

  const installs = () => calls.filter((call) => call.path.endsWith("/install"));

  it("never carries an open review to another listing", async () => {
    const user = userEvent.setup();
    renderDetail("acme.weather");
    await user.click(
      await screen.findByRole("button", { name: "Review & install" }),
    );
    expect(await screen.findByRole("dialog")).toBeVisible();

    act(() => navigateTo("/plugins/store/acme.clock"));
    await screen.findByRole("heading", { level: 1, name: "Clock" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const action = screen.getByRole("button", { name: "Review & install" });
    expect(action).toBeEnabled();

    // Back on the first listing the earlier review is gone, not resurrected.
    act(() => navigateTo("/plugins/store/acme.weather"));
    await screen.findByRole("heading", { level: 1, name: "Weather" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(installs()).toHaveLength(0);
  });

  it("drops a review that resolves after the person moved on", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    resolveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderDetail("acme.weather");
    await user.click(
      await screen.findByRole("button", { name: "Review & install" }),
    );
    act(() => navigateTo("/plugins/store/acme.clock"));
    await screen.findByRole("heading", { level: 1, name: "Clock" });

    await act(async () => {
      release();
      await resolveGate;
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    // The new listing is not stuck on the old one's pending review.
    expect(
      screen.getByRole("button", { name: "Review & install" }),
    ).toBeEnabled();
    expect(installs()).toHaveLength(0);
  });

  it("confirms only the listing it was opened for", async () => {
    const user = userEvent.setup();
    renderDetail("acme.clock");
    await user.click(
      await screen.findByRole("button", { name: "Review & install" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Install plugin" }),
    );
    await waitFor(() =>
      expect(installs()).toEqual([
        { method: "POST", path: "/plugin-store/acme.clock/install" },
      ]),
    );
  });
});

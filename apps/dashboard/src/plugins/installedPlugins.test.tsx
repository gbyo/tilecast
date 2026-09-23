// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isValidElement, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studioRoutes } from "../App";
import type { PluginSummary } from "../api/types";
import { buildCommandResults } from "../components/StudioTopbar";
import { PluginsPage } from "../pages/PluginsPage";
import { catalogPlugin } from "./catalogFixtures";
import { PluginActionsMenu, blockerInstruction } from "./PluginActionsMenu";
import { filterCatalog } from "./PluginCatalogDialog";
import { PluginRouteGate } from "./PluginRouteGate";

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
let calls: { method: string; path: string }[] = [];
let override: Handler | undefined;

function json(status: number, body: unknown) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
  });
}

beforeEach(() => {
  auth.role = "owner";
  calls = [];
  override = undefined;
  catalog = [
    catalogPlugin({
      id: "noise_meter",
      installed: true,
      configured: true,
      active: true,
      instanceCount: 2,
    }),
    catalogPlugin({ id: "forms", installed: true }),
    catalogPlugin({ id: "countdown_bar", installed: false }),
    catalogPlugin({ id: "emergency_alerts", installed: false }),
    catalogPlugin({ id: "brand_bug", installed: false }),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      const path = input.replace("/api/v1", "");
      const request = { method: init?.method ?? "GET", path };
      calls.push(request);
      if (override) return Promise.resolve(override(request));
      if (request.method === "POST" && path.endsWith("/install")) {
        const id = path.split("/")[2];
        catalog = catalog.map((item) =>
          item.id === id ? { ...item, installed: true } : item,
        );
        return Promise.resolve(
          json(201, { data: catalog.find((item) => item.id === id) }),
        );
      }
      if (request.method === "DELETE") return Promise.resolve(json(204, {}));
      if (path === "/plugins")
        return Promise.resolve(
          json(200, {
            data: { items: catalog, unsupportedInstallations: [] },
          }),
        );
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

describe("Installed plugins list", () => {
  it("shows only installed plugins with their status", async () => {
    renderPlugins();
    expect(await screen.findByText("Noise Meter")).toBeVisible();
    expect(screen.getByText("Forms")).toBeVisible();
    expect(screen.queryByText("Countdown Bar")).toBeNull();
    expect(screen.getByText("2 meters")).toBeVisible();
    expect(screen.getByText("Active")).toBeVisible();
    expect(screen.getByText("Needs setup")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open Noise Meter" }),
    ).toHaveAttribute("href", "/plugins/noise-meter");
  });

  it("uses an empty state when nothing is installed", async () => {
    catalog = catalog.map((item) => ({ ...item, installed: false }));
    renderPlugins();
    expect(await screen.findByText("No plugins installed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add plugin" })).toBeVisible();
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

describe("Add plugin", () => {
  it("opens a searchable, filterable catalog of uninstalled plugins", async () => {
    const user = userEvent.setup();
    renderPlugins();
    await user.click(await screen.findByRole("button", { name: "Add plugin" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a plugin" });
    expect(dialog).toHaveTextContent("Countdown Bar");
    expect(dialog).toHaveTextContent("Emergency Alerts");
    expect(dialog).not.toHaveTextContent("Noise Meter");

    await user.click(screen.getByRole("button", { name: "Automation" }));
    expect(dialog).toHaveTextContent("Emergency Alerts");
    expect(dialog).not.toHaveTextContent("Countdown Bar");

    await user.click(screen.getByRole("button", { name: "All" }));
    await user.type(
      screen.getByRole("textbox", { name: "Search plugins" }),
      "noise",
    );
    // An installed plugin reappears when a search matches it, marked.
    expect(dialog).toHaveTextContent("Noise Meter");
    expect(dialog).toHaveTextContent("Installed");
    expect(dialog).not.toHaveTextContent("Countdown Bar");
  });

  it("shows requirements before installing and opens the management page after", async () => {
    const user = userEvent.setup();
    renderPlugins("/plugins?add=emergency_alerts");
    expect(await screen.findByText("Requirements")).toBeVisible();
    expect(screen.getByText("United States")).toBeVisible();
    expect(
      screen.getByText("Internet access from Tilecast Server"),
    ).toBeVisible();
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

  it("does not offer Install to someone who cannot install", async () => {
    auth.role = "editor";
    renderPlugins("/plugins?add=countdown_bar");
    expect(
      await screen.findByText("An Owner or Administrator can install plugins."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("filters by name, description, and category", () => {
    expect(filterCatalog(catalog, "", "All").map((item) => item.id)).toEqual([
      "countdown_bar",
      "emergency_alerts",
      "brand_bug",
    ]);
    expect(
      filterCatalog(catalog, "", "Display").map((item) => item.id),
    ).toEqual(["countdown_bar", "brand_bug"]);
    expect(
      filterCatalog(catalog, "weather", "All").map((item) => item.id),
    ).toEqual(["emergency_alerts"]);
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
                resources: [{ kind: "form", count: 2, label: "forms" }],
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

  it("gives Emergency Alerts steps that match each blocker", () => {
    expect(
      blockerInstruction([
        { kind: "alert_monitor", count: 1, label: "enabled monitor" },
        { kind: "alert_rule", count: 2, label: "alert rules" },
        { kind: "alert_activation", count: 1, label: "active alert" },
      ]),
    ).toBe(
      "Turn monitoring off and delete the remaining alert rules on this page, then remove the plugin.",
    );
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
      "noise",
      undefined,
      catalog,
    );
    const noise = results.find((result) => result.id === "plugin:noise_meter");
    expect(noise).toMatchObject({
      description: "Plugin",
      to: "/plugins/noise-meter",
    });
    const countdown = buildCommandResults(
      studioRoutes,
      [],
      "countdown",
      undefined,
      catalog,
    ).find((result) => result.id === "plugin:countdown_bar");
    expect(countdown).toMatchObject({
      description: "Plugin · Not installed",
      to: "/plugins?add=countdown_bar",
    });
  });
});

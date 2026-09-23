// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router";
import { studioRoutes } from "../App";
import { api } from "../api/client";
import type { Screen } from "../api/types";
import { StudioRoutesProvider } from "../navigation/studioRoutes";
import { SidebarProvider } from "./ui/sidebar";
import { buildCommandResults, fuzzyScore, StudioTopbar } from "./StudioTopbar";
import { i18n } from "../i18n";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  // cmdk measures and scrolls its result list in browsers. jsdom does not
  // implement these layout APIs, so provide inert equivalents for interaction tests.
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
});

const lobbyScreen = {
  id: "screen-1",
  name: "Amazon AFTKRT",
  location: "Lobby",
  platform: "Fire TV",
  status: "offline",
} as Screen;

function LocationValue() {
  return <output aria-label="Current route">{useLocation().pathname}</output>;
}

function renderTopbar(
  path = "/",
  client?: QueryClient,
  overrides: {
    deployments?: Awaited<ReturnType<typeof api.updateDeployments>>;
    pairings?: Awaited<ReturnType<typeof api.pendingPairings>>;
  } = {},
) {
  vi.spyOn(api, "screens").mockResolvedValue({
    items: [lobbyScreen],
    total: 1,
  });
  vi.spyOn(api, "screen").mockResolvedValue(lobbyScreen);
  vi.spyOn(api, "updateDeployments").mockResolvedValue(
    overrides.deployments ?? { items: [] },
  );
  vi.spyOn(api, "pendingPairings").mockResolvedValue(
    overrides.pairings ?? { items: [], total: 0 },
  );
  vi.spyOn(api, "takeovers").mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(api, "assets").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 50,
  });
  vi.spyOn(api, "backups").mockResolvedValue({
    backups: [],
    recentJobs: [],
    schedule: {},
  });
  client ??= new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <SidebarProvider>
          <StudioRoutesProvider routes={studioRoutes}>
            <StudioTopbar
              user={{
                id: "user-1",
                name: "Owner",
                username: "owner",
                role: "owner",
                active: true,
                createdAt: "2026-07-18T00:00:00Z",
              }}
            />
            <LocationValue />
          </StudioRoutesProvider>
        </SidebarProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("StudioTopbar", () => {
  function breadcrumbTrail() {
    const nav = screen.getByRole("navigation", { name: "breadcrumb" });
    return within(nav)
      .getAllByRole("listitem")
      .map((item) => ({
        label: item.textContent,
        href: item.querySelector("a")?.getAttribute("href") ?? null,
        current: item.querySelector('[aria-current="page"]') !== null,
      }));
  }

  it.each([
    ["/", "Overview"],
    ["/screens", "Screens"],
    ["/groups", "Display Groups"],
    ["/assets", "Media"],
    ["/widgets", "Widgets"],
    ["/data-sources", "Data Sources"],
    ["/playlists", "Playlists"],
    ["/layouts", "Layouts"],
    ["/campaigns", "Campaigns"],
    ["/schedules", "Schedules"],
    ["/plugins", "Plugins"],
    ["/activity", "Activity"],
    ["/approvals", "Approvals"],
    ["/account", "My Account"],
  ])(
    "shows the single current-page breadcrumb on top-level route %s",
    (path, label) => {
      renderTopbar(path);

      expect(breadcrumbTrail()).toEqual([{ label, href: null, current: true }]);
    },
  );

  it("links the ancestor on a two-level route", () => {
    renderTopbar("/settings/general");

    expect(breadcrumbTrail()).toEqual([
      { label: "Settings", href: "/settings", current: false },
      { label: "General", href: null, current: true },
    ]);
  });

  it("names the entity as the current page on a detail route", async () => {
    vi.spyOn(api, "layout").mockResolvedValue({
      id: "layout-1",
      name: "Lobby welcome",
    } as Awaited<ReturnType<typeof api.layout>>);
    renderTopbar("/layouts/layout-1");

    await screen.findByText("Lobby welcome", {
      selector: '[aria-current="page"]',
    });
    expect(breadcrumbTrail()).toEqual([
      { label: "Layouts", href: "/layouts", current: false },
      { label: "Lobby welcome", href: null, current: true },
    ]);
  });

  it("keeps the plugin ancestor on a plugin instance route", async () => {
    vi.spyOn(api, "countdownBar").mockResolvedValue({
      id: "bar-1",
      name: "Graduation countdown",
    } as Awaited<ReturnType<typeof api.countdownBar>>);
    renderTopbar("/plugins/countdown-bar/bar-1");

    await screen.findByText("Graduation countdown", {
      selector: '[aria-current="page"]',
    });
    expect(breadcrumbTrail()).toEqual([
      { label: "Plugins", href: "/plugins", current: false },
      {
        label: "Countdown Bar",
        href: "/plugins/countdown-bar",
        current: false,
      },
      { label: "Graduation countdown", href: null, current: true },
    ]);
  });

  it("names a campaign on its detail route", async () => {
    vi.spyOn(api, "campaign").mockResolvedValue({
      id: "campaign-1",
      name: "Spring open house",
    } as Awaited<ReturnType<typeof api.campaign>>);
    renderTopbar("/campaigns/campaign-1");

    await screen.findByText("Spring open house", {
      selector: '[aria-current="page"]',
    });
    expect(breadcrumbTrail()[0]).toEqual({
      label: "Campaigns",
      href: "/campaigns",
      current: false,
    });
  });

  it("builds a detail breadcrumb from the route hierarchy and entity data", async () => {
    renderTopbar("/screens/screen-1");

    expect(
      screen.getByRole("link", { name: "Screens" }).getAttribute("href"),
    ).toBe("/screens");
    expect(
      await screen.findByText("Amazon AFTKRT", {
        selector: '[aria-current="page"]',
      }),
    ).toBeTruthy();
  });

  it("renders the breadcrumb name when a detail page cached the full entity under the shared key", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Detail pages cache the whole entity under ["screens", id]; the breadcrumb
    // shares this key and must derive a string label from it, never render it.
    client.setQueryData(["screens", "screen-1"], lobbyScreen);
    renderTopbar("/screens/screen-1", client);

    expect(
      await screen.findByText("Amazon AFTKRT", {
        selector: '[aria-current="page"]',
      }),
    ).toBeTruthy();
  });

  it("opens search with the global shortcut and navigates with Enter", async () => {
    renderTopbar();
    await waitFor(() => expect(api.screens).toHaveBeenCalled());

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const searchInput = await screen.findByRole("combobox", {
      name: "Search Tilecast",
    });
    fireEvent.change(searchInput, { target: { value: "Amazon" } });
    const result = await screen.findByRole("option", {
      name: /Amazon AFTKRT/,
    });
    await waitFor(() =>
      expect(result.getAttribute("aria-selected")).toBe("true"),
    );
    fireEvent.keyDown(searchInput, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByLabelText("Current route").textContent).toBe(
        "/screens/screen-1",
      ),
    );
  });

  it("groups useful actions and destinations in the command menu", async () => {
    renderTopbar();
    await waitFor(() => expect(api.screens).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Search Tilecast/ }));

    expect(
      await screen.findByText("Quick actions", {
        selector: "[cmdk-group-heading]",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("Screens", { selector: "[cmdk-group-heading]" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: /Create playlist/ }),
    ).toBeTruthy();
  });

  it("finds Display Groups and opens upload from a command action", async () => {
    renderTopbar();
    await waitFor(() => expect(api.screens).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Search Tilecast/ }));
    const searchInput = await screen.findByRole("combobox", {
      name: "Search Tilecast",
    });
    fireEvent.change(searchInput, { target: { value: "sync" } });

    expect(
      await screen.findByRole("option", { name: /Display Groups/ }),
    ).toBeTruthy();

    fireEvent.change(searchInput, { target: { value: "upload" } });
    fireEvent.click(
      await screen.findByRole("option", { name: /Upload media/ }),
    );
    expect(screen.getByRole("dialog", { name: "Upload media" })).toBeTruthy();
  });

  it("shows active alerts in the utility header", async () => {
    renderTopbar();

    const notifications = await screen.findByRole("button", {
      name: /Notifications/,
    });
    expect(notifications).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Pair screen" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Create/ })).toBeNull();
    fireEvent.click(notifications);
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
  });

  it("groups notifications by priority and surfaces new alert sources", async () => {
    renderTopbar("/", undefined, {
      deployments: {
        items: [
          {
            id: "dep-1",
            name: "Winter rollout",
            failedCount: 2,
            waitingForUserCount: 0,
          },
          {
            id: "dep-2",
            name: "Lobby canary",
            failedCount: 0,
            waitingForUserCount: 3,
          },
        ] as Awaited<ReturnType<typeof api.updateDeployments>>["items"],
      },
      pairings: {
        items: [{ id: "pair-1" }] as Awaited<
          ReturnType<typeof api.pendingPairings>
        >["items"],
        total: 1,
      },
    });

    // A failed deployment is critical, so the badge escalates to the critical style.
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));

    expect(
      (
        await screen.findByRole("link", { name: /Winter rollout/ })
      ).getAttribute("href"),
    ).toBe("/settings/player/updates");
    expect(screen.getByRole("region", { name: "Critical" })).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Needs attention" }),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Info" })).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Screens awaiting approval/ })
        .getAttribute("href"),
    ).toBe("/screens/pair");
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
  });

  it("offers creation actions in command search", async () => {
    renderTopbar();

    fireEvent.click(screen.getByRole("button", { name: /Search Tilecast/ }));

    for (const action of [
      "Upload media",
      "Create playlist",
      "Create layout",
      "Create schedule",
    ]) {
      expect(
        await screen.findByRole("option", { name: new RegExp(action) }),
      ).toBeTruthy();
    }
  });

  it("opens the existing upload workflow from command search", async () => {
    renderTopbar();

    fireEvent.click(screen.getByRole("button", { name: /Search Tilecast/ }));
    fireEvent.click(
      await screen.findByRole("option", { name: /Upload media/ }),
    );

    expect(screen.getByRole("dialog", { name: "Upload media" })).toBeTruthy();
  });
});

describe("command search", () => {
  it("fuzzy matches screens and route destinations", () => {
    expect(fuzzyScore("scrns", "Screens")).toBeGreaterThan(0);
    expect(fuzzyScore("xyz", "Screens")).toBe(-1);
    expect(
      buildCommandResults(
        studioRoutes,
        [lobbyScreen],
        "aftkrt",
        undefined,
        undefined,
        i18n.getFixedT("navigation"),
      )[0]?.to,
    ).toBe("/screens/screen-1");
  });
});

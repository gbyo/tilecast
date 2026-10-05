// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, type RouteObject } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studioRoutes } from "@/App";
import { SidebarNavigation } from "@/components/studio/SidebarNavigation.fixture";
import { buildNavigationCatalog } from "@/native-host/useNativeNavigation";
import {
  collectNavigationDestinations,
  resolveActiveDestination,
  StudioNavigationProvider,
  useStudioNavigation,
  type StudioNavigationMetadata,
} from "./studioNavigation";
import { StudioRoutesProvider } from "./studioRoutes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubForms(grantedCapabilities: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ data: { items: [{ grantedCapabilities }] } }),
      }),
    ),
  );
}

let catalog: ReturnType<typeof buildNavigationCatalog> | undefined;

function CatalogProbe() {
  const current = buildNavigationCatalog(useStudioNavigation());
  useEffect(() => {
    catalog = current;
  });
  return null;
}

function renderSidebarAndCatalog(routes: RouteObject[] = studioRoutes) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SidebarNavigation />
        <StudioRoutesProvider routes={routes}>
          <StudioNavigationProvider>
            <CatalogProbe />
          </StudioNavigationProvider>
        </StudioRoutesProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const catalogTitles = () =>
  catalog?.groups.flatMap((group) => group.items.map((item) => item.title));

const sidebarTitles = () =>
  [
    ...document.querySelectorAll<HTMLAnchorElement>(
      '[data-slot="sidebar-content"] a',
    ),
  ].map((link) => link.textContent);

describe("the Studio navigation model", () => {
  it("gives the browser sidebar and the native catalog the same destinations in the same order", async () => {
    stubForms(["review"]);
    renderSidebarAndCatalog();
    await screen.findByRole("link", { name: "Approvals" });

    expect(sidebarTitles()).toEqual(catalogTitles());
    expect(catalogTitles()).toEqual([
      "Overview",
      "Fleet",
      "Display Groups",
      "Media",
      "Widgets",
      "Data Sources",
      "Playlists",
      "Layouts",
      "Campaigns",
      "Schedules",
      "Plugins",
      "Activity",
      "Approvals",
      "Settings",
    ]);
    expect(catalog?.groups.map((group) => [group.id, group.title])).toEqual([
      ["home", undefined],
      ["screens", "Screens"],
      ["content", "Content"],
      ["presentations", "Presentations"],
      ["operations", "Operations"],
      ["secondary", undefined],
    ]);
  });

  it("evaluates plugin visibility once for both consumers", async () => {
    stubForms(["submit"]);
    renderSidebarAndCatalog();
    await screen.findByRole("link", { name: "Settings" });
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    // One query cache, one visibility result: the sidebar and the catalog
    // make a single request between them.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link", { name: "Approvals" })).toBeNull();
    expect(catalogTitles()).not.toContain("Approvals");
  });

  it("marks only Overview, Fleet, and Media as primary on phones", () => {
    const primary = collectNavigationDestinations(studioRoutes)
      .filter((item) => item.mobilePlacement === "primary")
      .map((item) => item.id);
    expect(primary).toEqual(["overview", "screens", "media"]);
  });

  // The Milestone 2 acceptance scenario: a new Studio feature becomes a
  // native destination from route metadata alone.
  it("turns a new route's metadata into a destination with no other change", () => {
    stubForms([]);
    const roomBookings: StudioNavigationMetadata = {
      id: "room-bookings",
      group: "operations",
      labelKey: "items.schedules",
      icon: "door-calendar",
      order: 30,
    };
    const routes: RouteObject[] = [
      {
        path: "/",
        children: [
          { path: "room-bookings", handle: { navigation: roomBookings } },
        ],
      },
    ];
    renderSidebarAndCatalog(routes);

    expect(catalog?.groups).toEqual([
      {
        id: "operations",
        title: "Operations",
        items: [
          {
            id: "room-bookings",
            title: "Schedules",
            icon: "door-calendar",
            mobilePlacement: "more",
          },
        ],
      },
    ]);
    expect(collectNavigationDestinations(routes)[0]?.to).toBe("/room-bookings");
  });
});

describe("collectNavigationDestinations", () => {
  const metadata = (id: string): StudioNavigationMetadata => ({
    id,
    group: "operations",
    labelKey: "items.plugins",
    icon: "plugins",
    order: 0,
  });

  it("derives each destination's path from the route tree", () => {
    const paths = Object.fromEntries(
      collectNavigationDestinations(studioRoutes).map((item) => [
        item.id,
        item.to,
      ]),
    );
    expect(paths).toMatchObject({
      overview: "/",
      screens: "/screens",
      media: "/assets",
      "data-sources": "/data-sources",
      settings: "/settings",
    });
  });

  it("refuses a duplicate id and a parameterized path", () => {
    expect(() =>
      collectNavigationDestinations([
        { path: "/a", handle: { navigation: metadata("same") } },
        { path: "/b", handle: { navigation: metadata("same") } },
      ]),
    ).toThrow(/declared twice/);
    expect(() =>
      collectNavigationDestinations([
        { path: "/things/:id", handle: { navigation: metadata("thing") } },
      ]),
    ).toThrow(/static path/);
  });
});

describe("resolveActiveDestination", () => {
  const destinations = collectNavigationDestinations(studioRoutes);
  const active = (pathname: string) =>
    resolveActiveDestination(pathname, destinations)?.id ?? null;

  it.each([
    ["/", "overview"],
    ["/screens", "screens"],
    ["/screens/player-1", "screens"],
    ["/screens/bulk", "screens"],
    ["/screens/archive", null],
    ["/layouts/abc123", "layouts"],
    ["/playlists/p1", "playlists"],
    ["/plugins/forms", "plugins"],
    ["/settings/users", "settings"],
    ["/account", null],
    ["/account/preferences", null],
    ["/account/security", null],
    ["/content-review", null],
    ["/overview-lookalike", null],
  ])("%s belongs to %s", (pathname, expected) => {
    expect(active(pathname)).toBe(expected);
  });
});

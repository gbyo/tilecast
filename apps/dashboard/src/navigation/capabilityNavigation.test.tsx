// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryRouter,
  MemoryRouter,
  RouterProvider,
  type RouteObject,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studioRoutes } from "@/App";
import { SidebarNavigation } from "@/components/studio/SidebarNavigation.fixture";
import { buildCommandResults } from "@/components/StudioTopbar";
import { i18n } from "@/i18n";
import { buildNavigationCatalog } from "@/native-host/useNativeNavigation";
import { capabilitiesFrom } from "@/auth/capabilities";
import {
  StudioNavigationProvider,
  useStudioNavigation,
} from "./studioNavigation";
import { RouteAccessGate } from "./RouteAccessGate";
import { StudioRoutesProvider } from "./studioRoutes";
import { authStatusFor, mockAuthAs } from "../test/capabilities";

// The Classroom Media role from the school scenario: it can work in the
// Media library and nothing else. Studio never learns the role's name; it
// reads the capabilities the server reports.
const classroomMedia = [
  "media.read",
  "media.upload",
  "media.edit",
  "media.archive",
  "media.delete",
  "media.tags.assign",
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  // No plugin visibility query result changes what these tests assert.
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { items: [] } }),
      }),
    ),
  );
});

let catalog: ReturnType<typeof buildNavigationCatalog> | undefined;
let landing: string | undefined;

function Probe() {
  const navigation = useStudioNavigation();
  const current = buildNavigationCatalog(navigation);
  useEffect(() => {
    catalog = current;
    landing = navigation.destinations[0]?.to;
  });
  return null;
}

function renderNavigation() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SidebarNavigation />
        <StudioRoutesProvider routes={studioRoutes}>
          <StudioNavigationProvider>
            <Probe />
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

describe("a Media-only role", () => {
  it("shows Media in the sidebar and the native catalog, and nothing else", async () => {
    mockAuthAs("classroom_media", classroomMedia);
    renderNavigation();
    await screen.findByRole("link", { name: "Media" });

    const unrelated = [
      "Fleet",
      "Display Groups",
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
    ];
    for (const title of unrelated) {
      expect(
        screen.queryByRole("link", { name: title }),
        `${title} in the sidebar`,
      ).toBeNull();
      expect(catalogTitles(), `${title} in the native catalog`).not.toContain(
        title,
      );
    }
    // Both consumers read one model, so they agree.
    expect(sidebarTitles()).toEqual(catalogTitles());
    expect(catalogTitles()).toContain("Media");
  });

  it("lands on Media instead of an Overview it cannot use", async () => {
    mockAuthAs("classroom_media", classroomMedia);
    renderNavigation();
    await screen.findByRole("link", { name: "Media" });
    await waitFor(() => expect(landing).toBeDefined());
    expect(landing).toMatch(/assets|media/);
    expect(catalogTitles()?.[0]).toBe("Media");
  });

  it("gets the whole sidebar back when the role gains the capabilities", async () => {
    mockAuthAs("classroom_media", [
      ...classroomMedia,
      "playlist.read",
      "playlist.edit",
      "screen.read",
    ]);
    renderNavigation();
    await screen.findByRole("link", { name: "Playlists" });
    expect(screen.getByRole("link", { name: "Media" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Fleet" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Layouts" })).toBeNull();
  });
});

describe("direct route handling", () => {
  function renderAt(path: string) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const probe: RouteObject = {
      path: "*",
      element: (
        <RouteAccessGate>
          <p>route content</p>
        </RouteAccessGate>
      ),
    };
    const router = createMemoryRouter([probe], { initialEntries: [path] });
    // The gate reads the same route tree as the sidebar.
    return render(
      <QueryClientProvider client={client}>
        <StudioRoutesProvider routes={studioRoutes}>
          <StudioNavigationProvider>
            <RouterProvider router={router} />
          </StudioNavigationProvider>
        </StudioRoutesProvider>
      </QueryClientProvider>,
    );
  }

  it("refuses a typed address the role cannot use, and offers a way back", async () => {
    mockAuthAs("classroom_media", classroomMedia);
    renderAt("/playlists");
    expect(
      await screen.findByText(
        i18n.t("access.deniedTitle", { ns: "navigation" }),
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("route content")).toBeNull();
    expect(screen.getByRole("link", { name: /Media/ })).toBeInTheDocument();
  });

  it("refuses a nested address under a refused area", async () => {
    mockAuthAs("classroom_media", classroomMedia);
    renderAt("/screens/bulk");
    expect(
      await screen.findByText(
        i18n.t("access.deniedTitle", { ns: "navigation" }),
      ),
    ).toBeInTheDocument();
  });

  it("opens an address the role can use", async () => {
    mockAuthAs("classroom_media", classroomMedia);
    renderAt("/assets");
    expect(await screen.findByText("route content")).toBeInTheDocument();
  });

  it("opens every address for the built-in Owner", async () => {
    mockAuthAs("owner");
    renderAt("/playlists");
    expect(await screen.findByText("route content")).toBeInTheDocument();
  });
});

describe("command search", () => {
  const t = i18n.getFixedT("en", "navigation");

  it("offers a Media-only role Media and none of the other workspaces", () => {
    const results = buildCommandResults(
      studioRoutes,
      [],
      "",
      capabilitiesFrom(authStatusFor("classroom_media", classroomMedia)),
      [],
      t,
    );
    const destinations = results.map((result) => result.to ?? "");
    expect(destinations.some((to) => to.startsWith("/assets"))).toBe(true);
    for (const forbidden of [
      "/screens",
      "/playlists",
      "/layouts",
      "/schedules",
      "/settings",
      "/plugins",
    ]) {
      expect(
        destinations.filter(
          (to) => to === forbidden || to.startsWith(forbidden + "/"),
        ),
        forbidden,
      ).toEqual([]);
    }
  });
});

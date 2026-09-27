// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarNavigation } from "./Dashboard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type GrantedCapability =
  "manage" | "submit" | "view_own" | "view_all" | "review" | "approve";

/** Stub the Forms plugin's visibility query at the HTTP boundary. */
function stubFormsFetch(items: { grantedCapabilities: GrantedCapability[] }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { items } }),
      }),
    ),
  );
}

function renderNav(pathname = "/") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[pathname]}>
        <SidebarNavigation />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const summary = (capabilities: GrantedCapability[]) => ({
  id: "form-1",
  name: "Announcements",
  description: "",
  grantedCapabilities: capabilities,
  submissionCounts: { draft: 0, submitted: 0, changesRequested: 0, total: 0 },
});

describe("SidebarNavigation", () => {
  it("shows every primary destination as a direct route", () => {
    stubFormsFetch([summary(["submit"])]);
    renderNav();

    expect(
      screen.getByRole("link", { name: "Tilecast Overview" }),
    ).toBeTruthy();
    const routes = {
      Overview: "/",
      Fleet: "/screens",
      "Display Groups": "/groups",
      Media: "/assets",
      Widgets: "/widgets",
      "Data Sources": "/data-sources",
      Playlists: "/playlists",
      Layouts: "/layouts",
      Campaigns: "/campaigns",
      Schedules: "/schedules",
      Plugins: "/plugins",
      Activity: "/activity",
      Settings: "/settings",
    };
    for (const [destination, route] of Object.entries(routes)) {
      expect(screen.getByRole("link", { name: destination })).toHaveAttribute(
        "href",
        route,
      );
    }
    expect(screen.queryByRole("link", { name: "Archive" })).toBeNull();
    for (const group of ["Screens", "Content", "Presentations", "Operations"]) {
      expect(screen.getByText(group)).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: group })).toBeNull();
      expect(screen.queryByRole("button", { name: group })).toBeNull();
    }
    expect(screen.queryByRole("link", { name: "Approvals" })).toBeNull();
  });

  it("marks the matching nested destination active", () => {
    stubFormsFetch([]);
    renderNav("/widgets/widget-1");

    expect(screen.getByRole("link", { name: "Widgets" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Media" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("shows Approvals only when the user can review at least one form", async () => {
    stubFormsFetch([summary(["review"])]);
    renderNav();

    expect(await screen.findByRole("link", { name: "Approvals" })).toBeTruthy();
  });
});

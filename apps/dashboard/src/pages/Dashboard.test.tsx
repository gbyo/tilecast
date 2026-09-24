// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarNavigation } from "./Dashboard";
import { api } from "../api/client";
import type { FormSummary } from "../api/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

const summary = (
  capabilities: FormSummary["grantedCapabilities"],
): FormSummary => ({
  id: "form-1",
  name: "Announcements",
  description: "",
  grantedCapabilities: capabilities,
  submissionCounts: { draft: 0, submitted: 0, changesRequested: 0, total: 0 },
});

describe("SidebarNavigation", () => {
  it("shows every primary destination as a direct route", () => {
    vi.spyOn(api, "listForms").mockResolvedValue([summary(["submit"])]);
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
    vi.spyOn(api, "listForms").mockResolvedValue([]);
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
    vi.spyOn(api, "listForms").mockResolvedValue([summary(["review"])]);
    renderNav();

    expect(await screen.findByRole("link", { name: "Approvals" })).toBeTruthy();
  });
});

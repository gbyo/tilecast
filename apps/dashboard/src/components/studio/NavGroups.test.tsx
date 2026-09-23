// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarNavigation } from "../../pages/Dashboard";
import { api } from "../../api/client";
import type { FormSummary } from "../../api/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderNav(pathname = "/") {
  vi.spyOn(api, "listForms").mockResolvedValue([]);
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

describe("sidebar workspace groups", () => {
  it("keeps group children collapsed away from their routes", () => {
    renderNav("/");

    expect(screen.getByRole("link", { name: "Screens" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Content" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Presentations" }),
    ).toBeInTheDocument();
    for (const child of [
      "Fleet",
      "Display Groups",
      "Archive",
      "Media",
      "Widgets",
      "Data Sources",
      "Playlists",
      "Layouts",
      "Campaigns",
    ]) {
      expect(screen.queryByRole("link", { name: child })).toBeNull();
    }
  });

  it("auto-expands the group that owns the active route", () => {
    renderNav("/groups");

    const displayGroups = screen.getByRole("link", {
      name: "Display Groups",
    });
    expect(displayGroups).toBeInTheDocument();
    expect(displayGroups).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Fleet" })).toBeInTheDocument();
    // Sibling groups stay collapsed.
    expect(screen.queryByRole("link", { name: "Media" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Playlists" })).toBeNull();
  });

  it("expands Content for a nested widget editor route", () => {
    renderNav("/widgets/widget-1");

    expect(screen.getByRole("link", { name: "Widgets" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Media" })).toBeInTheDocument();
  });

  it("lets the user collapse an auto-expanded group", async () => {
    const user = userEvent.setup();
    renderNav("/assets");

    expect(screen.getByRole("link", { name: "Media" })).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Toggle Content submenu" }),
    );
    expect(screen.queryByRole("link", { name: "Media" })).toBeNull();
    // The parent stays a real link to the canonical route.
    expect(screen.getByRole("link", { name: "Content" })).toHaveAttribute(
      "href",
      "/assets",
    );
  });

  it("lets the user expand a group without navigating", async () => {
    const user = userEvent.setup();
    renderNav("/");

    await user.click(
      screen.getByRole("button", { name: "Toggle Screens submenu" }),
    );
    expect(screen.getByRole("link", { name: "Fleet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Archive" })).toHaveAttribute(
      "href",
      "/screens/archive",
    );
  });

  it("keeps Monitor and Manage in the content near the bottom, with only the user menu in the footer", () => {
    const { container } = renderNav("/");

    for (const label of ["Monitor", "Manage"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    const content = container.querySelector('[data-slot="sidebar-content"]');
    const footer = container.querySelector('[data-slot="sidebar-footer"]');
    expect(content).not.toBeNull();
    expect(footer).not.toBeNull();
    for (const name of ["Activity", "Settings"]) {
      const link = screen.getByRole("link", { name });
      expect(content).toContainElement(link);
      expect(footer).not.toContainElement(link);
    }
    // The footer holds the account menu trigger and nothing else navigational.
    expect(
      footer?.querySelector('[aria-label^="Open account menu"]'),
    ).not.toBeNull();
    expect(footer?.querySelectorAll("a[href]").length ?? 0).toBe(0);
  });
});

describe("sidebar capability gating", () => {
  it("still shows Approvals only when the user can review", async () => {
    const summary = (capabilities: FormSummary["grantedCapabilities"]) => ({
      id: "form-1",
      name: "Announcements",
      description: "",
      grantedCapabilities: capabilities,
      submissionCounts: {
        draft: 0,
        submitted: 0,
        changesRequested: 0,
        total: 0,
      },
    });
    vi.spyOn(api, "listForms").mockResolvedValue([summary(["review"])]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/"]}>
          <SidebarNavigation />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("link", { name: "Approvals" }),
    ).toHaveAttribute("href", "/approvals");
  });
});

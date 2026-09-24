// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

describe("static sidebar groups", () => {
  it("keeps every destination visible and category labels noninteractive", () => {
    renderNav();

    for (const destination of [
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
      "Settings",
    ]) {
      expect(screen.getByRole("link", { name: destination })).toBeVisible();
    }
    for (const group of ["Screens", "Content", "Presentations", "Operations"]) {
      expect(screen.getByText(group)).toBeVisible();
      expect(screen.queryByRole("link", { name: group })).toBeNull();
      expect(screen.queryByRole("button", { name: group })).toBeNull();
    }
    expect(
      screen.queryByRole("button", { name: /Toggle .* submenu/ }),
    ).toBeNull();
    expect(document.querySelector('[data-slot="sidebar-menu-sub"]')).toBeNull();
  });

  it("keeps Archive out of the sidebar and does not mark Fleet active there", () => {
    renderNav("/screens/archive");

    expect(screen.queryByRole("link", { name: "Archive" })).toBeNull();
    expect(screen.getByRole("link", { name: "Fleet" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("keeps Fleet active for a screen detail deep link", () => {
    renderNav("/screens/player-1");

    expect(screen.getByRole("link", { name: "Fleet" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("pushes secondary links to the bottom of SidebarContent and leaves only NavUser in the footer", () => {
    const { container } = renderNav();
    const content = container.querySelector('[data-slot="sidebar-content"]');
    const footer = container.querySelector('[data-slot="sidebar-footer"]');
    const secondaryGroup = content?.querySelector(".mt-auto");

    expect(content).not.toBeNull();
    expect(secondaryGroup).not.toBeNull();
    expect(secondaryGroup).toContainElement(
      screen.getByRole("link", { name: "Activity" }),
    );
    expect(secondaryGroup).toContainElement(
      screen.getByRole("link", { name: "Settings" }),
    );
    expect(footer).toContainElement(
      screen.getByRole("button", { name: /Open account menu/ }),
    );
    expect(footer?.querySelectorAll("a[href]")).toHaveLength(0);
    expect(footer?.className).not.toContain("border-t");
  });
});

describe("sidebar Approvals capability", () => {
  const summary = (
    capabilities: FormSummary["grantedCapabilities"],
  ): FormSummary => ({
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

  it("shows Approvals only when a form grants review", async () => {
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

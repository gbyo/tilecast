// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  it("collapses workspace facets when no child route is current", async () => {
    // A submitter-only form does not surface Approvals.
    vi.spyOn(api, "listForms").mockResolvedValue([summary(["submit"])]);
    renderNav();

    await waitFor(() => {
      expect(
        screen.getAllByRole("link").map((link) => link.textContent),
      ).toEqual([
        "Overview",
        "Screens",
        "Content",
        "Presentations",
        "Schedules",
        "Plugins",
        "Activity",
        "Settings",
      ]);
    });
    expect(
      screen
        .getByRole("link", { name: "Content" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen.getByLabelText("Content submenu").getAttribute("aria-hidden"),
    ).toBe("true");
    expect(screen.queryByRole("link", { name: "Media" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Compose" })).toBeNull();
  });

  it("expands Content and gives only the current child the active state", () => {
    vi.spyOn(api, "listForms").mockResolvedValue([]);
    // /widgets belongs to Content, and NavLink alone would not match it.
    renderNav("/widgets/widget-1");

    expect(
      screen
        .getByRole("link", { name: "Content" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      screen.getByRole("link", { name: "Content" }).className,
    ).not.toContain("active");
    expect(
      screen
        .getByRole("link", { name: "Widgets" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("link", { name: "Widgets" }).className).toContain(
      "active",
    );
    expect(screen.getByRole("link", { name: "Media" }).className).not.toContain(
      "active",
    );
    expect(screen.getByRole("link", { name: "Data" }).className).not.toContain(
      "active",
    );
    expect(
      screen
        .getByRole("link", { name: "Presentations" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("expands Presentations and highlights Layouts for a nested route", () => {
    vi.spyOn(api, "listForms").mockResolvedValue([]);
    renderNav("/layouts/layout-1");

    expect(
      screen
        .getByRole("link", { name: "Presentations" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      screen.getByRole("link", { name: "Presentations" }).className,
    ).not.toContain("active");
    expect(
      screen
        .getByRole("link", { name: "Layouts" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("link", { name: "Layouts" }).className).toContain(
      "active",
    );
    expect(
      screen.getByRole("link", { name: "Playlists" }).className,
    ).not.toContain("active");
    expect(
      screen
        .getByRole("link", { name: "Content" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("keeps labels available as native tooltips in compact mode", () => {
    vi.spyOn(api, "listForms").mockResolvedValue([]);
    renderNav("/assets");

    expect(
      screen.getByRole("link", { name: "Content" }).getAttribute("title"),
    ).toBe("Content");
    expect(
      screen.getByRole("link", { name: "Media" }).getAttribute("title"),
    ).toBe("Media");
  });

  it("keeps Settings in a dedicated footer region", () => {
    vi.spyOn(api, "listForms").mockResolvedValue([]);
    renderNav();

    expect(
      screen.getByRole("link", { name: "Settings" }).parentElement?.className,
    ).toBe("sidebar__nav-footer");
  });

  it("shows Approvals only when the user can review at least one form", async () => {
    vi.spyOn(api, "listForms").mockResolvedValue([summary(["review"])]);
    renderNav();

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Approvals" })).toBeTruthy();
    });
  });
});

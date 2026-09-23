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
  it("shows the main workspace destinations", () => {
    vi.spyOn(api, "listForms").mockResolvedValue([summary(["submit"])]);
    renderNav();

    expect(
      screen.getByRole("link", { name: "Tilecast Overview" }),
    ).toBeTruthy();
    for (const destination of [
      "Overview",
      "Screens",
      "Content",
      "Presentations",
      "Schedules",
      "Plugins",
      "Activity",
      "Settings",
    ]) {
      expect(screen.getByRole("link", { name: destination })).toBeTruthy();
    }
    expect(screen.queryByRole("link", { name: "Approvals" })).toBeNull();
  });

  it("marks Content active for its nested editor routes", () => {
    vi.spyOn(api, "listForms").mockResolvedValue([]);
    renderNav("/widgets/widget-1");

    expect(screen.getByRole("link", { name: "Content" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("link", { name: "Presentations" }),
    ).not.toHaveAttribute("aria-current", "page");
  });

  it("marks Presentations active for a nested Layout route", () => {
    vi.spyOn(api, "listForms").mockResolvedValue([]);
    renderNav("/layouts/layout-1");

    expect(screen.getByRole("link", { name: "Presentations" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("shows Approvals only when the user can review at least one form", async () => {
    vi.spyOn(api, "listForms").mockResolvedValue([summary(["review"])]);
    renderNav();

    expect(await screen.findByRole("link", { name: "Approvals" })).toBeTruthy();
  });

  it("keeps the main destination labels visible", () => {
    vi.spyOn(api, "listForms").mockResolvedValue([]);
    renderNav("/assets");

    expect(
      screen.getByRole("link", { name: "Tilecast Overview" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Content" })).toHaveTextContent(
      "Content",
    );
  });
});

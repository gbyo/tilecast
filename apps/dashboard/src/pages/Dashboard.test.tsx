// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { FormSummary } from "../api/types";
import { AppSidebar, SidebarNavigation } from "../components/AppSidebar";
import { SidebarProvider } from "../components/ui/sidebar";
import { TooltipProvider } from "../components/ui/tooltip";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function renderWithSidebar(children: React.ReactNode, pathname = "/") {
  installMatchMedia();
  window.innerWidth = 1200;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[pathname]}>
        <TooltipProvider>
          <SidebarProvider>{children}</SidebarProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderNav(pathname = "/") {
  return renderWithSidebar(<SidebarNavigation />, pathname);
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
  it("exposes content and presentation destinations directly in sidebar groups", async () => {
    vi.spyOn(api, "listForms").mockResolvedValue([summary(["submit"])]);
    renderNav();

    expect(screen.getByText("Studio")).toBeTruthy();
    expect(screen.getByText("Content")).toBeTruthy();
    expect(screen.getByText("Presentations")).toBeTruthy();
    expect(screen.getByText("System")).toBeTruthy();

    expect(screen.getByRole("link", { name: "Media" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Widgets" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Data" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Playlists" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Layouts" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Campaigns" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Schedules" })).toBeTruthy();

    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "Approvals" })).toBeNull();
    });
  });

  it("marks the current content destination active for nested routes", () => {
    vi.spyOn(api, "listForms").mockResolvedValue([]);
    renderNav("/widgets/widget-1");

    expect(
      screen
        .getByRole("link", { name: "Widgets" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("marks the current presentation destination active for nested routes", () => {
    vi.spyOn(api, "listForms").mockResolvedValue([]);
    renderNav("/layouts/layout-1");

    expect(
      screen
        .getByRole("link", { name: "Layouts" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("link", { name: "Campaigns" })).toBeTruthy();
  });

  it("shows Approvals only when the user can review at least one form", async () => {
    vi.spyOn(api, "listForms").mockResolvedValue([summary(["review"])]);
    renderNav();

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Approvals" })).toBeTruthy();
    });
  });

  it("keeps Settings in the System group and the account menu in the footer", () => {
    vi.spyOn(api, "listForms").mockResolvedValue([]);
    renderWithSidebar(
      <AppSidebar
        user={{
          id: "user-1",
          name: "Gibson Bell",
          email: "gibson@example.com",
          role: "owner",
        }}
        signingOut={false}
        onLogout={() => {}}
      />,
    );

    const settings = screen.getByRole("link", { name: "Settings" });
    expect(settings.closest('[data-sidebar="footer"]')).toBeNull();
    expect(settings.closest('[data-sidebar="group"]')?.textContent).toContain(
      "System",
    );
    expect(
      screen
        .getByRole("button", { name: /Gibson Bell/i })
        .closest('[data-sidebar="footer"]'),
    ).toBeTruthy();
  });
});

// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  it("keeps workspace facets collapsed away from their routes", async () => {
    vi.spyOn(api, "listForms").mockResolvedValue([summary(["submit"])]);
    renderNav();

    expect(
      screen.getByRole("button", { name: "Content" }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "Presentations" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.queryByRole("link", { name: "Media" })).toBeNull();

    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "Approvals" })).toBeNull();
    });
  });

  it("opens Content for nested content routes and marks the current facet", () => {
    vi.spyOn(api, "listForms").mockResolvedValue([]);
    renderNav("/widgets/widget-1");

    expect(
      screen.getByRole("button", { name: "Content" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      screen
        .getByRole("link", { name: "Widgets" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("button", { name: "Presentations" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("opens Presentations for nested presentation routes", () => {
    vi.spyOn(api, "listForms").mockResolvedValue([]);
    renderNav("/layouts/layout-1");

    expect(
      screen
        .getByRole("button", { name: "Presentations" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      screen
        .getByRole("link", { name: "Layouts" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("link", { name: "Campaigns" })).toBeTruthy();
  });

  it("uses the Base UI collapsible interaction for workspace groups", async () => {
    vi.spyOn(api, "listForms").mockResolvedValue([]);
    const user = userEvent.setup();
    renderNav();

    const content = screen.getByRole("button", { name: "Content" });
    expect(content.getAttribute("aria-expanded")).toBe("false");

    await user.click(content);

    expect(content.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Media" })).toBeTruthy();
  });

  it("shows Approvals only when the user can review at least one form", async () => {
    vi.spyOn(api, "listForms").mockResolvedValue([summary(["review"])]);
    renderNav();

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Approvals" })).toBeTruthy();
    });
  });

  it("keeps Settings in the shadcn sidebar footer", () => {
    vi.spyOn(api, "listForms").mockResolvedValue([]);
    renderWithSidebar(
      <AppSidebar user={undefined} signingOut={false} onLogout={() => {}} />,
    );

    expect(
      screen
        .getByRole("link", { name: "Settings" })
        .closest('[data-sidebar="footer"]'),
    ).toBeTruthy();
  });
});

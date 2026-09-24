// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { SidebarProvider } from "../ui/sidebar";
import { SiteHeader, type StudioBreadcrumb } from "./SiteHeader";

afterEach(cleanup);

function renderHeader(breadcrumbs: StudioBreadcrumb[]) {
  return render(
    <MemoryRouter>
      <SidebarProvider>
        <SiteHeader
          breadcrumbs={breadcrumbs}
          notifications={{ count: 0, items: [], topPriority: null }}
          onSearch={() => {}}
        />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

describe("SiteHeader", () => {
  it("links ancestors and leaves the current page unlinked", () => {
    renderHeader([
      { label: "Settings", to: "/settings" },
      { label: "General", to: "/settings/general" },
    ]);

    const nav = screen.getByRole("navigation", { name: "breadcrumb" });
    const links = [...nav.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/settings",
    ]);
    expect(
      screen.getByText("General", { selector: '[aria-current="page"]' })
        .className,
    ).not.toContain("font-semibold");
  });

  it("renders a single breadcrumb as the current page", () => {
    renderHeader([{ label: "Layouts", to: "/layouts" }]);

    const nav = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(nav.textContent).toBe("Layouts");
    expect(nav.querySelector("a")).toBeNull();
    const current = screen.getByText("Layouts", {
      selector: '[aria-current="page"]',
    });
    expect(current.className).toContain("font-semibold");
  });

  it("omits the breadcrumb landmark only when there are no breadcrumbs", () => {
    renderHeader([]);

    expect(screen.queryByRole("navigation", { name: "breadcrumb" })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Search Tilecast/ }),
    ).toBeTruthy();
  });
});

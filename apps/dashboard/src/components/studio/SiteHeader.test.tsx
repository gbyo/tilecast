// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { SidebarProvider } from "../ui/sidebar";
import {
  EditorHeaderProvider,
  useEditorHeaderRename,
  useEditorHeaderTitle,
} from "./EditorHeaderSlots";
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

  it("shows an editor's draft name in the last breadcrumb only", async () => {
    // The rename handler must be stable: a new function on every render would
    // re-register it on every render and never settle.
    const rename = vi.fn();
    function Draft({ title }: { title: string }) {
      useEditorHeaderTitle(title);
      useEditorHeaderRename(rename);
      return null;
    }
    const breadcrumbs = [
      { label: "Widgets", to: "/widgets" },
      { label: "Create widget", to: "/widgets/new/countdown" },
    ];
    const view = render(
      <MemoryRouter>
        <SidebarProvider>
          <EditorHeaderProvider>
            <SiteHeader
              editor
              breadcrumbs={breadcrumbs}
              notifications={{ count: 0, items: [], topPriority: null }}
              onSearch={() => {}}
            />
            <Draft title="New Countdown" />
          </EditorHeaderProvider>
        </SidebarProvider>
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation", { name: "breadcrumb" });
    const title = await screen.findByRole("button", { name: "New Countdown" });
    expect(nav.querySelector("a")?.textContent).toBe("Widgets");
    // The draft name is a real button that marks the current page. It is not
    // inside the disabled link BreadcrumbPage renders, which would read as a
    // disabled control and nest one interactive element in another.
    expect(title).toHaveAttribute("aria-current", "page");
    expect(title).toHaveAttribute("aria-haspopup", "dialog");
    expect(title.closest("[aria-disabled]")).toBeNull();
    expect(title.closest('[role="link"]')).toBeNull();
    fireEvent.click(title);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(breadcrumbs[1]!.label).toBe("Create widget");
    view.unmount();
  });
});

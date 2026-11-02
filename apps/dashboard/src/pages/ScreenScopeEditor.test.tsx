// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScreenScopeEditor } from "./ScreenScopeEditor";
import { api } from "../api/client";
import { i18n } from "../i18n";
import { builtinMyAccess } from "../test/capabilities";

function renderEditor(userRole = "editor") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ScreenScopeEditor userId="user-2" userRole={userRole} csrf="csrf" />
    </QueryClientProvider>,
  );
}

describe("ScreenScopeEditor", () => {
  beforeEach(() => {
    vi.spyOn(api, "userScreenScopes").mockResolvedValue({
      mode: "all",
      scopes: [],
      configured: true,
      wholeFleet: true,
    });
    vi.spyOn(api, "myAccess").mockResolvedValue(
      builtinMyAccess("administrator"),
    );
  });
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await i18n.changeLanguage("en");
  });

  it("shows the owner note without any scope controls", async () => {
    vi.spyOn(api, "locations").mockResolvedValue({ items: [] } as never);
    vi.spyOn(api, "screenGroups").mockResolvedValue({ items: [] } as never);
    renderEditor("owner");
    expect(
      await screen.findByText("Owner access applies to the entire fleet."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save screen access" }),
    ).toBeNull();
  });

  it("filters large scope lists by search", async () => {
    vi.spyOn(api, "locations").mockResolvedValue({
      items: Array.from({ length: 9 }, (_, index) => ({
        id: `loc-${index}`,
        name: index === 0 ? "North Library" : `Building ${index}`,
      })),
    } as never);
    vi.spyOn(api, "screenGroups").mockResolvedValue({ items: [] } as never);
    renderEditor();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("radio", {
        name: "Only selected locations and Display Groups",
      }),
    );
    const search = await screen.findByRole("searchbox", {
      name: "Search places",
    });
    await user.type(search, "library");
    expect(
      await screen.findByRole("checkbox", { name: "North Library" }),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Building 1" })).toBeNull();

    await user.clear(search);
    await user.type(search, "nothing matches this");
    expect(
      await screen.findAllByText("No places match this search."),
    ).toHaveLength(2);
  });

  it("hides search when the scope list is small", async () => {
    vi.spyOn(api, "locations").mockResolvedValue({
      items: [{ id: "loc-1", name: "Library" }],
    } as never);
    vi.spyOn(api, "screenGroups").mockResolvedValue({
      items: [{ id: "group-1", name: "North Wing" }],
    } as never);
    renderEditor();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("radio", {
        name: "Only selected locations and Display Groups",
      }),
    );
    expect(
      await screen.findByRole("checkbox", { name: "Library" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("searchbox", { name: "Search places" }),
    ).toBeNull();
  });

  it("saves the selected scopes", async () => {
    vi.spyOn(api, "locations").mockResolvedValue({
      items: [{ id: "loc-1", name: "Library" }],
    } as never);
    vi.spyOn(api, "screenGroups").mockResolvedValue({ items: [] } as never);
    const save = vi.spyOn(api, "putUserScreenScopes").mockResolvedValue({
      mode: "restricted",
      scopes: [{ type: "location", id: "loc-1" }],
      configured: true,
      wholeFleet: false,
    });
    renderEditor();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("radio", {
        name: "Only selected locations and Display Groups",
      }),
    );
    await user.click(await screen.findByRole("checkbox", { name: "Library" }));
    await user.click(
      screen.getByRole("button", { name: "Save screen access" }),
    );

    expect(save).toHaveBeenCalledWith(
      "user-2",
      { mode: "restricted", scopes: [{ type: "location", id: "loc-1" }] },
      "csrf",
    );
    expect(await screen.findByText("Screen access saved.")).toBeTruthy();
  });

  it("fails safe when the scope load fails: no access claim, no save", async () => {
    vi.spyOn(api, "userScreenScopes").mockRejectedValue(new Error("boom"));
    vi.spyOn(api, "locations").mockResolvedValue({ items: [] } as never);
    vi.spyOn(api, "screenGroups").mockResolvedValue({ items: [] } as never);
    renderEditor();

    expect(
      await screen.findByText(/Screen access could not be loaded/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save screen access" }),
    ).toBeNull();
    expect(screen.queryByText("All screens")).toBeNull();
    expect(
      screen.queryByText("Only selected locations and Display Groups"),
    ).toBeNull();
  });

  it("fails safe when the location catalog fails", async () => {
    vi.spyOn(api, "locations").mockRejectedValue(new Error("boom"));
    vi.spyOn(api, "screenGroups").mockResolvedValue({ items: [] } as never);
    renderEditor();

    expect(
      await screen.findByText(/Screen access could not be loaded/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save screen access" }),
    ).toBeNull();
  });

  it("saves restricted access with nothing selected as no screens, never the fleet", async () => {
    vi.spyOn(api, "locations").mockResolvedValue({
      items: [{ id: "loc-1", name: "Library" }],
    } as never);
    vi.spyOn(api, "screenGroups").mockResolvedValue({ items: [] } as never);
    const save = vi.spyOn(api, "putUserScreenScopes").mockResolvedValue({
      mode: "restricted",
      scopes: [],
      configured: true,
      wholeFleet: false,
    });
    renderEditor();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("radio", {
        name: "Only selected locations and Display Groups",
      }),
    );
    expect(
      await screen.findByText(
        "Nothing is selected, so this account reaches no screens.",
      ),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Save screen access" }),
    );
    expect(save).toHaveBeenCalledWith(
      "user-2",
      { mode: "restricted", scopes: [] },
      "csrf",
    );
  });

  it("reads the mode from the server, not from the number of grants", async () => {
    vi.spyOn(api, "userScreenScopes").mockResolvedValue({
      mode: "restricted",
      scopes: [],
      configured: true,
      wholeFleet: false,
    });
    vi.spyOn(api, "locations").mockResolvedValue({ items: [] } as never);
    vi.spyOn(api, "screenGroups").mockResolvedValue({ items: [] } as never);
    renderEditor();
    expect(
      await screen.findByRole("radio", {
        name: "Only selected locations and Display Groups",
      }),
    ).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "All screens" }),
    ).not.toBeChecked();
  });

  it("explains an account without a saved policy", async () => {
    vi.spyOn(api, "userScreenScopes").mockResolvedValue({
      mode: "restricted",
      scopes: [],
      configured: false,
      wholeFleet: false,
    });
    vi.spyOn(api, "locations").mockResolvedValue({ items: [] } as never);
    vi.spyOn(api, "screenGroups").mockResolvedValue({ items: [] } as never);
    renderEditor();
    expect(await screen.findByText(/has no saved screen access/)).toBeTruthy();
  });

  it("saves explicit all-screens access with no grants", async () => {
    vi.spyOn(api, "userScreenScopes").mockResolvedValue({
      mode: "restricted",
      scopes: [{ type: "location", id: "loc-1" }],
      configured: true,
      wholeFleet: false,
    });
    vi.spyOn(api, "locations").mockResolvedValue({
      items: [{ id: "loc-1", name: "Library" }],
    } as never);
    vi.spyOn(api, "screenGroups").mockResolvedValue({ items: [] } as never);
    const save = vi.spyOn(api, "putUserScreenScopes").mockResolvedValue({
      mode: "all",
      scopes: [],
      configured: true,
      wholeFleet: true,
    });
    renderEditor();
    const user = userEvent.setup();

    // Saved grants start restricted with the grant checked.
    expect(
      await screen.findByRole("checkbox", { name: "Library" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "All screens" }));
    await user.click(
      screen.getByRole("button", { name: "Save screen access" }),
    );

    expect(save).toHaveBeenCalledWith(
      "user-2",
      { mode: "all", scopes: [] },
      "csrf",
    );
  });

  it("offers only its own grants when the editor's access is restricted", async () => {
    vi.spyOn(api, "myAccess").mockResolvedValue({
      ...builtinMyAccess("administrator"),
      screens: { mode: "restricted", locationIds: ["loc-1"], groupIds: [] },
    });
    vi.spyOn(api, "locations").mockResolvedValue({
      items: [
        { id: "loc-1", name: "Library" },
        { id: "loc-2", name: "Gym" },
      ],
    } as never);
    vi.spyOn(api, "screenGroups").mockResolvedValue({ items: [] } as never);
    renderEditor();
    expect(
      await screen.findByRole("radio", { name: "All screens" }),
    ).toHaveAttribute("aria-disabled", "true");
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("radio", {
        name: "Only selected locations and Display Groups",
      }),
    );
    expect(
      await screen.findByRole("checkbox", { name: "Library" }),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Gym" })).toBeNull();
  });
});

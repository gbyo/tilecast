// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScreenScopeEditor } from "./ScreenScopeEditor";
import { api } from "../api/client";
import { i18n } from "../i18n";

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
      scopes: [],
      wholeFleet: true,
    });
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
      screen.queryByRole("button", { name: "Save screen scope" }),
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
      await screen.findByRole("radio", { name: "Limit access" }),
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
      await screen.findByRole("radio", { name: "Limit access" }),
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
      scopes: [{ type: "location", id: "loc-1" }],
      wholeFleet: false,
    });
    renderEditor();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("radio", { name: "Limit access" }),
    );
    await user.click(await screen.findByRole("checkbox", { name: "Library" }));
    await user.click(screen.getByRole("button", { name: "Save screen scope" }));

    expect(save).toHaveBeenCalledWith(
      "user-2",
      [{ type: "location", id: "loc-1" }],
      "csrf",
    );
    expect(await screen.findByText("Screen scope saved.")).toBeTruthy();
  });

  it("fails safe when the scope load fails: no access claim, no save", async () => {
    vi.spyOn(api, "userScreenScopes").mockRejectedValue(new Error("boom"));
    vi.spyOn(api, "locations").mockResolvedValue({ items: [] } as never);
    vi.spyOn(api, "screenGroups").mockResolvedValue({ items: [] } as never);
    renderEditor();

    expect(
      await screen.findByText(/Screen scope could not be loaded/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save screen scope" }),
    ).toBeNull();
    expect(screen.queryByText("Full fleet access")).toBeNull();
    expect(screen.queryByText("Limit access")).toBeNull();
  });

  it("fails safe when the location catalog fails", async () => {
    vi.spyOn(api, "locations").mockRejectedValue(new Error("boom"));
    vi.spyOn(api, "screenGroups").mockResolvedValue({ items: [] } as never);
    renderEditor();

    expect(
      await screen.findByText(/Screen scope could not be loaded/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save screen scope" }),
    ).toBeNull();
  });

  it("refuses to save a limited scope with nothing selected", async () => {
    vi.spyOn(api, "locations").mockResolvedValue({
      items: [{ id: "loc-1", name: "Library" }],
    } as never);
    vi.spyOn(api, "screenGroups").mockResolvedValue({ items: [] } as never);
    const save = vi.spyOn(api, "putUserScreenScopes").mockResolvedValue({
      scopes: [],
      wholeFleet: true,
    });
    renderEditor();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("radio", { name: "Limit access" }),
    );
    expect(
      await screen.findByText(/Select at least one location/),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Save screen scope" }),
    ).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
  });

  it("saves an empty grant list for explicit full fleet access", async () => {
    vi.spyOn(api, "userScreenScopes").mockResolvedValue({
      scopes: [{ type: "location", id: "loc-1" }],
      wholeFleet: false,
    });
    vi.spyOn(api, "locations").mockResolvedValue({
      items: [{ id: "loc-1", name: "Library" }],
    } as never);
    vi.spyOn(api, "screenGroups").mockResolvedValue({ items: [] } as never);
    const save = vi.spyOn(api, "putUserScreenScopes").mockResolvedValue({
      scopes: [],
      wholeFleet: true,
    });
    renderEditor();
    const user = userEvent.setup();

    // Saved grants start limited with the grant checked.
    expect(
      await screen.findByRole("checkbox", { name: "Library" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Full fleet access" }));
    await user.click(screen.getByRole("button", { name: "Save screen scope" }));

    expect(save).toHaveBeenCalledWith("user-2", [], "csrf");
  });
});

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardListToolbar, DashboardSearch } from "./DashboardListToolbar";

afterEach(() => {
  cleanup();
});

describe("DashboardListToolbar", () => {
  it("renders the toolbar composition with an accessible search field", () => {
    const { container } = render(
      <DashboardListToolbar>
        <DashboardSearch
          value=""
          onValueChange={() => undefined}
          label="Search Widgets"
          placeholder="Search Widgets"
        />
      </DashboardListToolbar>,
    );

    expect(container.querySelector('[data-slot="input-group"]')).not.toBeNull();
    expect(screen.getByRole("searchbox").getAttribute("placeholder")).toBe(
      "Search Widgets",
    );
    expect(screen.getByRole("searchbox").getAttribute("aria-label")).toBe(
      "Search Widgets",
    );
  });

  it("clears the current search value", () => {
    const onValueChange = vi.fn();
    render(
      <DashboardSearch
        value="clock"
        onValueChange={onValueChange}
        label="Search Widgets"
        placeholder="Search Widgets"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Clear search widgets" }),
    );
    expect(onValueChange).toHaveBeenCalledWith("");
  });

  it("hides the clear button when the search is empty", () => {
    render(
      <DashboardSearch
        value=""
        onValueChange={() => undefined}
        label="Search Widgets"
        placeholder="Search Widgets"
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Clear search widgets" }),
    ).toBeNull();
  });
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { UsedByPanel, type UsedByGroup } from "./UsedByPanel";

afterEach(cleanup);

function panel(groups: UsedByGroup[], emptyMessage?: string, compact = false) {
  return render(
    <MemoryRouter>
      <UsedByPanel
        groups={groups}
        emptyMessage={emptyMessage}
        compact={compact}
      />
    </MemoryRouter>,
  );
}

describe("UsedByPanel", () => {
  it("links every consumer so the dependency graph can be walked", () => {
    panel([
      {
        label: "Widgets",
        items: [{ id: "w1", name: "Today's Lunch" }],
        to: (id) => `/widgets/${id}`,
      },
      {
        label: "Layout text bindings",
        items: [{ id: "l1", name: "Cafeteria Layout", hint: "lunch_option" }],
        to: (id) => `/layouts/${id}`,
      },
    ]);

    expect(screen.getByRole("link", { name: /Today's Lunch/ })).toHaveAttribute(
      "href",
      "/widgets/w1",
    );
    const binding = screen.getByRole("link", { name: /Cafeteria Layout/ });
    expect(binding).toHaveAttribute("href", "/layouts/l1");
    expect(binding).toHaveTextContent("lunch_option");
  });

  it("explains an unused record rather than rendering an empty panel", () => {
    panel(
      [{ label: "Widgets", items: [], to: (id) => `/widgets/${id}` }],
      "No Widget reads this Data Source yet.",
    );

    expect(
      screen.getByText("No Widget reads this Data Source yet."),
    ).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("hides groups that have no entries but keeps the ones that do", () => {
    panel([
      { label: "Playlists", items: [], to: (id) => `/playlists/${id}` },
      {
        label: "Layouts",
        items: [{ id: "l1", name: "Lobby" }],
        to: (id) => `/layouts/${id}`,
      },
    ]);

    expect(screen.queryByText("Playlists")).toBeNull();
    expect(screen.getByText("Layouts")).toBeTruthy();
  });

  // A Layout can bind several fields of one Data Source, so the same record id repeats within a
  // group. Rendering must not collapse or duplicate-key those rows.
  it("renders one row per binding when a record appears more than once", () => {
    panel([
      {
        label: "Layout text bindings",
        items: [
          { id: "l1", name: "Cafeteria", hint: "option_1" },
          { id: "l1", name: "Cafeteria", hint: "option_2" },
        ],
        to: (id) => `/layouts/${id}`,
      },
    ]);

    const rows = screen.getAllByRole("link", { name: /Cafeteria/ });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("option_1");
    expect(rows[1]).toHaveTextContent("option_2");
  });

  it("renders entries that are not separately addressable as plain text", () => {
    panel([{ label: "Screens", items: [{ id: "s1", name: "Cafeteria TV" }] }]);

    expect(screen.getByText("Cafeteria TV")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("summarizes large usage groups behind expandable counts", async () => {
    panel(
      [
        {
          label: "Screens",
          items: [
            { id: "s1", name: "Cafeteria TV" },
            { id: "s2", name: "Lobby TV" },
          ],
          to: (id) => `/screens/${id}`,
        },
        {
          label: "Schedules",
          items: [{ id: "sc1", name: "Weekdays" }],
          to: (id) => `/schedules/${id}`,
        },
      ],
      undefined,
      true,
    );

    const user = userEvent.setup();
    const outer = screen.getByRole("button", { name: /Used by/ });
    expect(outer).toHaveTextContent("3");
    expect(outer).toHaveAttribute("aria-expanded", "false");
    await user.click(outer);
    const screenSummary = screen.getByRole("button", { name: /^Screens/ });
    expect(screenSummary).toHaveTextContent("2");
    expect(screenSummary).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: /^Schedules/ }),
    ).toHaveTextContent("1");
    await user.click(screen.getByRole("button", { name: /^Screens/ }));
    expect(screen.getByRole("link", { name: /Cafeteria TV/ })).toHaveAttribute(
      "href",
      "/screens/s1",
    );
  });
});

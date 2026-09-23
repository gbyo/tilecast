// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

afterEach(cleanup);

function menu(items: ContextMenuItem[], onClose = () => {}) {
  return render(
    <ContextMenu
      x={10}
      y={10}
      label="Test actions"
      items={items}
      onClose={onClose}
    />,
  );
}

describe("ContextMenu submenus", () => {
  const bringToFront = vi.fn();

  it("keeps grouped commands behind their parent row until it is opened", async () => {
    const user = userEvent.setup();
    menu([
      { label: "Copy", onSelect: () => {} },
      {
        label: "Arrange",
        submenu: [{ label: "Bring to front", onSelect: bringToFront }],
      },
    ]);

    expect(screen.queryByText("Bring to front")).not.toBeInTheDocument();
    await user.hover(screen.getByText("Arrange"));
    expect(screen.getByRole("menu", { name: "Arrange" })).toBeInTheDocument();
    expect(screen.getByText("Bring to front")).toBeInTheDocument();
  });

  it("closes the whole menu when a submenu command runs", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelect = vi.fn();
    menu(
      [{ label: "Arrange", submenu: [{ label: "Send to back", onSelect }] }],
      onClose,
    );

    await user.hover(screen.getByText("Arrange"));
    await user.click(screen.getByText("Send to back"));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens a submenu with ArrowRight and returns with ArrowLeft", async () => {
    const user = userEvent.setup();
    menu([
      {
        label: "Arrange",
        submenu: [
          { label: "Bring forward", onSelect: () => {} },
          { label: "Send backward", onSelect: () => {} },
        ],
      },
    ]);

    const parent = screen.getByRole("menuitem", { name: "Arrange" });
    expect(parent).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("menuitem", { name: "Bring forward" }),
    ).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByRole("menuitem", { name: "Send backward" }),
    ).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.queryByText("Bring forward")).not.toBeInTheDocument();
    expect(parent).toHaveFocus();
  });

  it("still runs a plain command and skips disabled rows when arrowing", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    menu(
      [
        { label: "Copy", onSelect },
        { label: "Paste", onSelect: () => {}, disabled: true },
        { label: "Delete", onSelect: () => {}, danger: true },
      ],
      onClose,
    );

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    await user.click(screen.getByText("Copy"));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ContextMenu focus navigation", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button">Before</button>
        <button type="button" onClick={() => setOpen(true)}>
          Actions
        </button>
        <button type="button">After</button>
        {open && (
          <ContextMenu
            x={10}
            y={10}
            label="Actions"
            items={[{ label: "Edit", onSelect: () => {} }]}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    );
  }

  it("lets Tab continue past the opener after dismissing the menu", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();

    await user.tab();

    expect(screen.queryByRole("menu", { name: "Actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  });

  it("lets Shift+Tab continue before the opener after dismissing the menu", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();

    await user.tab({ shift: true });

    expect(screen.queryByRole("menu", { name: "Actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Before" })).toHaveFocus();
  });
});

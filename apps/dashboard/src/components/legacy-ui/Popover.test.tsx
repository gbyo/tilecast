// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { Popover } from "./Popover";
import { Select } from "./SignalSelect";

afterEach(cleanup);

function FilterPopover({
  onOpenChange,
}: {
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Popover
      label="Filter assets"
      onOpenChange={onOpenChange}
      trigger={(props) => (
        <button type="button" {...props}>
          Filters
        </button>
      )}
    >
      {(close) => (
        <>
          <label>
            Status
            <Select aria-label="Status">
              <option value="ready">Ready</option>
              <option value="failed">Failed</option>
            </Select>
          </label>
          <input aria-label="Name" />
          <button type="button" onClick={close}>
            Clear
          </button>
        </>
      )}
    </Popover>
  );
}

function CreateMenu() {
  return (
    <Popover
      label="Create"
      mode="menu"
      trigger={(props) => (
        <button type="button" {...props}>
          Create
        </button>
      )}
    >
      {(close) => (
        <>
          <button type="button" role="menuitem" onClick={close}>
            Upload media
          </button>
          <button type="button" role="menuitem" onClick={close}>
            Create widget
          </button>
          <button type="button" role="menuitem" onClick={close}>
            Create playlist
          </button>
        </>
      )}
    </Popover>
  );
}

function router(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("Popover trigger semantics", () => {
  it("reports its collapsed and expanded state on the trigger", async () => {
    const user = userEvent.setup();
    router(<FilterPopover />);
    const trigger = screen.getByRole("button", { name: "Filters" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute(
      "aria-controls",
      screen.getByRole("dialog", { name: "Filter assets" }).id,
    );
  });

  it("uses menu semantics only in menu mode", async () => {
    const user = userEvent.setup();
    router(<CreateMenu />);
    const trigger = screen.getByRole("button", { name: "Create" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");

    await user.click(trigger);
    expect(screen.getByRole("menu", { name: "Create" })).toBeInTheDocument();
  });

  it("does not claim menu semantics for a panel of form controls", async () => {
    const user = userEvent.setup();
    router(<FilterPopover />);

    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("dialog", { name: "Filter assets" })).toBeVisible();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("Popover dismissal", () => {
  it("closes on a pointer press outside it", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    router(
      <>
        <FilterPopover onOpenChange={onOpenChange} />
        <button type="button">Elsewhere</button>
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    router(<FilterPopover />);
    const trigger = screen.getByRole("button", { name: "Filters" });

    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes when the trigger is activated again", async () => {
    const user = userEvent.setup();
    router(<FilterPopover />);
    const trigger = screen.getByRole("button", { name: "Filters" });

    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes when a second popover opens, without either coordinating", async () => {
    const user = userEvent.setup();
    router(
      <>
        <FilterPopover />
        <CreateMenu />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(
      screen.getByRole("dialog", { name: "Filter assets" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Create" })).toBeInTheDocument();
  });

  it("does not outlive the page its trigger belonged to", async () => {
    const user = userEvent.setup();
    function Leave() {
      const navigate = useNavigate();
      return (
        <>
          <FilterPopover />
          <button type="button" onClick={() => void navigate("/elsewhere")}>
            Go
          </button>
        </>
      );
    }
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Leave />} />
          <Route path="/elsewhere" element={<Leave />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Popover placement", () => {
  // The rect stub below is global to the DOM, so it must not outlive this block.
  afterEach(() => vi.restoreAllMocks());

  /**
   * The panel is `position: fixed` with `top: 0` as its pre-measurement origin.
   * A flipped panel that kept that `top` while also setting `bottom` would have
   * both vertical edges anchored, and an auto height stretches to fill between
   * them — the sidebar account menu, which sits at the bottom of the viewport and
   * therefore always flips, filled the whole screen.
   */
  it("anchors only one vertical edge when it flips above its trigger", async () => {
    const user = userEvent.setup();
    // A trigger at the bottom of the viewport, with a panel too tall to fit below.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      top: 700,
      bottom: 730,
      left: 12,
      right: 60,
      width: 48,
      height: 120,
      x: 12,
      y: 700,
      toJSON: () => ({}),
    });
    router(<CreateMenu />);

    await user.click(screen.getByRole("button", { name: "Create" }));

    const panel = screen.getByRole("menu");
    expect(panel.style.bottom).not.toBe("");
    expect(panel.style.top).toBe("auto");
  });
});

describe("Popover keyboard contract", () => {
  it("moves focus into a form panel, because the panel is not next in document order", async () => {
    const user = userEvent.setup();
    router(<FilterPopover />);

    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveFocus();
  });

  it("cycles Tab within a form panel rather than stranding focus on the page", async () => {
    const user = userEvent.setup();
    router(<FilterPopover />);

    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Clear" })).toHaveFocus();
    // Past the last control, focus returns to the first rather than jumping to
    // whatever the portal host happens to hold next.
    await user.tab();
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveFocus();
  });

  it("walks menu items with the arrow keys and wraps at both ends", async () => {
    const user = userEvent.setup();
    router(<CreateMenu />);

    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(
      screen.getByRole("menuitem", { name: "Upload media" }),
    ).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByRole("menuitem", { name: "Create widget" }),
    ).toHaveFocus();

    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(
      screen.getByRole("menuitem", { name: "Create playlist" }),
    ).toHaveFocus();

    await user.keyboard("{Home}");
    expect(
      screen.getByRole("menuitem", { name: "Upload media" }),
    ).toHaveFocus();

    await user.keyboard("{End}");
    expect(
      screen.getByRole("menuitem", { name: "Create playlist" }),
    ).toHaveFocus();
  });

  it("opens a menu from the trigger with the arrow keys", async () => {
    const user = userEvent.setup();
    router(<CreateMenu />);

    screen.getByRole("button", { name: "Create" }).focus();
    await user.keyboard("{ArrowDown}");

    expect(screen.getByRole("menu", { name: "Create" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Upload media" }),
    ).toHaveFocus();
  });

  it("leaves a menu on Tab and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    router(<CreateMenu />);
    const trigger = screen.getByRole("button", { name: "Create" });

    await user.click(trigger);
    await user.tab();

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("Popover with an overlay opened from inside it", () => {
  it("survives a pointer press on a Select option, which portals outside the panel", async () => {
    const user = userEvent.setup();
    router(<FilterPopover />);

    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    // The option lives in a menu portaled to the document, so it is outside the
    // panel in the DOM. Dismissing there would unmount the panel before the
    // option's own click could land.
    await user.click(screen.getByRole("option", { name: "Failed" }));

    expect(screen.getByRole("dialog", { name: "Filter assets" })).toBeVisible();
  });

  it("lets Escape close the select first and the popover second", async () => {
    const user = userEvent.setup();
    router(<FilterPopover />);

    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Filter assets" })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

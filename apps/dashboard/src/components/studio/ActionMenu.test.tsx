// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActionContextMenu,
  ActionMenuButton,
  type StudioActionGroup,
} from "./ActionMenu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function groups(listeners: {
  onOpen?: () => void;
  onDelete?: () => void;
}): StudioActionGroup[] {
  return [
    {
      actions: [
        {
          id: "open",
          label: "Open",
          icon: "open",
          onSelect: listeners.onOpen ?? (() => {}),
        },
      ],
    },
    {
      actions: [
        {
          id: "delete",
          label: "Delete",
          icon: "trash",
          role: "destructive",
          onSelect: listeners.onDelete ?? (() => {}),
        },
      ],
    },
  ];
}

function renderButton(actions: StudioActionGroup[]) {
  return render(
    <StrictMode>
      <ActionMenuButton label="Actions for Lobby" actions={actions} />
    </StrictMode>,
  );
}

describe("ActionMenuButton in a browser", () => {
  it("opens the web menu with grouped actions", async () => {
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    renderButton(groups({ onOpen, onDelete }));
    expect(
      screen.queryByRole("menuitem", { name: "Open" }),
    ).not.toBeInTheDocument();
    // Base UI positions the popup asynchronously; the DOM opens on the
    // click and visibility settles a tick later.
    fireEvent.click(screen.getByRole("button", { name: "Actions for Lobby" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Open" })).toBeVisible(),
    );
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
      "data-variant",
      "destructive",
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith();
    expect(onDelete).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("menuitem", { name: "Open" }),
    ).not.toBeInTheDocument();
  });

  it("opens the web menu synchronously", () => {
    renderButton(groups({}));
    fireEvent.click(screen.getByRole("button", { name: "Actions for Lobby" }));
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete" }),
    ).toBeInTheDocument();
  });

  it("opens with the keyboard and closes with Escape", async () => {
    renderButton(groups({}));
    screen.getByRole("button", { name: "Actions for Lobby" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: "Open" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(
      screen.queryByRole("menuitem", { name: "Open" }),
    ).not.toBeInTheDocument();
  });

  it("disables actions and skips empty groups without a separator", () => {
    renderButton([
      { actions: [] },
      {
        actions: [
          {
            id: "rename",
            label: "Rename",
            disabled: true,
            onSelect: () => {},
          },
        ],
      },
      {
        actions: [{ id: "open", label: "Open", onSelect: () => {} }],
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Lobby" }));
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("renders an unknown icon token as text only", () => {
    renderButton([
      {
        actions: [
          {
            id: "open",
            label: "Open",
            icon: "not-a-token",
            onSelect: () => {},
          },
        ],
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Lobby" }));
    expect(
      screen.getByRole("menuitem", { name: "Open" }).querySelector("svg"),
    ).toBeNull();
  });

  it("renders nothing without actions", () => {
    renderButton([{ actions: [] }]);
    expect(
      screen.queryByRole("button", { name: "Actions for Lobby" }),
    ).not.toBeInTheDocument();
  });
});

describe("ActionContextMenu", () => {
  function renderCard(actions: StudioActionGroup[]) {
    return render(
      <StrictMode>
        <ActionContextMenu
          label="Actions for Lobby"
          title="Lobby Screen"
          actions={actions}
        >
          <div data-testid="card">Lobby</div>
        </ActionContextMenu>
      </StrictMode>,
    );
  }

  it("opens the web menu on right-click", async () => {
    const onOpen = vi.fn();
    renderCard(groups({ onOpen }));
    fireEvent.contextMenu(screen.getByTestId("card"));
    expect(await screen.findByRole("menuitem", { name: "Open" })).toBeVisible();
    expect(screen.getByText("Lobby Screen")).toHaveAttribute(
      "data-slot",
      "context-menu-label",
    );
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await userEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith();
  });

  it("renders children without a menu when there are no actions", () => {
    renderCard([{ actions: [] }]);
    fireEvent.contextMenu(screen.getByTestId("card"));
    expect(
      screen.queryByRole("menuitem", { name: "Open" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("card")).toBeVisible();
  });

  it("keeps the row's normal click and suppresses activation on Control-click", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const activate = vi.fn();
    const action = vi.fn();
    render(
      <ActionContextMenu
        label="Actions for Lobby"
        actions={groups({ onOpen: action })}
      >
        <button onClick={activate}>Lobby</button>
      </ActionContextMenu>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Lobby" }));
    expect(activate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Lobby" }), {
      ctrlKey: true,
    });
    // macOS dispatches contextmenu for Control-click; Base UI owns opening it.
    fireEvent.contextMenu(screen.getByRole("button", { name: "Lobby" }), {
      ctrlKey: true,
      button: 0,
    });
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open" }),
    );
    expect(activate).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    ["Win32", true],
    ["Win32", false],
    ["Linux x86_64", true],
    ["Linux x86_64", false],
  ] as const)(
    "preserves normal Control-click activation on %s with menu enabled: %s",
    (platform, enabled) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const activate = vi.fn();
      render(
        <ActionContextMenu
          label="Lobby actions"
          actions={enabled ? groups({}) : []}
        >
          <button onClick={activate}>Lobby</button>
        </ActionContextMenu>,
      );
      const defaultAllowed = fireEvent.click(
        screen.getByRole("button", { name: "Lobby" }),
        {
          ctrlKey: true,
        },
      );
      expect(defaultAllowed).toBe(true);
      expect(activate).toHaveBeenCalledExactlyOnceWith(expect.anything());
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    },
  );

  it("preserves macOS Control-click on nested links when the menu is disabled", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const activate = vi.fn();
    render(
      <ActionContextMenu label="Lobby actions" actions={[]}>
        <a href="#lobby" onClick={activate}>
          Lobby
        </a>
      </ActionContextMenu>,
    );
    const defaultAllowed = fireEvent.click(
      screen.getByRole("link", { name: "Lobby" }),
      { ctrlKey: true },
    );
    expect(defaultAllowed).toBe(true);
    expect(activate).toHaveBeenCalledExactlyOnceWith(expect.anything());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("uses the same action and destructive semantics through both menus", async () => {
    const onDelete = vi.fn();
    const actions = groups({ onDelete });
    render(
      <ActionContextMenu label="Lobby context actions" actions={actions}>
        <ActionMenuButton label="Lobby actions" actions={actions} />
      </ActionContextMenu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Lobby actions" }));
    const menuDelete = await screen.findByRole("menuitem", { name: "Delete" });
    expect(menuDelete).toHaveAttribute("data-variant", "destructive");
    await userEvent.click(menuDelete);
    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Lobby actions" }),
    );
    const contextDelete = await screen.findByRole("menuitem", {
      name: "Delete",
    });
    expect(contextDelete).toHaveAttribute("data-variant", "destructive");
    await userEvent.click(contextDelete);
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it("preserves a semantic row when it has no actions", () => {
    render(
      <table>
        <tbody>
          <ActionContextMenu label="Empty actions" actions={[]} render={<tr />}>
            <td>Lobby</td>
          </ActionContextMenu>
        </tbody>
      </table>,
    );
    expect(screen.getByRole("cell", { name: "Lobby" }).parentElement).toBe(
      screen.getByRole("row"),
    );
  });

  it("preserves the row and focus when batch mode disables its actions", () => {
    const row = (actions: StudioActionGroup[]) => (
      <table>
        <tbody>
          <ActionContextMenu
            label="Row actions"
            actions={actions}
            render={<tr />}
          >
            <td>
              <input type="checkbox" aria-label="Select Lobby" />
            </td>
          </ActionContextMenu>
        </tbody>
      </table>
    );
    const { rerender } = render(row(groups({})));
    const checkbox = screen.getByRole("checkbox", { name: "Select Lobby" });
    checkbox.focus();
    rerender(row([]));
    expect(screen.getByRole("checkbox", { name: "Select Lobby" })).toBe(
      checkbox,
    );
    expect(checkbox).toHaveFocus();
    fireEvent.contextMenu(checkbox);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

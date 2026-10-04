// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Lobby" }),
    );
    const open = await screen.findByRole("menuitem", { name: "Open" });
    expect(open).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
      "data-variant",
      "destructive",
    );
    await userEvent.click(open);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith();
    expect(onDelete).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("menuitem", { name: "Open" }),
    ).not.toBeInTheDocument();
  });

  it("opens the web menu from a pointer click", async () => {
    renderButton(groups({}));
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Lobby" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Open" }),
    ).toBeInTheDocument();
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

  it("disables actions and skips empty groups without a separator", async () => {
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
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Lobby" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("renders an unknown icon token as text only", async () => {
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
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Lobby" }),
    );
    expect(
      (await screen.findByRole("menuitem", { name: "Open" })).querySelector(
        "svg",
      ),
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
        <ActionContextMenu label="Actions for Lobby" actions={actions}>
          <div data-testid="card">Lobby</div>
        </ActionContextMenu>
      </StrictMode>,
    );
  }

  it("opens the web menu on right-click", async () => {
    const onOpen = vi.fn();
    renderCard(groups({ onOpen }));
    fireEvent.contextMenu(screen.getByTestId("card"));
    const open = await screen.findByRole("menuitem", { name: "Open" });
    expect(open).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete" }),
    ).toBeInTheDocument();
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
});

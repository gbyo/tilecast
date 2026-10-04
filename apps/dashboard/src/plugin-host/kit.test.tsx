// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActionContextMenu,
  ActionMenuButton,
  type StudioActionGroup,
} from "@tilecast/studio";

afterEach(() => {
  cleanup();
});

const actions: StudioActionGroup[] = [
  { actions: [{ id: "open", label: "Open", onSelect: () => {} }] },
];

describe("@tilecast/studio action menus", () => {
  it("exports a working menu button", async () => {
    const onOpen = vi.fn();
    render(
      <ActionMenuButton
        label="Actions for Fixture"
        actions={[
          {
            actions: [{ id: "open", label: "Open", onSelect: onOpen }],
          },
        ]}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Fixture" }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith();
  });

  it("exports a working context menu", async () => {
    render(
      <ActionContextMenu label="Actions for Fixture" actions={actions}>
        <div data-testid="target">Fixture</div>
      </ActionContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("target"));
    expect(
      await screen.findByRole("menuitem", { name: "Open" }),
    ).toBeInTheDocument();
  });
});

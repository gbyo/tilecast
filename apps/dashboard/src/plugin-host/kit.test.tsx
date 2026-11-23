// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActionContextMenu,
  ActionMenuButton,
  type StudioActionGroup,
} from "@tilecast/studio";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const actions: StudioActionGroup[] = [
  { actions: [{ id: "open", label: "Open", onSelect: () => {} }] },
];

describe("@tilecast/studio action menus", () => {
  it("exports a working menu button", () => {
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
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Fixture" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith();
  });

  it("exports a working context menu", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(any-hover: hover) and (any-pointer: fine)",
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    render(
      <ActionContextMenu label="Actions for Fixture" actions={actions}>
        <div data-testid="target">Fixture</div>
      </ActionContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("target"));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Open" })).toBeVisible(),
    );
  });
});

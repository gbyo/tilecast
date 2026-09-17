// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { Popover } from "./Popover";

afterEach(cleanup);

describe("Popover resize dismissal", () => {
  it("restores focus to the trigger when resize closes the popover", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Popover
          label="Filters"
          trigger={(props) => (
            <button type="button" {...props}>
              Filters
            </button>
          )}
        >
          <input aria-label="Name" />
        </Popover>
      </MemoryRouter>,
    );

    const trigger = screen.getByRole("button", { name: "Filters" });
    await user.click(trigger);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();

    act(() => window.dispatchEvent(new Event("resize")));

    expect(
      screen.queryByRole("dialog", { name: "Filters" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateInput, DateTimeInput } from "./date-picker";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DateInput", () => {
  it("opens a calendar and emits the picked day as YYYY-MM-DD", async () => {
    const onChange = vi.fn();
    render(<DateInput id="date" value="2026-09-10" onChange={onChange} />);
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", {
        name: new Date(2026, 8, 10).toLocaleDateString(),
      }),
    );
    await screen.findByRole("grid");
    await user.click(
      await screen.findByRole("button", { name: /September 15/ }),
    );
    expect(onChange).toHaveBeenCalledWith("2026-09-15");
  });

  it("shows the selected date and clears it on request", async () => {
    const onChange = vi.fn();
    render(<DateInput id="date" value="2026-09-23" onChange={onChange} />);
    const user = userEvent.setup();

    expect(
      await screen.findByRole("button", {
        name: new Date(2026, 8, 23).toLocaleDateString(),
      }),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Clear date" }));
    expect(onChange).toHaveBeenCalledWith("");
  });
});

describe("DateTimeInput", () => {
  it("combines a picked date with the native time input", async () => {
    const onChange = vi.fn();
    render(
      <DateTimeInput
        id="starts"
        value="2026-09-23T10:30"
        onChange={onChange}
      />,
    );

    const time = await screen.findByLabelText("Time");
    expect(time).toHaveValue("10:30");
    fireEvent.change(time, { target: { value: "11:45" } });
    expect(onChange).toHaveBeenLastCalledWith("2026-09-23T11:45");
  });

  it("clearing the date clears the whole value", async () => {
    const onChange = vi.fn();
    render(
      <DateTimeInput
        id="starts"
        value="2026-09-23T10:30"
        onChange={onChange}
      />,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Clear date" }));
    expect(onChange).toHaveBeenCalledWith("");
  });
});

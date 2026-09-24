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

  it("forwards field semantics and disables dates outside the range", async () => {
    render(
      <>
        <span id="date-help">Choose an active day.</span>
        <DateInput
          id="starts-on"
          value="2026-09-10"
          min="2026-09-10"
          max="2026-09-20"
          required
          aria-label="Starts on"
          aria-describedby="date-help"
          aria-invalid
          onChange={vi.fn()}
        />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Starts on" });
    expect(trigger).toHaveAttribute("aria-describedby", "date-help");
    expect(trigger).toHaveAttribute("aria-invalid", "true");
    expect(trigger).toHaveAttribute("aria-required", "true");

    await userEvent.setup().click(trigger);
    expect(
      await screen.findByRole("button", { name: /September 9/ }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /September 21/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /September 15/ })).toBeEnabled();
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

  it("limits time only on the matching boundary dates", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DateTimeInput
        id="maintenance-window"
        value="2026-09-23T10:30"
        min="2026-09-23T09:15"
        max="2026-09-24T17:45"
        aria-label="Maintenance window"
        aria-describedby="window-help"
        aria-invalid
        required
        onBlur={vi.fn()}
        onChange={onChange}
      />,
    );

    const time = screen.getByLabelText("Maintenance window time");
    expect(time).toHaveAttribute("min", "09:15");
    expect(time).not.toHaveAttribute("max");
    expect(time).toHaveAttribute("aria-describedby", "window-help");
    expect(time).toHaveAttribute("aria-invalid", "true");
    expect(time).toHaveAttribute("aria-required", "true");

    rerender(
      <DateTimeInput
        id="maintenance-window"
        value="2026-09-24T10:30"
        min="2026-09-23T09:15"
        max="2026-09-24T17:45"
        aria-label="Maintenance window"
        onChange={onChange}
      />,
    );
    expect(time).not.toHaveAttribute("min");
    expect(time).toHaveAttribute("max", "17:45");
  });
});

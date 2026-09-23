// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewTimeControl } from "./PreviewTimeControl";

afterEach(cleanup);

describe("PreviewTimeControl", () => {
  it("switches from the live clock to a chosen instant", () => {
    const onChange = vi.fn();
    render(
      <PreviewTimeControl
        value={{ mode: "live", value: "" }}
        onChange={onChange}
      />,
    );

    const live = screen.getByRole("button", { name: "Live" });
    expect(live.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByLabelText("Preview date and time")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "At a time" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "fixed" }),
    );
  });

  it("labels the date and time field when an instant is chosen", () => {
    const onChange = vi.fn();
    render(
      <PreviewTimeControl
        value={{ mode: "fixed", value: "2026-09-23T08:15" }}
        onChange={onChange}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "At a time" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const input = screen.getByLabelText("Preview date and time");
    expect(input.getAttribute("data-slot")).toBe("input");
    fireEvent.change(input, { target: { value: "2026-09-24T09:00" } });
    expect(onChange).toHaveBeenCalledWith({
      mode: "fixed",
      value: "2026-09-24T09:00",
    });
  });
});

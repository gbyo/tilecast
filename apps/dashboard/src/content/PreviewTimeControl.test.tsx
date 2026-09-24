// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { PreviewTime } from "./previewTime";
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

  it("labels the date and time controls when an instant is chosen", async () => {
    const onChange = vi.fn();
    function ControlledPreviewTimeControl() {
      const [value, setValue] = useState<PreviewTime>({
        mode: "fixed",
        value: "2026-09-23T08:15",
      });
      return (
        <PreviewTimeControl
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<ControlledPreviewTimeControl />);

    expect(
      screen
        .getByRole("button", { name: "At a time" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const user = userEvent.setup();
    const date = screen.getByRole("button", {
      name: "Preview date and time",
    });
    await user.click(date);
    await user.click(
      await screen.findByRole("button", {
        name: /September 24th, 2026$/,
      }),
    );
    fireEvent.change(screen.getByLabelText("Preview time of day"), {
      target: { value: "09:00" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      mode: "fixed",
      value: "2026-09-24T09:00",
    });
  });
});

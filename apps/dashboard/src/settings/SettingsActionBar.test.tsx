// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsActionBar } from "./SettingsActionBar";

afterEach(cleanup);

describe("SettingsActionBar", () => {
  it("floats unsaved actions at the bottom of the viewport", () => {
    render(
      <SettingsActionBar
        dirty
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const status = screen.getByText("Unsaved changes").closest('[aria-live="polite"]');
    expect(status).not.toBeNull();
    expect(status).toHaveClass("fixed", "left-1/2", "z-40");
    expect(status).not.toHaveClass("sticky");
    expect(
      screen.getByRole("button", { name: "Save changes" }),
    ).toBeInTheDocument();
  });
});

// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Drawer, PageHeader, ViewTabs } from ".";

describe("Signal UI primitives", () => {
  it("renders a consistent page heading with actions", () => {
    render(
      <PageHeader
        title="Screens"
        description="Manage connected players."
        actions={<button type="button">Pair screen</button>}
      />,
    );

    expect(screen.getByRole("heading", { name: "Screens" })).toBeTruthy();
    expect(screen.getByText("Manage connected players.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pair screen" })).toBeTruthy();
  });

  it("supports directional keyboard navigation between view tabs", async () => {
    const user = userEvent.setup();
    function Example() {
      const [value, setValue] = useState<"one" | "two">("one");
      return (
        <ViewTabs
          label="Example views"
          value={value}
          onValueChange={setValue}
          items={[
            { value: "one", label: "One" },
            { value: "two", label: "Two" },
          ]}
        />
      );
    }

    render(<Example />);
    const first = screen.getByRole("button", { name: "One" });
    const second = screen.getByRole("button", { name: "Two" });
    first.focus();
    await user.keyboard("{ArrowRight}{Enter}");
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute("aria-current")).toBe("page");
  });

  it("closes a drawer with Escape and restores trigger focus", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    const { unmount } = render(
      <Drawer title="Playback details" onClose={close}>
        <a href="/screens/1">Lobby</a>
      </Drawer>,
    );

    await user.keyboard("{Escape}");
    expect(close).toHaveBeenCalledOnce();
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

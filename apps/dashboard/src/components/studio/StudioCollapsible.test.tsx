// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./StudioCollapsible";

afterEach(cleanup);

describe("StudioCollapsible", () => {
  it("keeps Vega disclosure semantics while adding shared motion", async () => {
    const user = userEvent.setup();
    render(
      <Collapsible>
        <CollapsibleTrigger>
          Details
          <CollapsibleChevron data-testid="chevron" size={16} />
        </CollapsibleTrigger>
        <CollapsibleContent>Panel content</CollapsibleContent>
      </Collapsible>,
    );

    const trigger = screen.getByRole("button", { name: /details/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByText("Panel content");
    expect(panel).toHaveClass(
      "duration-(--tc-motion-standard)",
      "ease-(--tc-ease-standard)",
    );
    expect(screen.getByTestId("chevron")).toHaveClass(
      "group-data-[panel-open]/studio-collapsible-trigger:rotate-180",
    );
  });
});

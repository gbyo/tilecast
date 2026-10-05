// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Sparkline } from "./Sparkline";

afterEach(cleanup);

describe("Sparkline", () => {
  it("draws a line once there are two measured points", () => {
    const { container } = render(
      <Sparkline values={[10, 20, null, 30]} className="h-7" />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("holds its box without a line, so a card does not grow when the trend arrives", () => {
    const { container } = render(
      <Sparkline values={[]} className="mt-1 h-7 w-full" />,
    );
    const placeholder = container.firstElementChild;
    expect(container.querySelector("svg")).toBeNull();
    expect(placeholder).toHaveAttribute("aria-hidden", "true");
    expect(placeholder).toHaveClass("mt-1", "h-7", "w-full");
  });
});

// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Brand } from "./Brand";

afterEach(cleanup);

describe("Brand", () => {
  it("draws the Studio wordmark in the current text color", () => {
    render(<Brand compact />);

    const logo = screen.getByRole("img", { name: "Tilecast Studio" });
    expect(logo.tagName.toLowerCase()).toBe("svg");
    expect(logo.getAttribute("fill")).toBe("currentColor");
    expect(logo.getAttribute("class")).toContain("text-foreground");
    expect(logo.innerHTML).not.toContain("white");
  });
});

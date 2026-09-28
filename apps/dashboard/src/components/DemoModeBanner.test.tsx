// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DemoModeBanner } from "./DemoModeBanner";

afterEach(cleanup);

describe("DemoModeBanner", () => {
  it("states that the installation holds resettable sample data", () => {
    render(<DemoModeBanner />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Demo mode");
    expect(banner.textContent).toContain(
      "This installation contains sample data and may be reset automatically.",
    );
  });
});

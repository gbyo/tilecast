// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

type Presentation = {
  state?: string;
  display?: "bouncing_logo" | "custom_text" | "black";
};

describe("outside-hours presentation", () => {
  beforeEach(() => {
    vi.resetModules();
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it("keeps an opaque overlay visible for the black sleep presentation", async () => {
    let present: (presentation: Presentation) => void = () => {};
    Object.defineProperty(window, "tilecast", {
      configurable: true,
      value: {
        onPresent(callback: (presentation: Presentation) => void) {
          present = callback;
        },
      },
    });

    await import("./outside-hours");

    present({ state: "sleep", display: "black" });

    const overlay = document.querySelector("#outside-hours-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.className).toBe("visible");
    expect(overlay?.childElementCount).toBe(0);

    present({ state: "active" });
    expect(overlay?.className).toBe("");
  });
});

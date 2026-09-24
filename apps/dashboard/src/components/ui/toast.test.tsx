// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Toaster, createToastManager } from "./toast";

afterEach(cleanup);

describe("Toaster", () => {
  it("keeps its viewport above the shared z-50 overlay layer", () => {
    const toastManager = createToastManager();

    render(<Toaster toastManager={toastManager} />);

    const viewport = document.querySelector<HTMLElement>(
      '[data-slot="toast-viewport"]',
    )!;
    expect(viewport).toHaveClass("z-[60]");
    expect(viewport).not.toHaveClass("z-50");
  });
});

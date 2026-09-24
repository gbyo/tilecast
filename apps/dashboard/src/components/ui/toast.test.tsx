// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToastProvider, ToastViewport, createToastManager } from "./toast";

afterEach(cleanup);

describe("ToastViewport", () => {
  it("stays above the shared z-50 overlay layer", () => {
    const toastManager = createToastManager();

    render(
      <ToastProvider toastManager={toastManager}>
        <ToastViewport />
      </ToastProvider>,
    );

    const viewport = document.querySelector('[data-slot="toast-viewport"]');
    expect(viewport).toHaveClass("z-[60]");
    expect(viewport).not.toHaveClass("z-50");
  });
});

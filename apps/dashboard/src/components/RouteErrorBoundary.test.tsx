// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RouteErrorBoundary } from "./RouteErrorBoundary";

function ThrowingChild(): ReactNode {
  throw new Error("Sensitive internal exception detail");
}

describe("RouteErrorBoundary", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the translated fallback instead of a raw render error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <RouteErrorBoundary>
        <ThrowingChild />
      </RouteErrorBoundary>,
    );

    expect(
      screen.getByText(
        "An unexpected error occurred while rendering this page.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Sensitive internal exception detail"),
    ).not.toBeInTheDocument();
  });
});

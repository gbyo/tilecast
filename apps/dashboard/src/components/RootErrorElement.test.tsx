// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { RootErrorElement } from "./RootErrorElement";

function ThrowingPage(): ReactNode {
  throw new Error("Sensitive internal exception detail");
}

describe("RootErrorElement", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("replaces a failed root route with the translated notice and a reload", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const router = createMemoryRouter([
      {
        path: "*",
        element: <ThrowingPage />,
        errorElement: <RootErrorElement />,
      },
    ]);

    render(<RouterProvider router={router} />);

    expect(
      screen.getByText(
        "An unexpected error occurred while rendering this page.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Sensitive internal exception detail/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});

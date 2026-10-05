// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PageHeader } from "./PageHeader";

afterEach(cleanup);

describe("PageHeader", () => {
  it("renders title, description, and actions in one header", () => {
    render(
      <PageHeader
        title="Screens"
        description="Every enrolled player."
        actions={<button type="button">Pair screen</button>}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Screens" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Every enrolled player.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Pair screen" }),
    ).toBeInTheDocument();
  });

  it("omits description and actions when not provided", () => {
    const { container } = render(<PageHeader title="Screens" />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Screens" }),
    ).toBeInTheDocument();
    expect(container.querySelector("header p")).toBeNull();
    expect(container.querySelector("header button")).toBeNull();
  });

  it("renders rich title and eyebrow content", () => {
    render(
      <PageHeader
        eyebrow="Fleet"
        title={
          <span>
            Lobby <span data-testid="status-badge">Online</span>
          </span>
        }
      />,
    );
    expect(screen.getByText("Fleet")).toBeInTheDocument();
    expect(screen.getByTestId("status-badge")).toBeInTheDocument();
  });
});

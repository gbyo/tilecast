// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ComingUp, PlayerUpdates } from "./OperationsDashboard";

describe("Operations dashboard pending panels", () => {
  it("does not show the empty schedule state while schedules are loading", () => {
    render(
      <MemoryRouter>
        <ComingUp isLoading schedulesError={false} />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("status", { name: "Loading schedules" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No upcoming change/)).not.toBeInTheDocument();
  });

  it("does not show the empty deployment state while deployments are loading", () => {
    render(
      <MemoryRouter>
        <PlayerUpdates isLoading isError={false} actionCount={0} />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("status", { name: "Loading player updates" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No deployments yet/)).not.toBeInTheDocument();
  });
});

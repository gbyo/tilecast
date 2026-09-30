// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { PlayerUpdatesCard } from "../components/overview/PlayerUpdatesCard";
import { UpcomingCard } from "../components/overview/UpcomingCard";

describe("Operations dashboard pending panels", () => {
  it("does not show the empty schedule state while schedules are loading", () => {
    render(
      <MemoryRouter>
        <UpcomingCard
          changes={[]}
          defaultTimezone="UTC"
          isLoading
          isError={false}
          loaded={0}
          total={0}
        />
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
        <PlayerUpdatesCard isLoading isError={false} />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("status", { name: "Loading player updates" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No deployments yet/)).not.toBeInTheDocument();
  });
});

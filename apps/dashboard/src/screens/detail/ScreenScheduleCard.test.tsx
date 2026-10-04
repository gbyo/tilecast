// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { ScreenScheduleCard } from "./ScreenScheduleCard";
import {
  assignmentFixture,
  planFixture,
  relevantScheduleFixture,
  scheduleFixture,
  selectionFixture,
} from "./playbackFixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderCard(
  props: Partial<Parameters<typeof ScreenScheduleCard>[0]> = {},
  schedules: Parameters<typeof scheduleFixture>[0][] = [],
) {
  vi.spyOn(api, "schedules").mockResolvedValue({
    items: schedules.map((overrides) => scheduleFixture(overrides)),
    total: schedules.length,
    page: 1,
    pageSize: 100,
    defaultTimezone: "UTC",
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <ScreenScheduleCard
          screenId="screen-1"
          assignment={assignmentFixture({
            relevantSchedules: [relevantScheduleFixture()],
          })}
          plan={planFixture({ nextEvaluationAt: "2026-09-28T17:30:00Z" })}
          futurePlan={planFixture({
            selected: selectionFixture({
              source: "assignment",
              name: "Morning Announcements",
              contentId: "playlist-2",
              scheduleName: undefined,
              selectionId: undefined,
              reason: "assigned_fallback",
            }),
          })}
          futureState="ready"
          loading={false}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScreenScheduleCard", () => {
  it("shows the active schedule first with navigation to the editor", () => {
    renderCard();
    expect(screen.getByText("Active now")).toBeVisible();
    const link = screen.getByRole("link", { name: /Lunch Service/ });
    expect(link).toHaveAttribute("href", "/schedules/schedule-1");
    expect(screen.getByText("Active")).toBeVisible();
  });

  it("predicts the next change only from the boundary authority", () => {
    renderCard();
    expect(screen.getByText("Next")).toBeVisible();
    expect(screen.getByText(/Morning Announcements/)).toBeVisible();
    expect(screen.getByText("Default content resumes")).toBeVisible();
  });

  it("says plainly when the next evaluation keeps the selection", () => {
    renderCard({
      futurePlan: planFixture(),
      futureState: "ready",
    });
    expect(screen.getByText("Next evaluation")).toBeVisible();
    expect(screen.getByText(/Lunch Menu is still expected/)).toBeVisible();
    expect(screen.queryByText("Next")).not.toBeInTheDocument();
  });

  it("shows only the boundary when the prediction fails", () => {
    renderCard({ futurePlan: undefined, futureState: "error" });
    expect(screen.getByText("Next evaluation")).toBeVisible();
    expect(screen.queryByText(/is still expected/)).not.toBeInTheDocument();
  });

  it("omits the next section without a boundary", () => {
    renderCard({
      plan: planFixture(),
      futurePlan: undefined,
      futureState: "ready",
    });
    expect(screen.queryByText("Next")).not.toBeInTheDocument();
    expect(screen.queryByText("Next evaluation")).not.toBeInTheDocument();
  });

  it("lists other schedules with enabled state and add/view actions", () => {
    renderCard({
      assignment: assignmentFixture({
        relevantSchedules: [
          relevantScheduleFixture(),
          relevantScheduleFixture({
            id: "schedule-2",
            name: "After School",
            playlistName: "Clubs",
            enabled: false,
          }),
        ],
      }),
    });
    expect(screen.getByText("Other schedules")).toBeVisible();
    expect(screen.getByText("Disabled")).toBeVisible();
    expect(screen.getByRole("link", { name: /After School/ })).toHaveAttribute(
      "href",
      "/schedules/schedule-2",
    );
    expect(screen.getByRole("link", { name: "Add schedule" })).toHaveAttribute(
      "href",
      "/schedules/new?screen=screen-1",
    );
    expect(
      screen.getAllByRole("link", { name: "View all" }).length,
    ).toBeGreaterThan(0);
  });

  it("keeps display-control schedules out of content selection", () => {
    renderCard({
      assignment: assignmentFixture({
        relevantSchedules: [
          relevantScheduleFixture(),
          relevantScheduleFixture({
            id: "schedule-9",
            name: "Evening power off",
            playlistName: "",
            presentationType: "display_control",
          }),
        ],
      }),
    });
    expect(screen.queryByText("Evening power off")).not.toBeInTheDocument();
    expect(screen.getByText(/1 display schedules manage power/)).toBeVisible();
  });

  it("shows time context from the joined schedule record", async () => {
    renderCard(
      {
        assignment: assignmentFixture({
          relevantSchedules: [
            relevantScheduleFixture(),
            relevantScheduleFixture({
              id: "schedule-2",
              name: "After School",
              playlistName: "Clubs",
            }),
          ],
        }),
      },
      [{ id: "schedule-2", name: "After School" }],
    );
    expect(await screen.findByText(/Clubs · .*10:30–13:30/)).toBeVisible();
  });

  it("shows an empty state when no content schedules affect the screen", () => {
    renderCard({
      assignment: assignmentFixture({ relevantSchedules: [] }),
      plan: planFixture({ selected: null, candidates: [] }),
    });
    expect(screen.getByText("No content schedules")).toBeVisible();
    expect(screen.getByRole("link", { name: "Add schedule" })).toHaveAttribute(
      "href",
      "/schedules/new?screen=screen-1",
    );
  });
});

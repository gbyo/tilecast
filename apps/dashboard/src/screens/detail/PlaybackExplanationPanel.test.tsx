// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PlaybackExplanationPanel } from "./PlaybackExplanationPanel";
import {
  assignmentFixture,
  candidateFixture,
  planFixture,
  selectionFixture,
} from "./playbackFixtures";

// The shared calendar/time controls have their own focus and conversion tests.
vi.mock("../../components/date-picker", () => ({
  DateTimeInput: ({
    id,
    value,
    onChange,
    "aria-label": label,
  }: {
    id: string;
    value: string;
    onChange: (value: string) => void;
    "aria-label": string;
  }) => (
    <input
      id={id}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const server = setupServer(
  http.get("/api/v1/screens/screen-1/playback-plan", ({ request }) => {
    const url = new URL(request.url);
    if ((url.searchParams.get("at") ?? "").startsWith("2030-")) {
      return HttpResponse.json({
        data: planFixture({
          selected: selectionFixture({
            source: "assignment",
            name: "Morning Announcements",
            scheduleName: undefined,
            selectionId: undefined,
            reason: "assigned_fallback",
          }),
        }),
      });
    }
    if (url.searchParams.has("at")) {
      return HttpResponse.json({
        data: {
          screenId: "screen-1",
          at: url.searchParams.get("at"),
          evaluatedAt: "2026-09-28T14:00:00Z",
          basis: "recorded_expectation",
          historical: {
            expectation: {
              windowId: "window-1",
              presentationType: "playlist",
              presentationId: "playlist-9",
              presentationRevision: "7",
              source: "schedule",
              timezone: "America/New_York",
              start: "2020-05-01T10:00:00Z",
              end: "2020-05-01T12:00:00Z",
            },
          },
        },
      });
    }
    return HttpResponse.json({ data: planFixture() });
  }),
  http.get("/api/v1/playlists/:id", () =>
    HttpResponse.json({
      data: { id: "playlist-1", name: "Lunch Menu", items: [] },
    }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function renderPanel() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <PlaybackExplanationPanel
          screenId="screen-1"
          assignment={assignmentFixture({
            playlistId: "playlist-9",
            playlistName: "Morning Announcements",
          })}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PlaybackExplanationPanel", () => {
  it("lists precedence in stable order with status badges", async () => {
    renderPanel();
    const section = await screen.findByRole("region", {
      name: "Selection precedence",
    });
    const text = section.textContent ?? "";
    const order = [
      "Takeover",
      "Show Now",
      "Lunch Service",
      "Morning Announcements",
    ].map((title) => text.indexOf(title));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(screen.getByText("Selected")).toBeVisible();
    expect(screen.getByText("Superseded")).toBeVisible();
    expect(screen.getAllByText("Inactive").length).toBeGreaterThan(0);
  });

  it("shows schedule precedence evidence on the winning row", async () => {
    renderPanel();
    expect(
      await screen.findByText(/Priority 50 · Target specificity 2/),
    ).toBeVisible();
  });

  it("traces the selected presentation's content path", async () => {
    renderPanel();
    expect(await screen.findByText("Content path")).toBeVisible();
    expect(
      screen.getByText(/Presentations and data behind Lunch Menu/),
    ).toBeVisible();
  });

  it("inspects a future instant as a prediction", async () => {
    const interaction = userEvent.setup();
    renderPanel();
    await screen.findByText("Selection precedence");
    await interaction.click(
      screen.getByRole("button", { name: "Inspect another time" }),
    );
    await interaction.type(
      screen.getByLabelText("Inspect an instant"),
      "2030-09-03T11:00",
    );
    await interaction.click(screen.getByRole("button", { name: "Inspect" }));
    expect(
      await screen.findByText("Prediction from current configuration"),
    ).toBeVisible();
  });

  it("keeps historical inspection free of current content names", async () => {
    const interaction = userEvent.setup();
    renderPanel();
    await screen.findByText("Selection precedence");
    await interaction.click(
      screen.getByRole("button", { name: "Inspect another time" }),
    );
    await interaction.type(
      screen.getByLabelText("Inspect an instant"),
      "2020-05-01T10:00",
    );
    await interaction.click(screen.getByRole("button", { name: "Inspect" }));
    expect(
      await screen.findByText("Recorded historical expectation"),
    ).toBeVisible();
    expect(screen.queryByText("Lunch Menu")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View Player-confirmed Activity" }),
    ).toHaveAttribute("href", "/?tab=activity");
  });

  it("uses the default name for an unnamed assignment candidate", async () => {
    server.use(
      http.get("/api/v1/screens/screen-1/playback-plan", () =>
        HttpResponse.json({
          data: planFixture({
            selected: selectionFixture({
              source: "assignment",
              name: "Morning Announcements",
              reason: "assigned_fallback",
            }),
            candidates: [
              candidateFixture({
                source: "takeover",
                reason: "no_active_takeover",
              }),
              candidateFixture({
                source: "assignment",
                status: "selected",
                reason: "assigned_fallback",
              }),
            ],
          }),
        }),
      ),
    );
    renderPanel();
    const section = await screen.findByRole("region", {
      name: "Selection precedence",
    });
    expect(within(section).getByText("Morning Announcements")).toBeVisible();
  });
});

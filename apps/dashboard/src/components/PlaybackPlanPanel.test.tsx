// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { PlaybackPlanPanel } from "./PlaybackPlanPanel";
import type { PlaybackPlan } from "../api/domains/playbackPlan";
import { i18n } from "../i18n";

// The shared calendar/time controls have their own focus and conversion tests.
// This suite exercises the actual HTTP boundary and evidence lifecycle.
vi.mock("./date-picker", () => ({
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

const current: PlaybackPlan = {
  screenId: "cafeteria",
  at: "2026-10-02T16:15:00Z",
  evaluatedAt: "2026-10-02T16:15:00Z",
  basis: "current_configuration",
  current: {
    selected: {
      source: "schedule",
      contentType: "layout",
      contentId: "lunch",
      name: "Lunch Layout",
      scheduleName: "School Day Lunch",
      revision: 14,
      reason: "schedule_highest_precedence",
    },
    candidates: [
      { source: "takeover", status: "inactive", reason: "no_active_takeover" },
      {
        source: "schedule",
        id: "lunch-schedule",
        name: "School Day Lunch",
        status: "selected",
        reason: "schedule_highest_precedence",
        schedule: {
          scheduleId: "lunch-schedule",
          status: "selected",
          reason: "schedule_highest_precedence",
          priority: 10,
          specificity: 1,
          start: "2026-10-02T16:00:00Z",
          end: "2026-10-02T18:00:00Z",
        },
      },
      {
        source: "assignment",
        status: "superseded",
        reason: "schedule_highest_precedence",
      },
    ],
    nextEvaluationAt: "2026-10-02T18:00:00Z",
    synchronization: { status: "preparing", manifestVersion: 7 },
    capabilities: {
      status: "unknown",
      reason: "player_capabilities_not_reported",
      evidence: {
        screenId: "cafeteria",
        status: "unknown",
        reason: "player_capabilities_not_reported",
        reported: false,
        schemaVersions: [],
        nativeCapabilities: {},
        webRuntimeVersion: 0,
        requiresManifestV13: false,
        widgets: [
          {
            assetId: "clock",
            name: "Lobby Clock",
            status: "unknown",
            reason: "player_capabilities_not_reported",
            component: {
              schemaVersion: 2,
              capabilities: { "widget.tilecast.clock": 2 },
              supported: null,
            },
          },
        ],
      },
    },
  },
};

const server = setupServer(
  http.get("*/api/v1/screens/cafeteria/playback-plan", () =>
    HttpResponse.json({ data: current }),
  ),
);
const clients: QueryClient[] = [];
const pendingResponses: (() => void)[] = [];
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(async () => {
  for (const finish of pendingResponses.splice(0)) finish();
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  server.resetHandlers();
  await i18n.changeLanguage("en");
});
afterAll(() => server.close());

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PlaybackPlanPanel screenId="cafeteria" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it("shows authoritative scheduled content rather than labelling the fallback as now playing", async () => {
  renderPanel();
  expect(await screen.findByText("Lunch Layout")).toBeVisible();
  expect(screen.getByText("School Day Lunch")).toBeVisible();
  expect(screen.getByText("Next reevaluation")).toBeVisible();
  expect(screen.queryByText("Now playing")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Selection and alternatives"),
  ).not.toBeInTheDocument();
  const why = screen.getByRole("button", { name: "Why this selection?" });
  why.focus();
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByText("Selection and alternatives")).toBeVisible();
  expect(
    screen.getAllByText("This schedule wins the server's precedence rules.")
      .length,
  ).toBeGreaterThan(0);
  expect(screen.getByText("Priority 10 · Target specificity 1")).toBeVisible();
  expect(screen.getByText("Overridden")).toBeVisible();
  expect(
    screen.getByText(
      "Manifest synchronization does not prove content readiness or successful playback.",
    ),
  ).toBeVisible();
});

it("keeps unreported capability support unknown instead of presenting it as unsupported", async () => {
  renderPanel();
  await screen.findByText("Lunch Layout");
  await userEvent.click(
    screen.getByRole("button", { name: "Why this selection?" }),
  );
  expect(await screen.findByText("Lobby Clock")).toBeVisible();
  expect(screen.getAllByText("Unknown")).toHaveLength(3);
  expect(screen.queryByText("Blocked")).not.toBeInTheDocument();
  expect(
    screen.getByText(
      "Requires widget.tilecast.clock@2 · reported None reported",
    ),
  ).toBeVisible();
});

it("does not retain current names or capability evidence while loading a historical gap", async () => {
  let finish: (() => void) | undefined;
  server.use(
    http.get(
      "*/api/v1/screens/cafeteria/playback-plan",
      async ({ request }) => {
        if (!new URL(request.url).searchParams.has("at"))
          return HttpResponse.json({ data: current });
        await new Promise<void>((resolve) => {
          finish = resolve;
          pendingResponses.push(resolve);
        });
        return HttpResponse.json({
          data: {
            screenId: "cafeteria",
            at: "2026-10-01T16:00:00Z",
            evaluatedAt: current.evaluatedAt,
            basis: "historical_expectation_unavailable",
            historical: {},
          } satisfies PlaybackPlan,
        });
      },
    ),
  );
  renderPanel();
  await screen.findByText("Lunch Layout");
  await userEvent.click(
    screen.getByRole("button", { name: "Why this selection?" }),
  );
  fireEvent.change(screen.getByLabelText("Inspect an instant"), {
    target: { value: "2026-10-01T12:00" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Inspect" }));
  await waitFor(() => expect(finish).toBeDefined());
  expect(screen.queryByText("Lunch Layout")).not.toBeInTheDocument();
  expect(screen.queryByText("Lobby Clock")).not.toBeInTheDocument();
  finish!();
  expect(
    await screen.findByText(
      "No recorded expectation covers this instant. Current assignments cannot fill this historical gap.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByText("Reported synchronization"),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Use server time" }),
  );
  expect(await screen.findByText("Lunch Layout")).toBeVisible();
});

it("shows recorded identities without looking up current content", async () => {
  server.use(
    http.get("*/api/v1/screens/cafeteria/playback-plan", () =>
      HttpResponse.json({
        data: {
          screenId: "cafeteria",
          at: "2026-10-01T16:00:00Z",
          evaluatedAt: current.evaluatedAt,
          basis: "recorded_expectation",
          historical: {
            expectation: {
              windowId: "window",
              presentationType: "layout",
              presentationId: "removed-layout",
              presentationRevision: "3",
              source: "schedule",
              timezone: "UTC",
              start: "2026-10-01T15:00:00Z",
              end: "2026-10-01T17:00:00Z",
            },
          },
        } satisfies PlaybackPlan,
      }),
    ),
  );
  renderPanel();
  expect(await screen.findByText("Layout · Revision 3")).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Why this selection?" }),
  );
  expect(await screen.findByText("removed-layout")).toBeVisible();
  expect(screen.queryByText("Lunch Layout")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Reported Widget presentation support"),
  ).not.toBeInTheDocument();
});

it("discards a late historical response after returning to server time", async () => {
  let finish: (() => void) | undefined;
  server.use(
    http.get(
      "*/api/v1/screens/cafeteria/playback-plan",
      async ({ request }) => {
        if (!new URL(request.url).searchParams.has("at"))
          return HttpResponse.json({ data: current });
        await new Promise<void>((resolve) => {
          finish = resolve;
          pendingResponses.push(resolve);
        });
        return HttpResponse.json({
          data: {
            screenId: "cafeteria",
            at: "2026-10-01T16:00:00Z",
            evaluatedAt: current.evaluatedAt,
            basis: "historical_expectation_unavailable",
            historical: {},
          } satisfies PlaybackPlan,
        });
      },
    ),
  );
  renderPanel();
  await screen.findByText("Lunch Layout");
  await userEvent.click(
    screen.getByRole("button", { name: "Why this selection?" }),
  );
  fireEvent.change(screen.getByLabelText("Inspect an instant"), {
    target: { value: "2026-10-01T12:00" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Inspect" }));
  await waitFor(() => expect(finish).toBeDefined());
  await userEvent.click(
    screen.getByRole("button", { name: "Use server time" }),
  );
  expect(await screen.findByText("Lunch Layout")).toBeVisible();
  finish!();
  await waitFor(() =>
    expect(
      screen.queryByText("Historical expectation unavailable"),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByText("Lunch Layout")).toBeVisible();
});

it("validates a missing instant without replacing valid current evidence", async () => {
  renderPanel();
  await screen.findByText("Lunch Layout");
  await userEvent.click(
    screen.getByRole("button", { name: "Why this selection?" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Inspect" }));
  expect(
    await screen.findByText("Choose a valid date and time."),
  ).toBeVisible();
  expect(screen.getByText("Lunch Layout")).toBeVisible();
});

it("localizes authoritative reason codes and API conflicts", async () => {
  await i18n.changeLanguage("es");
  renderPanel();
  await screen.findByText("Lunch Layout");
  await userEvent.click(
    screen.getByRole("button", { name: "¿Por qué esta selección?" }),
  );
  expect(
    (
      await screen.findAllByText(
        "Esta programación gana según las reglas de precedencia del servidor.",
      )
    ).length,
  ).toBeGreaterThan(0);
  server.use(
    http.get("*/api/v1/screens/cafeteria/playback-plan", () =>
      HttpResponse.json(
        {
          error: {
            code: "playback_expectation_ambiguous",
            // i18n-ignore: simulated API message; the UI must translate its code.
            message: "Recorded playback expectations overlap at this instant.",
          },
        },
        { status: 409 },
      ),
    ),
  );
  await userEvent.click(
    screen.getByRole("button", { name: i18n.t("common:actions.refresh") }),
  );
  expect(
    await screen.findByText(
      "Las expectativas de reproducción registradas se superponen en este instante.",
    ),
  ).toBeVisible();
  expect(screen.queryByText("Lunch Layout")).not.toBeInTheDocument();
});

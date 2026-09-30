// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import * as activity from "../api/domains/activity";
import type { ContentHealthReport } from "../api/types";
import {
  deployment,
  incident,
  schedule,
  screen as screenFixture,
} from "../components/overview/fixtures";
import { OperationsDashboard } from "./OperationsDashboard";

let role = "owner";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { user: { id: "u1", role } } }),
}));

vi.mock("../components/FleetUptimePanel", () => ({
  FleetUptimePanel: () => <div data-testid="uptime" />,
}));

vi.mock("../api/domains/activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/domains/activity")>()),
  getActivityOverview: vi.fn(),
  getPlaybackCompliance: vi.fn(),
  listIncidents: vi.fn(),
}));

const never = () => new Promise<never>(() => {});

const healthyContent: ContentHealthReport = {
  staleSources: [],
  expiringAssets: [],
  emptyPlaylists: [],
  unassignedScreens: [],
  thresholds: { staleSourceHours: 12, expiringMediaDays: 7 },
  generatedAt: "2026-09-29T12:00:00Z",
};

function overview(
  cards: Partial<Record<string, number>> = {},
  fleet: Record<string, number> | null = {
    measured: 4,
    online: 4,
    healthy: 3,
    impaired: 0,
    offline: 0,
    unmeasured: 1,
  },
) {
  return {
    range: { from: "2026-09-28T12:00:00Z", to: "2026-09-29T12:00:00Z" },
    cards: {
      screensWithReportingGaps: 0,
      confirmedScreenPlaybackMs: 3_600_000,
      contentExposureMs: 3_600_000,
      playbackFailures: 0,
      interruptedPlays: 0,
      takeoverActivations: 0,
      failedPlayerUpdates: 0,
      recentAdministrativeChanges: 0,
      ...cards,
    },
    ...(fleet ? { fleet } : {}),
    timeline: [],
  };
}

function compliance(percent: number | null) {
  return { compliancePercent: percent } as Awaited<
    ReturnType<typeof activity.getPlaybackCompliance>
  >;
}

function mockAll({
  screens = [screenFixture()],
  schedules = [] as ReturnType<typeof schedule>[],
  deployments = [] as ReturnType<typeof deployment>[],
  incidents = [] as ReturnType<typeof incident>[],
} = {}) {
  vi.spyOn(api, "screens").mockResolvedValue({
    items: screens,
    total: screens.length,
  });
  vi.spyOn(api, "schedules").mockResolvedValue({
    items: schedules,
    total: schedules.length,
    page: 1,
    pageSize: 100,
    defaultTimezone: "UTC",
  });
  vi.spyOn(api, "updateDeployments").mockResolvedValue({
    items: deployments,
  });
  vi.spyOn(api, "contentHealth").mockResolvedValue(healthyContent);
  vi.mocked(activity.listIncidents).mockResolvedValue({
    items: incidents,
  } as never);
  vi.mocked(activity.getActivityOverview).mockResolvedValue(
    overview() as never,
  );
  vi.mocked(activity.getPlaybackCompliance).mockResolvedValue(compliance(98.5));
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OperationsDashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const region = (name: string | RegExp) => screen.findByRole("region", { name });

beforeEach(() => {
  role = "owner";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Overview fleet status", () => {
  it("collapses a healthy fleet into one headline and no attention section", async () => {
    mockAll({
      screens: [
        screenFixture({ id: "a", name: "Lobby" }),
        screenFixture({ id: "b", name: "Hall" }),
      ],
    });
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "All 2 screens are online" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Needs attention" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("All screens are online."),
    ).not.toBeInTheDocument();
  });

  it("names each screen that needs attention and why", async () => {
    mockAll({
      screens: [
        screenFixture({ id: "a", name: "Library", status: "offline" }),
        screenFixture({ id: "b", name: "Gym", status: "stale" }),
        screenFixture({ id: "c", name: "Lobby" }),
        screenFixture({ id: "d", name: "Old TV", status: "disabled" }),
      ],
    });
    renderPage();
    expect(
      await screen.findByRole("heading", {
        name: "2 of 4 screens need attention",
      }),
    ).toBeInTheDocument();
    const attention = await region("Needs attention");
    expect(within(attention).getByText("Library")).toBeInTheDocument();
    expect(within(attention).getByText("Offline")).toBeInTheDocument();
    expect(within(attention).getByText("Stale")).toBeInTheDocument();
    // A disabled screen is an administrator's decision: counted, not alarming.
    expect(within(attention).queryByText("Old TV")).not.toBeInTheDocument();
    expect(screen.getByText(/Disabled 1/)).toBeInTheDocument();
  });

  it("says an online player failed to update instead of showing an unexplained badge", async () => {
    mockAll({
      screens: [
        screenFixture({
          id: "a",
          name: "Lobby",
          updateError: "install_failed",
        }),
      ],
    });
    renderPage();
    const attention = await region("Needs attention");
    expect(
      within(attention).getByText("Player update failed"),
    ).toBeInTheDocument();
    expect(within(attention).queryByText("Online")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "1 of 1 screens needs attention" }),
    ).toBeInTheDocument();
  });

  it("adds playback problems from active incidents", async () => {
    mockAll({
      incidents: [
        incident({ primaryScreenId: "screen-1", incidentType: "playback" }),
      ],
    });
    renderPage();
    const attention = await region("Needs attention");
    expect(within(attention).getByText("Playback problem")).toBeInTheDocument();
  });

  it("warns that the list may be incomplete when incidents cannot be loaded", async () => {
    mockAll();
    vi.mocked(activity.listIncidents).mockRejectedValue(new Error("nope"));
    renderPage();
    expect(
      await screen.findByText(/Incident details could not be loaded/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Your screen is online" }),
    ).toBeInTheDocument();
  });

  it("shows the Player-confirmed playing count, not a guess", async () => {
    mockAll();
    renderPage();
    const status = await screen.findByTestId("fleet-status");
    expect(
      await within(status).findByRole("link", {
        name: /Playing: 3 of 4 screens in service/,
      }),
    ).toHaveAttribute("href", "/activity");
  });

  it("reports the playing figure as unavailable rather than zero when analytics fail", async () => {
    mockAll();
    vi.mocked(activity.getActivityOverview).mockRejectedValue(new Error("x"));
    renderPage();
    const status = await screen.findByTestId("fleet-status");
    expect(await within(status).findByText("Unavailable")).toBeInTheDocument();
    // The live cards still work.
    expect(await region("On air now")).toBeInTheDocument();
  });
});

describe("Overview on air", () => {
  it("lists what online screens are set to show and links each to its screen", async () => {
    mockAll({
      screens: [
        screenFixture({
          id: "a",
          name: "Lobby",
          nowPlayingName: "Morning",
          nowPlayingType: "playlist",
        }),
        screenFixture({ id: "b", name: "Hall" }),
      ],
    });
    renderPage();
    const onAir = await region("On air now");
    const link = await within(onAir).findByRole("link", { name: /Lobby/ });
    expect(link).toHaveAttribute("href", "/screens/a");
    expect(
      await within(onAir).findByText("Playlist · Morning"),
    ).toBeInTheDocument();
    expect(
      await within(onAir).findByText("1 online screen has nothing assigned."),
    ).toBeInTheDocument();
  });

  it("does not list an offline screen as on air", async () => {
    mockAll({
      screens: [
        screenFixture({
          id: "a",
          name: "Library",
          status: "offline",
          nowPlayingName: "Menu",
          nowPlayingType: "playlist",
        }),
      ],
    });
    renderPage();
    const onAir = await region("On air now");
    expect(
      await within(onAir).findByText("No screens are online."),
    ).toBeInTheDocument();
    expect(within(onAir).queryByText("Library")).not.toBeInTheDocument();
  });

  it("says online screens have nothing assigned when none has content", async () => {
    mockAll();
    renderPage();
    const onAir = await region("On air now");
    expect(
      await within(onAir).findByText("Online screens have nothing assigned."),
    ).toBeInTheDocument();
  });

  it("caps the list and points to the rest", async () => {
    mockAll({
      screens: Array.from({ length: 7 }, (_, index) =>
        screenFixture({
          id: `s${index}`,
          name: `Screen ${index}`,
          nowPlayingName: "Loop",
          nowPlayingType: "playlist",
        }),
      ),
    });
    renderPage();
    const onAir = await region("On air now");
    expect(
      await within(onAir).findAllByRole("link", { name: /Screen/ }),
    ).toHaveLength(4);
    expect(
      await within(onAir).findByRole("link", {
        name: "3 more online screens have content assigned.",
      }),
    ).toHaveAttribute("href", "/screens");
  });
});

describe("Overview last 24 hours", () => {
  it("links each figure to exactly the records it counted", async () => {
    mockAll();
    vi.mocked(activity.getActivityOverview).mockResolvedValue(
      overview({ playbackFailures: 3, interruptedPlays: 2 }) as never,
    );
    renderPage();
    const card = await region("Last 24 hours");
    expect(
      await within(card).findByRole("link", { name: /Playback failures/ }),
    ).toHaveAttribute("href", "/activity?tab=proof&range=24h&result=failed");
    expect(
      within(card).getByRole("link", { name: /Interrupted plays/ }),
    ).toHaveAttribute(
      "href",
      "/activity?tab=proof&range=24h&terminalReason=unexpected",
    );
    expect(within(card).getByText("98.5%")).toBeInTheDocument();
  });

  it("shows a real zero when playback was measured and nothing failed", async () => {
    mockAll();
    renderPage();
    const card = await region("Last 24 hours");
    const failures = await within(card).findByRole("link", {
      name: /Playback failures/,
    });
    expect(within(failures).getByText("0")).toBeInTheDocument();
  });

  it("does not turn missing measurement into zero", async () => {
    mockAll();
    vi.mocked(activity.getActivityOverview).mockResolvedValue(
      overview({ confirmedScreenPlaybackMs: 0 }) as never,
    );
    renderPage();
    const card = await region("Last 24 hours");
    expect(await within(card).findAllByText("No data")).toHaveLength(2);
    expect(within(card).queryByText("0")).not.toBeInTheDocument();
    expect(within(card).getByText("98.5%")).toBeInTheDocument();
  });

  it("collapses to one line when nothing was expected or confirmed", async () => {
    mockAll();
    vi.mocked(activity.getActivityOverview).mockResolvedValue(
      overview({ confirmedScreenPlaybackMs: 0 }) as never,
    );
    vi.mocked(activity.getPlaybackCompliance).mockResolvedValue(
      compliance(null),
    );
    renderPage();
    const card = await region("Last 24 hours");
    expect(
      await within(card).findByText(/nothing to measure/),
    ).toBeInTheDocument();
    expect(within(card).queryByText("No data")).not.toBeInTheDocument();
  });

  it("marks a figure unavailable when its request fails", async () => {
    mockAll();
    vi.mocked(activity.getPlaybackCompliance).mockRejectedValue(new Error("x"));
    renderPage();
    const card = await region("Last 24 hours");
    expect(await within(card).findByText("Unavailable")).toBeInTheDocument();
    expect(
      await within(card).findByRole("link", { name: /Playback failures/ }),
    ).toBeInTheDocument();
  });
});

describe("Overview coming up", () => {
  const inTwoHours = new Date(Date.now() + 2 * 3_600_000).toISOString();

  it("shows a loading state, never the empty message, while schedules load", async () => {
    mockAll();
    vi.spyOn(api, "schedules").mockImplementation(never);
    renderPage();
    expect(
      await screen.findByRole("status", { name: "Loading schedules" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No upcoming change/)).not.toBeInTheDocument();
  });

  it("says nothing is scheduled once schedules load empty", async () => {
    mockAll();
    renderPage();
    expect(await screen.findByText(/No upcoming change/)).toBeInTheDocument();
  });

  it("shows the schedule error without hiding the rest of the page", async () => {
    mockAll();
    vi.spyOn(api, "schedules").mockRejectedValue(new Error("x"));
    renderPage();
    expect(
      await screen.findByText("Schedules could not be loaded"),
    ).toBeInTheDocument();
    expect(await region("On air now")).toBeInTheDocument();
  });

  it("names the next change and the content it affects", async () => {
    mockAll({
      schedules: [
        schedule({
          type: "one_time",
          oneTimeStart: inTwoHours,
          oneTimeEnd: undefined,
          daysOfWeek: [],
          dailyStart: undefined,
          dailyEnd: undefined,
        }),
      ],
    });
    renderPage();
    const card = await region("Coming up");
    const link = await within(card).findByRole("link", {
      name: /Starts · Lunch menu/,
    });
    expect(link).toHaveAttribute("href", "/schedules/schedule-1");
    expect(within(card).getByText(/Lunch loop · Lobby/)).toBeInTheDocument();
  });

  it("says when only some schedules were considered", async () => {
    mockAll();
    vi.spyOn(api, "schedules").mockResolvedValue({
      items: [],
      total: 130,
      page: 1,
      pageSize: 100,
      defaultTimezone: "UTC",
    });
    renderPage();
    expect(
      await screen.findByText("Based on the first 0 of 130 schedules."),
    ).toBeInTheDocument();
  });
});

describe("Overview player updates", () => {
  it("shows a loading state, never the no-deployments message, while loading", async () => {
    mockAll();
    vi.spyOn(api, "updateDeployments").mockImplementation(never);
    renderPage();
    expect(
      await screen.findByRole("status", { name: "Loading player updates" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No deployments yet/)).not.toBeInTheDocument();
  });

  it("says nothing has been deployed", async () => {
    mockAll();
    renderPage();
    expect(await screen.findByText(/No deployments yet/)).toBeInTheDocument();
  });

  it("is a quiet, localized status after a successful deployment", async () => {
    mockAll({ deployments: [deployment()] });
    renderPage();
    const card = await region("Player updates");
    expect(
      await within(card).findByText(/Player 1\.2\.0 · Completed/),
    ).toBeInTheDocument();
    expect(within(card).getByText("Up to date")).toBeInTheDocument();
    expect(within(card).getByText(/4 of 4 succeeded/)).toBeInTheDocument();
  });

  it("puts a failed deployment forward with what failed", async () => {
    mockAll({
      deployments: [
        deployment({
          status: "active",
          succeededCount: 1,
          failedCount: 2,
          waitingForUserCount: 1,
        }),
      ],
    });
    renderPage();
    const card = await region("Player updates");
    expect(await within(card).findByText("3 need action")).toBeInTheDocument();
    expect(
      within(card).getByText(
        /1 of 4 succeeded · Failed: 2 · Waiting for user: 1/,
      ),
    ).toBeInTheDocument();
  });

  it("shows an error when deployments cannot be loaded", async () => {
    mockAll();
    vi.spyOn(api, "updateDeployments").mockRejectedValue(new Error("x"));
    renderPage();
    expect(
      await screen.findByText("Update status could not be loaded"),
    ).toBeInTheDocument();
  });
});

describe("Overview content health", () => {
  it("is one quiet line when nothing is wrong", async () => {
    mockAll();
    renderPage();
    const card = await region("Content health");
    expect(
      await within(card).findByText("Nothing needs attention."),
    ).toBeInTheDocument();
  });

  it("counts each kind of problem and opens the report that lists them", async () => {
    mockAll();
    vi.spyOn(api, "contentHealth").mockResolvedValue({
      ...healthyContent,
      emptyPlaylists: [{ id: "p", name: "Menu", screenCount: 3 }],
      unassignedScreens: [{ id: "s", name: "Hall" }],
    });
    renderPage();
    const card = await region("Content health");
    const empty = await within(card).findByRole("link", {
      name: /Playlists with nothing to play/,
    });
    expect(empty).toHaveAttribute("href", "/activity?tab=content-health");
    expect(within(empty).getByText("Affecting 3 screens")).toBeInTheDocument();
    expect(
      within(card).getByRole("link", { name: /Screens with nothing assigned/ }),
    ).toBeInTheDocument();
  });

  it("degrades to an error inside its own card", async () => {
    mockAll();
    vi.spyOn(api, "contentHealth").mockRejectedValue(new Error("x"));
    renderPage();
    const card = await region("Content health");
    expect(
      await within(card).findByText("Content health could not be loaded"),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("fleet-status")).toBeInTheDocument();
  });
});

describe("Overview installation states", () => {
  it("invites an owner to pair the first screen", async () => {
    mockAll({ screens: [] });
    renderPage();
    expect(
      await screen.findByRole("link", { name: "Pair screen" }),
    ).toHaveAttribute("href", "/screens/pair");
    expect(
      screen.queryByRole("region", { name: "On air now" }),
    ).not.toBeInTheDocument();
  });

  it("tells an editor to ask an administrator instead", async () => {
    role = "editor";
    mockAll({ screens: [] });
    renderPage();
    expect(
      await screen.findByText(/Ask an Owner or Administrator/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Pair screen" }),
    ).not.toBeInTheDocument();
  });

  it("shows live-status placeholders while screens load, and no empty state", async () => {
    mockAll();
    vi.spyOn(api, "screens").mockImplementation(never);
    renderPage();
    expect(
      await screen.findByRole("status", { name: "Loading fleet status" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("No screens paired yet")).not.toBeInTheDocument();
    // Independent queries are not held up by the slow one.
    expect(await region("Content health")).toBeInTheDocument();
  });

  it("keeps the rest of the page when the screen list fails", async () => {
    mockAll();
    vi.spyOn(api, "screens").mockRejectedValue(new Error("x"));
    renderPage();
    expect(
      await screen.findByText("Player status could not be loaded"),
    ).toBeInTheDocument();
    expect(await region("Coming up")).toBeInTheDocument();
    expect(screen.getByTestId("uptime")).toBeInTheDocument();
  });
});

describe("Overview layout order", () => {
  it("keeps one DOM order for every viewport: status, attention, the rail, then last day", async () => {
    mockAll({ screens: [screenFixture({ status: "offline" })] });
    renderPage();
    await region("Needs attention");
    const order = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(order).toEqual([
      "1 of 1 screens needs attention",
      "Needs attention",
      "On air now",
      "Coming up",
      "Content health",
      "Player updates",
      "Last 24 hours",
    ]);
  });
});

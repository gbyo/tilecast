// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  // Fleet health itself is mocked; this is the summary's sparkline data.
  vi.spyOn(api, "fleetUptime").mockRejectedValue(new Error("not under test"));
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

/** The one-sentence recap, once it has rendered. */
const recap = () => screen.findByTestId("overview-recap");

function fleetScreens(online: number, total: number) {
  return Array.from({ length: total }, (_, index) =>
    screenFixture({
      id: `s${index}`,
      name: `Screen ${String(index).padStart(2, "0")}`,
      status: index < online ? "online" : "offline",
    }),
  );
}

beforeEach(() => {
  role = "owner";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Overview recap", () => {
  it("has one page heading, named Overview, and no visible subtitle", async () => {
    mockAll();
    renderPage();
    await recap();
    const h1 = screen.getAllByRole("heading", { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]).toHaveTextContent("Overview");
    expect(h1[0]).toHaveClass("sr-only");
    expect(
      screen.queryByText(/Player health, what’s on air/),
    ).not.toBeInTheDocument();
  });

  it("is a paragraph, not a heading, so it never competes with the page title", async () => {
    mockAll();
    renderPage();
    const sentence = await recap();
    expect(sentence.tagName).toBe("P");
    expect(
      screen.queryByRole("heading", { name: /screen.* online/ }),
    ).not.toBeInTheDocument();
  });

  it("answers conversationally when most of the fleet is online", async () => {
    // Seven of ten online, three offline, and an update failure on one online
    // screen: four screens need attention.
    const screens = fleetScreens(7, 10);
    screens[0] = { ...screens[0]!, updateError: "install_failed" };
    mockAll({ screens });
    renderPage();
    expect(await recap()).toHaveTextContent(
      "Most of your fleet is online, but 4 screens need attention.",
    );
  });

  it("says nothing needs attention only by saying nothing about it", async () => {
    mockAll({ screens: fleetScreens(2, 2) });
    renderPage();
    expect(await recap()).toHaveTextContent(/^All 2 screens are online\.$/);
  });

  it("adds attention to a fully online fleet", async () => {
    const screens = fleetScreens(10, 10);
    screens[3] = { ...screens[3]!, updateError: "install_failed" };
    screens[4] = { ...screens[4]!, updateError: "install_failed" };
    mockAll({ screens });
    renderPage();
    expect(await recap()).toHaveTextContent(
      "All 10 screens are online, but 2 need attention.",
    );
  });

  it("reports healthy playback when every screen is confirmed", async () => {
    mockAll({ screens: fleetScreens(10, 10) });
    vi.mocked(activity.getActivityOverview).mockResolvedValue(
      overview(
        {},
        {
          measured: 10,
          online: 10,
          healthy: 10,
          impaired: 0,
          offline: 0,
          unmeasured: 0,
        },
      ) as never,
    );
    renderPage();
    expect(
      await screen.findByText(/reporting healthy playback/),
    ).toHaveTextContent(
      "All 10 screens are online and reporting healthy playback.",
    );
  });

  it("calls out online screens that confirm no healthy playback", async () => {
    mockAll({ screens: fleetScreens(10, 10) });
    vi.mocked(activity.getActivityOverview).mockResolvedValue(
      overview(
        {},
        {
          measured: 10,
          online: 10,
          healthy: 0,
          impaired: 4,
          offline: 0,
          unmeasured: 6,
        },
      ) as never,
    );
    renderPage();
    expect(
      await screen.findByText(/none is reporting healthy/),
    ).toHaveTextContent(
      "All 10 screens are online, but none is reporting healthy playback.",
    );
  });

  it("omits playback when analytics are unavailable instead of reading zero", async () => {
    mockAll({ screens: fleetScreens(10, 10) });
    vi.mocked(activity.getActivityOverview).mockRejectedValue(new Error("x"));
    renderPage();
    const status = await screen.findByTestId("fleet-status");
    await within(status).findByText("Unavailable");
    expect(await recap()).toHaveTextContent(/^All 10 screens are online\.$/);
  });

  it("states the connection only while incidents are still loading", async () => {
    mockAll({ screens: fleetScreens(7, 10) });
    vi.mocked(activity.listIncidents).mockImplementation(never);
    renderPage();
    expect(await recap()).toHaveTextContent(/^Most of your fleet is online\.$/);
  });

  it("calls proven issues a minimum when incidents fail to load", async () => {
    const screens = fleetScreens(7, 10);
    screens[0] = { ...screens[0]!, updateError: "install_failed" };
    screens[1] = { ...screens[1]!, updateError: "install_failed" };
    mockAll({ screens });
    vi.mocked(activity.listIncidents).mockRejectedValue(new Error("nope"));
    renderPage();
    expect(await screen.findByText(/at least/)).toHaveTextContent(
      "Most of your fleet is online, but at least 5 screens need attention.",
    );
  });

  it("does not claim a clean fleet when incidents fail and no issue is known", async () => {
    mockAll({
      screens: fleetScreens(7, 10).map((s) => ({
        ...s,
        status: "online" as const,
      })),
    });
    vi.mocked(activity.listIncidents).mockRejectedValue(new Error("nope"));
    renderPage();
    await screen.findByText(/Incident details could not be loaded/);
    expect(await recap()).toHaveTextContent(/^All 10 screens are online\.$/);
  });

  it("describes a partly online fleet with exact counts", async () => {
    mockAll({ screens: fleetScreens(6, 10) });
    renderPage();
    expect(await recap()).toHaveTextContent(
      "6 of 10 screens are online, and 4 need attention.",
    );
  });

  it("says only a few screens are online when under a third are", async () => {
    mockAll({ screens: fleetScreens(3, 10) });
    renderPage();
    expect(await recap()).toHaveTextContent(
      "Only 3 of 10 screens are online, and 7 need attention.",
    );
  });

  it("says no screens are online when none are", async () => {
    mockAll({ screens: fleetScreens(0, 6) });
    renderPage();
    expect(await recap()).toHaveTextContent(
      "No screens are online, and 6 need attention.",
    );
  });

  it("shows no recap for an installation with no screens, but keeps the page title", async () => {
    mockAll({ screens: [] });
    renderPage();
    await screen.findByText("No screens paired yet");
    expect(screen.queryByTestId("overview-recap")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Overview" }),
    ).toBeInTheDocument();
  });

  it("holds a one-line placeholder while screens load", async () => {
    mockAll();
    vi.spyOn(api, "screens").mockImplementation(never);
    renderPage();
    await screen.findByRole("status", { name: "Loading fleet status" });
    expect(screen.queryByTestId("overview-recap")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Overview" }),
    ).toBeInTheDocument();
  });

  it("does not invent a recap when the screen list fails", async () => {
    mockAll();
    vi.spyOn(api, "screens").mockRejectedValue(new Error("x"));
    renderPage();
    await screen.findByText("Player status could not be loaded");
    expect(screen.queryByTestId("overview-recap")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Overview" }),
    ).toBeInTheDocument();
  });
});

describe("Overview fleet status", () => {
  it("names the Fleet status region with a stable heading, not a second recap", async () => {
    mockAll({ screens: fleetScreens(7, 10) });
    renderPage();
    const status = await screen.findByTestId("fleet-status");
    expect(status).toHaveAccessibleName("Fleet status");
    expect(
      within(status).getByRole("heading", { level: 2, name: "Fleet status" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /need attention|are online/ }),
    ).not.toBeInTheDocument();
  });

  it("collapses a healthy fleet into one headline and no attention section", async () => {
    mockAll({
      screens: [
        screenFixture({ id: "a", name: "Lobby" }),
        screenFixture({ id: "b", name: "Hall" }),
      ],
    });
    renderPage();
    expect(await recap()).toHaveTextContent("All 2 screens are online.");
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
    expect(await recap()).toHaveTextContent(
      "Only 1 of 4 screens is online, and 2 need attention.",
    );
    const attention = await region("Needs attention");
    expect(within(attention).getByText("Library")).toBeInTheDocument();
    expect(within(attention).getByText("Offline")).toBeInTheDocument();
    expect(within(attention).getByText("Stale")).toBeInTheDocument();
    // A disabled screen is an administrator's decision, not an alarm.
    expect(within(attention).queryByText("Old TV")).not.toBeInTheDocument();
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
    expect(await recap()).toHaveTextContent(
      "Your screen is online, but it needs attention.",
    );
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
    expect(await recap()).toHaveTextContent("Your screen is online.");
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

  it("draws a trend line per figure only from measured uptime hours", async () => {
    mockAll();
    const bucket = (upPercent: number | null) => ({
      start: "2026-09-30T00:00:00Z",
      upPercent: upPercent ?? 0,
      impairedPercent: 0,
      downPercent: upPercent === null ? 0 : 100 - upPercent,
      unknownPercent: upPercent === null ? 100 : 0,
      uptimePercent: upPercent,
      screensDown: 0,
    });
    vi.spyOn(api, "fleetUptime").mockResolvedValue({
      buckets: [bucket(90), bucket(95), bucket(null), bucket(100)],
    } as Awaited<ReturnType<typeof api.fleetUptime>>);
    renderPage();
    const status = await screen.findByTestId("fleet-status");
    await waitFor(() =>
      expect(status.querySelectorAll("svg[viewBox='0 0 100 30']")).toHaveLength(
        3,
      ),
    );
    // The unmeasured hour breaks each line: one two-hour run is drawn, the
    // single trailing hour is not.
    const [online] = status.querySelectorAll("svg[viewBox='0 0 100 30']");
    expect(online!.querySelectorAll("g")).toHaveLength(1);
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
  it("groups online screens by what they are set to show", async () => {
    mockAll({
      screens: [
        screenFixture({
          id: "a",
          name: "Lobby",
          nowPlayingName: "Morning",
          nowPlayingType: "playlist",
        }),
        screenFixture({
          id: "b",
          name: "Hall",
          nowPlayingName: "Morning",
          nowPlayingType: "playlist",
        }),
        screenFixture({ id: "c", name: "Gym" }),
      ],
    });
    renderPage();
    const onAir = await region("On air now");
    const link = await within(onAir).findByRole("link", { name: /Morning/ });
    expect(link).toHaveAttribute("href", "/screens");
    expect(within(link).getByText("Hall, Lobby")).toBeInTheDocument();
    expect(within(link).getByText("2 screens")).toBeInTheDocument();
    expect(
      within(onAir).getByText("2 assigned · 1 unassigned"),
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

  it("caps the groups and counts the rest", async () => {
    mockAll({
      screens: Array.from({ length: 6 }, (_, index) =>
        screenFixture({
          id: `s${index}`,
          name: `Screen ${index}`,
          nowPlayingName: `Loop ${index}`,
          nowPlayingType: "playlist",
        }),
      ),
    });
    renderPage();
    const onAir = await region("On air now");
    expect(
      await within(onAir).findAllByRole("link", { name: /Loop/ }),
    ).toHaveLength(4);
    expect(
      within(onAir).getByText("6 assigned · 0 unassigned · 2 more"),
    ).toBeInTheDocument();
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
      name: /Lunch menu.*Starts/,
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
      "Fleet status",
      "Needs attention",
      "On air now",
      "Coming up",
      "Content health",
      "Player updates",
      "Last 24 hours",
    ]);
  });
});

describe("Overview load reveal", () => {
  function renderWithClient() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <OperationsDashboard />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return client;
  }

  /** jsdom runs no CSS animations; this stands in for a running exit fade. */
  function runExitAnimations() {
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [{}],
    });
  }

  afterEach(() => {
    delete (Element.prototype as Partial<Element>).getAnimations;
    delete document.documentElement.dataset.reducedMotion;
  });

  it("gives the recap the deliberate reveal and the cards the standard one", async () => {
    mockAll();
    runExitAnimations();
    let resolveScreens!: (
      value: Awaited<ReturnType<typeof api.screens>>,
    ) => void;
    vi.spyOn(api, "screens").mockImplementation(
      () => new Promise((resolve) => (resolveScreens = resolve)),
    );
    renderPage();
    await screen.findByRole("status", { name: "Loading fleet status" });

    act(() => {
      resolveScreens({ items: [screenFixture()], total: 1 });
    });

    const recap = await screen.findByTestId("overview-recap");
    expect(recap.closest("[data-load-reveal]")).toHaveAttribute(
      "data-load-reveal",
      "deliberate",
    );
    expect(
      screen.getByTestId("fleet-status").closest("[data-load-reveal]"),
    ).toHaveAttribute("data-load-reveal", "standard");
    // The recap announces nothing just because it animated.
    expect(recap.closest("[aria-live]")).toBeNull();
    expect(recap).not.toHaveAttribute("aria-live");
  });

  it("takes the loading placeholders out of the accessibility tree once resolved", async () => {
    mockAll();
    runExitAnimations();
    renderPage();

    await screen.findByTestId("fleet-status");
    await region("Content health");

    // Outgoing layers are still fading but are neither announced nor focusable.
    const outgoing = document.querySelectorAll("[data-load-reveal-exit]");
    expect(outgoing.length).toBeGreaterThan(0);
    for (const layer of outgoing) {
      expect(layer).toHaveAttribute("aria-hidden", "true");
      expect(layer).toHaveAttribute("inert");
    }
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    for (const layer of outgoing) fireEvent.animationEnd(layer);
    expect(document.querySelector("[data-load-reveal-exit]")).toBeNull();
  });

  it("settles each section when its own query resolves, in any order", async () => {
    mockAll();
    runExitAnimations();
    let resolveContent!: (value: ContentHealthReport) => void;
    vi.spyOn(api, "contentHealth").mockImplementation(
      () => new Promise((resolve) => (resolveContent = resolve)),
    );
    renderPage();

    await screen.findByTestId("fleet-status");
    await screen.findByText(/No upcoming change/);
    // Content health is still loading while its neighbors have settled.
    expect(
      screen.getByRole("status", { name: "Loading content health" }),
    ).toBeInTheDocument();

    act(() => {
      resolveContent(healthyContent);
    });
    expect(
      await screen.findByText("Nothing needs attention."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "Loading content health" }),
    ).not.toBeInTheDocument();
  });

  it("does not return to loading when the screens refetch in the background", async () => {
    mockAll();
    runExitAnimations();
    const client = renderWithClient();
    await screen.findByTestId("fleet-status");
    for (const layer of document.querySelectorAll("[data-load-reveal-exit]"))
      fireEvent.animationEnd(layer);
    const fleetLayer = screen
      .getByTestId("fleet-status")
      .closest("[data-load-reveal]");

    vi.spyOn(api, "screens").mockImplementation(never);
    act(() => {
      void client.invalidateQueries({ queryKey: ["screens"] });
    });
    await waitFor(() =>
      expect(client.isFetching({ queryKey: ["screens"] })).toBe(1),
    );

    expect(screen.getByTestId("fleet-status")).toBeInTheDocument();
    expect(screen.getByTestId("overview-recap")).toBeInTheDocument();
    expect(
      screen.getByTestId("fleet-status").closest("[data-load-reveal]"),
    ).toBe(fleetLayer);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(document.querySelector("[data-load-reveal-exit]")).toBeNull();
    expect(document.querySelector('[data-state="loading"]')).toBeNull();
  });

  it("leaves nothing behind and no movement under reduced motion", async () => {
    mockAll();
    document.documentElement.dataset.reducedMotion = "true";
    renderPage();

    await screen.findByTestId("fleet-status");
    await screen.findByTestId("overview-recap");

    expect(document.querySelector("[data-load-reveal-exit]")).toBeNull();
    expect(document.querySelector("[data-load-reveal]")).toBeNull();
  });

  it("lets the loading placeholder give way to a failed load", async () => {
    mockAll();
    runExitAnimations();
    let rejectScreens!: (reason: Error) => void;
    vi.spyOn(api, "screens").mockImplementation(
      () => new Promise((_, reject) => (rejectScreens = reject)),
    );
    renderPage();
    await screen.findByRole("status", { name: "Loading fleet status" });

    act(() => {
      rejectScreens(new Error("x"));
    });

    const alert = await screen.findByText("Player status could not be loaded");
    expect(alert.closest("[data-load-reveal]")).not.toBeNull();
    expect(screen.queryByTestId("fleet-status")).not.toBeInTheDocument();
    // The Fleet slot has nothing to show, so its skeleton goes with no fade.
    expect(
      screen.queryByRole("status", { name: "Loading fleet status" }),
    ).not.toBeInTheDocument();
  });

  it("reveals the empty installation prompt in the fleet slot", async () => {
    mockAll({ screens: [] });
    runExitAnimations();
    renderPage();

    const title = await screen.findByText("No screens paired yet");
    expect(title.closest("[data-load-reveal]")).toHaveAttribute(
      "data-load-reveal",
      "standard",
    );
  });
});

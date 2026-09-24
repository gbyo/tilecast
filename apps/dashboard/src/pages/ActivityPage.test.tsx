// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityPage } from "./ActivityPage";
import { api } from "../api/client";

const authStatus = {
  authenticated: true,
  csrfToken: "token",
  user: { id: "user-1", name: "Owner", role: "owner" },
};

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: authStatus }),
}));

// The uptime panel has its own coverage; it is noise in these cases.
vi.mock("../components/FleetUptimePanel", () => ({
  FleetUptimePanel: () => <div data-testid="uptime" />,
}));

const cards = {
  screensWithReportingGaps: 2,
  confirmedScreenPlaybackMs: 7_200_000,
  contentExposureMs: 14_400_000,
  playbackFailures: 5,
  interruptedPlays: 1,
  takeoverActivations: 0,
  failedPlayerUpdates: 0,
  recentAdministrativeChanges: 4,
};

const fleet = {
  measured: 12,
  online: 10,
  healthy: 7,
  impaired: 3,
  offline: 2,
  unmeasured: 0,
};

const incident = {
  id: "incident-1",
  incidentType: "connectivity",
  severity: "critical",
  status: "open",
  title: "Screen stopped reporting",
  description: "Screen is not reporting.",
  openedAt: "2026-07-26T08:00:00.000Z",
  lastSeenAt: "2026-07-26T08:30:00.000Z",
  primaryScreenId: "screen-2",
  primaryScreenName: "Cafeteria",
  affectedScreens: 1,
  occurrenceCount: 2,
};

const incidentAnalytics = {
  activeIncidents: 1,
  incidentsOpened: 1,
  incidentsResolved: 0,
  meanTimeToRecoverSeconds: null,
  medianTimeToRecoverSeconds: null,
  longestIncidentSeconds: null,
  automaticRecoveries: 0,
  manualRecoveries: 0,
  recurring: [],
  byScreen: [],
  byLocation: [],
  byDeviceModel: [],
  byPlayerVersion: [],
  byFailureCode: [],
  byType: [],
};

/** The comparison window returns smaller numbers, so deltas are non-zero. */
const previousCards = { ...cards, playbackFailures: 2 };

function overviewBody(request: string) {
  const to = new URL(request, "http://localhost").searchParams.get("to")!;
  // The comparison request asks for the window ending where this one starts.
  const isPrevious = Date.parse(to) < Date.now() - 12 * 3_600_000;
  return {
    data: {
      range: { from: "", to: "" },
      cards: isPrevious ? previousCards : cards,
      fleet,
      timeline: [],
    },
  };
}

function renderPage(path = "/activity") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/activity"
            element={
              <>
                <ActivityPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output>{location.search}</output>;
}

beforeEach(() => {
  authStatus.user.role = "owner";
  vi.spyOn(api, "screens").mockResolvedValue({
    items: [{ id: "screen-1", name: "Lobby north" }],
  } as never);
  vi.spyOn(api, "screenGroups").mockResolvedValue({
    items: [{ id: "group-1", name: "Main building" }],
  } as never);
  vi.spyOn(api, "users").mockResolvedValue({ items: [] } as never);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = url.includes("/activity/overview")
        ? overviewBody(url)
        : url.includes("/incidents/analytics")
          ? { data: incidentAnalytics }
          : url.includes("/incidents")
            ? { data: { items: [incident] } }
            : { data: { items: [], nextCursor: "" } };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Activity overview", () => {
  it("states the comparison period on a metric that moved", async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Up 3 from previous 24 hours/)).toBeTruthy(),
    );
  });

  it("builds Needs attention from incidents, not the latest bad event", async () => {
    renderPage();

    // The section now reads open incidents; ordering and lifecycle behaviour
    // has its own coverage in ActivityIncidents.test.tsx.
    const section = await screen.findByRole("region", {
      name: "Needs attention",
    });
    expect(within(section).getByText("Screen stopped reporting")).toBeTruthy();
    expect(within(section).getByText("Cafeteria")).toBeTruthy();
    // It is current state, and says so rather than looking range-scoped.
    expect(section.textContent).toContain("right now");
  });

  it("links a metric to the records behind it", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen
          .getByRole("link", { name: /Playback failures/ })
          .getAttribute("href"),
      ).toBe("/activity?tab=proof&result=failed"),
    );
  });

  it("keeps a preset date range when opening the records behind a metric", async () => {
    renderPage("/activity?range=30d");

    await waitFor(() =>
      expect(
        screen
          .getByRole("link", { name: /Playback failures/ })
          .getAttribute("href"),
      ).toBe("/activity?tab=proof&range=30d&result=failed"),
    );
  });

  it("keeps both bounds of a custom date range", async () => {
    renderPage(
      "/activity?range=custom&from=2026-07-01T00:00&to=2026-07-14T12:30",
    );

    await waitFor(() =>
      expect(
        screen
          .getByRole("link", { name: /Failed Player updates/ })
          .getAttribute("href"),
      ).toBe(
        "/activity?tab=events&range=custom&from=2026-07-01T00%3A00&to=2026-07-14T12%3A30&category=updates&result=failed",
      ),
    );
  });

  it("does not carry a filter the destination tab cannot apply", async () => {
    renderPage("/activity?range=7d");

    await waitFor(() =>
      expect(
        screen
          .getByRole("link", { name: /Administrative changes/ })
          .getAttribute("href"),
        // The Audit Log has no category control, and its result vocabulary is
        // its own; only the range and a valid result survive.
      ).toBe("/activity?tab=audit&range=7d&result=success"),
    );
  });
});

describe("Playback metric semantics", () => {
  it("reports screen wall clock and content exposure as separate numbers", async () => {
    renderPage();

    // Two hours of screen time with four hours of content across zones is a
    // real shape; one must never be summed into the other.
    const screenTime = await screen.findByRole("link", {
      name: /Confirmed screen playback/,
    });
    expect(screenTime.textContent).toContain("2h 0m");
    expect(screenTime.getAttribute("href")).toBe(
      "/activity?tab=proof&sessionType=presentation",
    );
    const exposure = screen.getByRole("link", { name: /Content exposure/ });
    expect(exposure.textContent).toContain("4h 0m");
  });

  it("does not use the word coverage for a session outcome rate", async () => {
    renderPage();

    await screen.findByRole("link", { name: /Confirmed screen playback/ });
    expect(document.body.textContent).not.toMatch(/coverage/i);
  });

  it("opens interrupted plays on the sessions that ended unexpectedly", async () => {
    renderPage("/activity?range=7d");

    await waitFor(() =>
      expect(
        screen
          .getByRole("link", { name: /Interrupted plays/ })
          .getAttribute("href"),
        // Not result=partial: a scheduled changeover is partial and expected.
      ).toBe("/activity?tab=proof&range=7d&terminalReason=unexpected"),
    );
  });

  it("weights the completion rate by sessions rather than by screens", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = url.includes("/proof-of-play/summary")
        ? {
            data: {
              dimension: "screen",
              items: [
                {
                  key: "screen-1",
                  label: "One session",
                  confirmedScreenPlaybackMs: 1_000,
                  contentExposureMs: 0,
                  records: 1,
                  completed: 1,
                  failures: 0,
                  partial: 0,
                  unknown: 0,
                  interrupted: 0,
                  sessionCompletionPercent: 100,
                },
                {
                  key: "screen-2",
                  label: "Ninety-nine sessions",
                  confirmedScreenPlaybackMs: 99_000,
                  contentExposureMs: 0,
                  records: 99,
                  completed: 0,
                  failures: 99,
                  partial: 0,
                  unknown: 0,
                  interrupted: 0,
                  sessionCompletionPercent: 0,
                },
              ],
            },
          }
        : { data: { items: [], nextCursor: "" } };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    renderPage("/activity?tab=proof");

    const label = await screen.findByText("Session completion rate");
    expect(label.closest("article")?.textContent).toContain("1%");
    expect(label.closest("article")?.textContent).not.toContain("50%");
  });
});

describe("Activity permissions", () => {
  it("does not link viewers into privileged reports", async () => {
    authStatus.user.role = "viewer";
    renderPage();

    const updates = await screen.findByText("Failed Player updates");
    expect(updates.closest("a")).toBeNull();
    const changes = screen.getByText("Administrative changes");
    expect(changes.closest("a")).toBeNull();
  });

  it("does not offer Screen Events as a viewer empty-state action", async () => {
    authStatus.user.role = "viewer";
    renderPage("/activity?tab=proof");

    await screen.findByText("No confirmed playback found");
    expect(
      screen.queryByRole("button", { name: "View screen events" }),
    ).toBeNull();
  });

  it("does not render a privileged tab from a direct viewer URL", async () => {
    authStatus.user.role = "viewer";
    renderPage("/activity?tab=events");

    await screen.findByRole("region", { name: "Fleet health" });
    expect(screen.queryByRole("tab", { name: "Screen Events" })).toBeNull();
    expect(document.body.textContent).not.toContain(
      "Significant diagnostic activity",
    );
  });
});

describe("Fleet health", () => {
  it("reports all four states plus reachability, distinctly", async () => {
    renderPage();

    const section = await screen.findByRole("region", { name: "Fleet health" });
    const expected: [string, string][] = [
      ["Online", "10"],
      ["Healthy", "7"],
      ["Impaired", "3"],
      ["Offline", "2"],
      ["Unmeasured", "0"],
    ];
    for (const [label, value] of expected) {
      const tile = within(section).getByText(label).closest("a, article");
      expect(tile?.textContent).toContain(value);
    }
  });

  it("does not present a heartbeat count as healthy playback", async () => {
    renderPage();

    const section = await screen.findByRole("region", { name: "Fleet health" });
    expect(section.textContent).not.toContain("reporting normally");
    // Online and Healthy are separate counts, so one cannot stand in for the other.
    expect(within(section).getByText("Online")).toBeTruthy();
    expect(within(section).getByText("Healthy")).toBeTruthy();
  });

  it("sends a playback-gap drill-down to the events that produced it", async () => {
    renderPage("/activity?range=30d");

    await waitFor(() =>
      expect(
        screen
          .getByRole("link", { name: /Screens with reporting gaps/ })
          .getAttribute("href"),
        // Heartbeat gaps are warning-level, so severity=error would exclude them.
      ).toBe("/activity?tab=events&range=30d&category=connectivity"),
    );
  });
});

describe("Activity filters", () => {
  it("puts a filter in the URL so the view can be shared", async () => {
    const user = userEvent.setup();
    renderPage("/activity?tab=proof");

    await user.click(await screen.findByRole("combobox", { name: "Screen" }));
    await user.click(
      await screen.findByRole("option", { name: "Lobby north" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "screen=screen-1",
      ),
    );
  });

  it("shows an active filter as a chip and clears it", async () => {
    const user = userEvent.setup();
    renderPage("/activity?tab=proof&screen=screen-1");

    const chip = await screen.findByRole("button", {
      name: /Remove filter Screen: Lobby north/,
    });
    await user.click(chip);

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).not.toContain("screen="),
    );
  });

  it("drops a filter the next tab cannot apply when switching tabs", async () => {
    const user = userEvent.setup();
    renderPage("/activity?tab=proof&screen=screen-1&media=asset-1");

    await user.click(await screen.findByRole("tab", { name: "Audit Log" }));

    await waitFor(() => {
      const search = screen.getByRole("status").textContent ?? "";
      expect(search).toContain("tab=audit");
      expect(search).not.toContain("screen=");
      expect(search).not.toContain("media=");
    });
  });

  it("chips an advanced filter even though its control is behind a disclosure", async () => {
    renderPage("/activity?tab=proof&media=asset-1");

    expect(
      await screen.findByRole("button", {
        name: /Remove filter Media: asset-1/,
      }),
    ).toBeTruthy();
  });
});

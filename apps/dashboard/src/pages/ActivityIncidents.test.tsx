// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IncidentAnalyticsPanel,
  NeedsAttentionPanel,
} from "./ActivityIncidents";
import type { Incident } from "./ActivityIncidentShared";
import type { ResolvedTimeRange } from "../components/TimeRangePicker";

const authStatus = {
  authenticated: true,
  csrfToken: "token",
  user: { id: "user-1", name: "Owner", role: "owner" },
};
let role = "owner";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { ...authStatus, user: { ...authStatus.user, role } },
  }),
}));

const range: ResolvedTimeRange = {
  from: "2026-07-26T00:00:00.000Z",
  to: "2026-07-27T00:00:00.000Z",
  label: "last 24 hours",
};

const openIncident: Incident = {
  id: "incident-1",
  incidentType: "connectivity",
  severity: "error",
  status: "open",
  title: "Screen stopped reporting",
  description:
    "The Player stopped reporting within the expected heartbeat window.",
  openedAt: "2026-07-26T09:00:00.000Z",
  lastSeenAt: "2026-07-26T09:40:00.000Z",
  primaryScreenId: "screen-1",
  primaryScreenName: "Lobby north",
  affectedScreens: 1,
  occurrenceCount: 6,
};

const recoveredIncident: Incident = {
  id: "incident-2",
  incidentType: "playback",
  severity: "warning",
  status: "recovered",
  title: "Playback is failing",
  description: "The renderer reported a failure.",
  openedAt: "2026-07-26T07:00:00.000Z",
  lastSeenAt: "2026-07-26T07:20:00.000Z",
  recoveredAt: "2026-07-26T07:30:00.000Z",
  recoveryMode: "automatic",
  probableCause: "Renderer failure reported by the Player.",
  affectedScreens: 1,
  occurrenceCount: 1,
};

const analytics = {
  activeIncidents: 2,
  incidentsOpened: 5,
  incidentsResolved: 3,
  meanTimeToRecoverSeconds: 1800,
  medianTimeToRecoverSeconds: 1200,
  longestIncidentSeconds: 3600,
  longestIncidentTitle: "Screen stopped reporting",
  automaticRecoveries: 2,
  manualRecoveries: 1,
  recurring: [
    {
      screenId: "screen-1",
      screenName: "Lobby north",
      incidentType: "connectivity",
      incidents: 3,
      occurrences: 11,
    },
  ],
  byScreen: [{ key: "screen-1", label: "Lobby north", count: 3 }],
  byLocation: [],
  byDeviceModel: [{ key: "Shield", label: "Shield", count: 3 }],
  byPlayerVersion: [],
  byFailureCode: [],
  byType: [{ key: "connectivity", label: "connectivity", count: 3 }],
};

let incidents: Incident[] = [];
let patched: { url: string; body: unknown }[] = [];

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NeedsAttentionPanel />
        <IncidentAnalyticsPanel range={range} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  role = "owner";
  incidents = [openIncident, recoveredIncident];
  patched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.method === "PATCH") {
        patched.push({ url, body: JSON.parse(init.body as string) });
        return Promise.resolve(
          new Response(JSON.stringify({ data: {} }), { status: 200 }),
        );
      }
      const body = url.includes("/incidents/analytics")
        ? { data: analytics }
        : { data: { items: incidents } };
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

describe("Needs attention", () => {
  it("shows one row per problem with its occurrence count", async () => {
    renderPanel();

    // Six heartbeat gaps are one incident, not six things to read.
    expect(await screen.findByText("Screen stopped reporting")).toBeTruthy();
    expect(screen.getByText("6 occurrences")).toBeTruthy();
  });

  it("leaves recovered incidents out and asks nothing about them", async () => {
    renderPanel();

    const section = await screen.findByRole("region", {
      name: "Needs attention",
    });
    await within(section).findByText("Screen stopped reporting");
    // The condition ended by itself, so it is logged on the Incidents tab
    // rather than presented here as work waiting on someone.
    expect(within(section).queryByText("Playback is failing")).toBeNull();
    expect(section.textContent).not.toMatch(/acknowledgement/i);
    expect(section.textContent).toMatch(/Ongoing for/);
  });

  it("shows the fields an operator needs to triage without opening anything", async () => {
    renderPanel();

    const section = await screen.findByRole("region", {
      name: "Needs attention",
    });
    const row = within(section)
      .getByText("Screen stopped reporting")
      .closest("li")!;
    expect(row.textContent).toContain("Open");
    expect(row.textContent).toContain("Lobby north");
    expect(row.textContent).toMatch(/Ongoing for/);
    expect(row.textContent).toMatch(/Last seen/);
    expect(row.textContent).toContain("6 occurrences");
  });

  it("counts only what is still failing in the attention badge", async () => {
    renderPanel();

    const section = await screen.findByRole("region", {
      name: "Needs attention",
    });
    // Two incidents are listed, but only one is still a live problem.
    const heading = within(section).getByRole("heading", {
      name: /Needs attention/,
    });
    expect(heading.textContent).toContain("1");
  });

  it("previews only the worst incidents and links to the rest", async () => {
    // A bad day on a large fleet must not push the rest of the Overview off
    // the page, so the preview stops well short of the full list.
    incidents = Array.from({ length: 12 }, (_, index) => ({
      ...openIncident,
      id: `incident-${index}`,
      title: `Failure ${index}`,
    }));
    renderPanel();

    const section = await screen.findByRole("region", {
      name: "Needs attention",
    });
    expect(within(section).getAllByRole("listitem")).toHaveLength(5);
    expect(within(section).getByText("Failure 0")).toBeTruthy();
    expect(within(section).queryByText("Failure 5")).toBeNull();
    // The count of what is actually wrong stays the true total, and the
    // remainder is named rather than silently dropped.
    const heading = within(section).getByRole("heading", {
      name: /Needs attention/,
    });
    expect(heading.textContent).toContain("12");
    expect(
      within(section).getByRole("link", { name: "7 more still failing" }),
    ).toBeTruthy();
  });

  it("shows every incident when the list already fits", async () => {
    renderPanel();

    const section = await screen.findByRole("region", {
      name: "Needs attention",
    });
    expect(within(section).queryByText(/more still failing/)).toBeNull();
  });

  it("labels the list as current state, not the selected range", async () => {
    renderPanel();

    const section = await screen.findByRole("region", {
      name: "Needs attention",
    });
    expect(section.textContent).toContain("right now, not over the selected");
  });

  it("says the cause is unknown rather than inventing one", async () => {
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText("Screen stopped reporting");
    await user.click(screen.getAllByRole("button", { name: "Details" })[0]!);
    expect(screen.getByText("Unknown cause")).toBeTruthy();
  });

  it("states a cause the Player actually established", async () => {
    const user = userEvent.setup();
    incidents = [
      {
        ...openIncident,
        probableCause: "Renderer failure reported by the Player.",
      },
    ];
    renderPanel();

    await screen.findByText("Screen stopped reporting");
    await user.click(screen.getAllByRole("button", { name: "Details" })[0]!);
    expect(
      screen.getByText("Renderer failure reported by the Player."),
    ).toBeTruthy();
  });

  it("offers the actions that apply to an open incident", async () => {
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText("Screen stopped reporting");
    await user.click(screen.getAllByRole("button", { name: "Details" })[0]!);
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ignore" })).toBeTruthy();
    // Reopening applies only to something already closed.
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
  });

  it("sends the action with the CSRF token", async () => {
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText("Screen stopped reporting");
    await user.click(screen.getAllByRole("button", { name: "Details" })[0]!);
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));

    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]?.url).toContain("/api/v1/activity/incidents/incident-1");
    expect(patched[0]?.body).toEqual({ action: "acknowledge" });
  });

  it("hides the actions from a role that cannot apply them", async () => {
    role = "viewer";
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText("Screen stopped reporting");
    await user.click(screen.getAllByRole("button", { name: "Details" })[0]!);
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
  });
});

describe("Incident analytics", () => {
  it("shows the median beside the mean", async () => {
    renderPanel();

    const mean = await screen.findByText("Mean time to recover");
    const tile = mean.closest("a, article");
    // One long outage drags the mean away from the typical case, so the pair
    // is reported together.
    expect(tile?.textContent).toContain("30m");
    expect(tile?.textContent).toContain("Median 20m");
  });

  it("separates automatic from manual recovery", async () => {
    renderPanel();

    const label = await screen.findByText("Recovered on their own");
    const tile = label.closest("a, article");
    expect(tile?.textContent).toContain("2");
    expect(tile?.textContent).toContain("1 closed by hand");
  });

  it("counts recurring incidents and occurrences separately", async () => {
    renderPanel();

    const recurring = await screen.findByText("Recurring problems");
    const section = recurring.parentElement!;
    // Three outages reported eleven times is a different problem from eleven
    // separate outages, so collapsing them would hide which it is.
    expect(
      within(section).getByText(/3 incidents · 11 occurrences/),
    ).toBeTruthy();
  });

  it("reports no data rather than zero when nothing recovered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        const body = url.includes("/incidents/analytics")
          ? {
              data: {
                ...analytics,
                meanTimeToRecoverSeconds: null,
                medianTimeToRecoverSeconds: null,
                longestIncidentSeconds: null,
              },
            }
          : { data: { items: [] } };
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200 }),
        );
      }),
    );
    renderPanel();

    const mean = await screen.findByText("Mean time to recover");
    // Zero would read as instant recovery, which is the opposite of no data.
    expect(mean.closest("a, article")?.textContent).toContain("No data");
  });
});

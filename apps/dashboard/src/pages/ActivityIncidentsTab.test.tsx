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

let role = "owner";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      authenticated: true,
      csrfToken: "token",
      user: { id: "user-1", name: "Owner", role },
    },
  }),
}));

vi.mock("../components/FleetUptimePanel", () => ({
  FleetUptimePanel: () => <div data-testid="uptime" />,
}));

const incident = {
  id: "incident-1",
  incidentType: "connectivity",
  severity: "critical",
  status: "open",
  title: "Screen stopped reporting",
  description: "The Player stopped reporting.",
  openedAt: "2026-07-26T09:00:00.000Z",
  lastSeenAt: "2026-07-26T09:40:00.000Z",
  primaryScreenId: "screen-1",
  primaryScreenName: "Lobby north",
  affectedScreens: 1,
  occurrenceCount: 3,
  failureCode: "heartbeat_gap",
};

const detail = {
  ...incident,
  recoveryPath: "Not recovered yet.",
  timeline: [
    {
      id: "entry-1",
      role: "opened",
      occurredAt: "2026-07-26T09:00:00.000Z",
      summary: "Screen stopped reporting",
    },
  ],
  screens: [],
  relatedEvents: [
    {
      id: "event-1",
      timestamp: "2026-07-26T09:01:00.000Z",
      receivedAt: "2026-07-26T09:01:00.000Z",
      screenId: "screen-1",
      screenName: "Lobby north",
      eventType: "heartbeat.gap_detected",
      category: "connectivity",
      severity: "warning",
      description: "Heartbeat gap",
      result: "unknown",
      details: {},
    },
    {
      id: "event-2",
      timestamp: "2026-07-26T09:05:00.000Z",
      receivedAt: "2026-07-26T09:05:00.000Z",
      screenId: "screen-1",
      screenName: "Lobby north",
      eventType: "command.created",
      category: "commands",
      severity: "info",
      description: "Restart requested",
      result: "success",
      details: {},
    },
  ],
  proofSessions: [
    {
      id: "session-1",
      startedAt: "2026-07-26T08:55:00.000Z",
      screenId: "screen-1",
      screenName: "Lobby north",
      result: "unknown",
      sessionType: "presentation",
      terminalReason: "heartbeat_gap",
      actualDurationMs: 300_000,
      presentationName: "Lobby loop",
      details: {},
    },
  ],
  auditChanges: [
    {
      id: "audit-1",
      timestamp: "2026-07-26T09:10:00.000Z",
      actorName: "Owner",
      action: "screen.updated",
      resourceType: "screen",
      result: "success",
      summary: "Renamed the screen",
      metadata: {},
    },
  ],
};

// An incident whose condition ended by itself: a record of an outage, with
// nothing left for an operator to do about it.
const recoveredIncident = {
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
  affectedScreens: 1,
  occurrenceCount: 1,
};

const recoveredDetail = {
  ...recoveredIncident,
  recoveryPath: "The renderer recovered on its own.",
  timeline: [],
  screens: [],
  relatedEvents: [],
  proofSessions: [],
  auditChanges: [],
};

let listed: unknown[] = [];
let patched: { url: string; body: unknown }[] = [];

function renderTab(path = "/activity?tab=incidents") {
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
  role = "owner";
  listed = [incident];
  patched = [];
  vi.spyOn(api, "screens").mockResolvedValue({
    items: [{ id: "screen-1", name: "Lobby north" }],
  } as never);
  vi.spyOn(api, "screenGroups").mockResolvedValue({
    items: [{ id: "group-1", name: "Main building" }],
  } as never);
  vi.spyOn(api, "users").mockResolvedValue({
    items: [{ id: "user-1", name: "Owner" }],
  } as never);
  vi.spyOn(api, "locations").mockResolvedValue({
    items: [{ id: "location-1", name: "North campus" }],
  } as never);
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
      const body = url.includes("/incidents/incident-1")
        ? { data: detail }
        : url.includes("/incidents/incident-2")
          ? { data: recoveredDetail }
          : url.includes("/incidents")
            ? { data: { items: listed } }
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

describe("Activity navigation", () => {
  it("offers Incidents between Proof of Play and Screen Events", async () => {
    renderTab("/activity?tab=incidents");

    const tabs = await screen.findByRole("tablist", {
      name: "Activity reports",
    });
    const labels = within(tabs)
      .getAllByRole("tab")
      .map((tab) => tab.textContent);
    expect(labels).toEqual([
      "Overview",
      "Proof of Play",
      "Incidents",
      "Content Health",
      "Screen Events",
      "Audit Log",
    ]);
  });

  it("keeps Screen Events privileged while Incidents stays available", async () => {
    role = "viewer";
    renderTab("/activity?tab=incidents");

    const tabs = await screen.findByRole("tablist", {
      name: "Activity reports",
    });
    const labels = within(tabs)
      .getAllByRole("tab")
      .map((tab) => tab.textContent);
    // The raw diagnostic stream stays restricted; the grouped view does not.
    expect(labels).toContain("Incidents");
    expect(labels).not.toContain("Screen Events");
  });
});

describe("Incidents tab filters", () => {
  it("puts a filter in the URL so the view can be shared", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("combobox", { name: "Severity" }));
    await user.click(await screen.findByRole("option", { name: "Critical" }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "severity=critical",
      ),
    );
  });

  it("chips an active filter and clears it", async () => {
    const user = userEvent.setup();
    renderTab("/activity?tab=incidents&type=connectivity");

    const chip = await screen.findByRole("button", {
      name: /Remove filter Category: Connectivity/,
    });
    await user.click(chip);

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).not.toContain("type="),
    );
  });

  it("offers every documented incident filter", async () => {
    renderTab();

    // Every filter the Incidents report is specified to support, each one
    // URL-backed so the view can be shared.
    await screen.findByRole("combobox", { name: "Status" });
    for (const label of [
      "Search incidents",
      "Status",
      "Severity",
      "Category",
      "Screen",
      "Group",
      "Location",
      "Assigned to",
      "Failure code",
      "Date basis",
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });

  it("does not apply the date range until a basis says which date", async () => {
    renderTab("/activity?tab=incidents&range=7d");

    // Guessing between opened, recovered and resolved would silently change
    // which incidents the reader is looking at.
    expect(
      await screen.findByText(/Add a date basis to report over/),
    ).toBeTruthy();
    const calls = vi
      .mocked(fetch)
      .mock.calls.map(([input]) =>
        input instanceof Request ? input.url : String(input),
      );
    const listCall = calls.find(
      (url) => url.includes("/incidents") && !url.includes("analytics"),
    );
    expect(listCall).not.toContain("from=");
  });

  it("applies the range once a basis is chosen", async () => {
    renderTab("/activity?tab=incidents&range=7d&dateBasis=resolved");

    await screen.findByText(/Incidents by resolved date/);
    const calls = vi
      .mocked(fetch)
      .mock.calls.map(([input]) =>
        input instanceof Request ? input.url : String(input),
      );
    const listCall = calls.find(
      (url) => url.includes("/incidents?") && !url.includes("analytics"),
    );
    expect(listCall).toContain("dateBasis=resolved");
    expect(listCall).toContain("from=");
  });
});

describe("Incident details drawer", () => {
  it("shows the summary, timeline, evidence and recovery path", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: "Details" }));

    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("Not recovered yet.")).toBeTruthy();
    expect(within(drawer).getByText("Timeline")).toBeTruthy();
    expect(within(drawer).getByText("Related raw events")).toBeTruthy();
    expect(
      within(drawer).getByText("Playback during the incident"),
    ).toBeTruthy();
    expect(within(drawer).getByText("Commands and updates")).toBeTruthy();
    expect(within(drawer).getByText("Administrative changes")).toBeTruthy();
    // The evidence itself, not just the headings.
    expect(within(drawer).getByText(/Heartbeat Gap Detected/)).toBeTruthy();
    expect(within(drawer).getByText(/Lobby loop/)).toBeTruthy();
    expect(within(drawer).getByText(/Renamed the screen/)).toBeTruthy();
  });

  it("links to the affected screen's Activity", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: "Details" }));
    const drawer = await screen.findByRole("dialog");
    expect(
      within(drawer)
        .getByRole("link", { name: "Open the screen's Activity" })
        .getAttribute("href"),
    ).toBe("/screens/screen-1?tab=activity");
  });

  it("applies an action from the drawer", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: "Details" }));
    const drawer = await screen.findByRole("dialog");
    await user.click(
      within(drawer).getByRole("button", { name: "Acknowledge" }),
    );

    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]?.body).toMatchObject({ action: "acknowledge" });
  });
});

describe("Recovered incidents", () => {
  it("logs what happened without asking anyone to sign it off", async () => {
    listed = [recoveredIncident];
    renderTab();

    const row = (await screen.findByText("Playback is failing")).closest("li")!;
    // Opened 07:00, recovered 07:30: what it cost, not what is owed.
    expect(row.textContent).toContain("Lasted 30m");
    expect(row.textContent).toMatch(/Recovered .*on its own/);
    expect(row.textContent).not.toMatch(/Ongoing/);
    expect(row.textContent).not.toMatch(/acknowledge/i);
  });

  it("offers only Reopen, since the condition already ended", async () => {
    const user = userEvent.setup();
    listed = [recoveredIncident];
    renderTab();

    await user.click(await screen.findByRole("button", { name: "Details" }));
    const drawer = await screen.findByRole("dialog");
    expect(
      within(drawer).queryByRole("button", { name: "Acknowledge" }),
    ).toBeNull();
    expect(
      within(drawer).queryByRole("button", { name: "Resolve" }),
    ).toBeNull();
    expect(within(drawer).getByRole("button", { name: "Reopen" })).toBeTruthy();
  });
});

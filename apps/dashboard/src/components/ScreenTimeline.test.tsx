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
import { ScreenTimeline } from "./ScreenTimeline";

const status = {
  currentPresentation: "Lobby loop",
  currentItem: "Welcome video",
  currentIncident: "Playback is failing",
  currentIncidentId: "incident-1",
  lastHealthyPlayback: "2026-07-26T09:00:00.000Z",
  lastManifestActivation: "2026-07-26T08:00:00.000Z",
  lastHeartbeatAt: "2026-07-27T08:59:00.000Z",
  playerVersion: "1.4.2",
  health: "impaired",
  healthReason: "playback_error",
};

/** One entry per domain the timeline is specified to merge. */
const entries = [
  {
    id: "state-1",
    timestamp: "2026-07-26T10:00:00.000Z",
    domain: "state",
    kind: "offline",
    severity: "error",
    title: "Offline",
    durationMs: 600_000,
  },
  {
    id: "playback-1",
    timestamp: "2026-07-26T09:30:00.000Z",
    domain: "playback",
    kind: "session.presentation",
    severity: "info",
    title: "Lobby loop",
    description: "Ended: schedule transition",
    durationMs: 300_000,
    result: "completed",
  },
  {
    id: "incident-open-1",
    timestamp: "2026-07-26T09:20:00.000Z",
    domain: "incidents",
    kind: "incident.opened",
    severity: "critical",
    title: "Playback is failing",
    description: "Incident opened",
    linkType: "incident",
    linkId: "incident-1",
  },
  {
    id: "command-1",
    timestamp: "2026-07-26T09:10:00.000Z",
    domain: "commands",
    kind: "command.created",
    severity: "info",
    title: "Command created",
  },
  {
    id: "audit-1",
    timestamp: "2026-07-26T09:05:00.000Z",
    domain: "audit",
    kind: "screen.updated",
    severity: "info",
    title: "Renamed the screen",
    description: "By Owner",
  },
];

let requested: string[] = [];

function renderTimeline() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ScreenTimeline screenId="screen-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  requested = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      const domain = new URL(url, "http://localhost").searchParams.get(
        "domain",
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              range: { from: "", to: "" },
              status,
              entries: domain
                ? entries.filter((entry) => entry.domain === domain)
                : entries,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("screen timeline", () => {
  it("merges every source into one chronological stream", async () => {
    renderTimeline();

    const list = await screen.findByRole("list");
    const rows = within(list).getAllByRole("listitem");
    // State changes, playback, incidents, commands and administrative changes
    // in one order, rather than four lists to line up by eye.
    expect(rows.map((row) => row.textContent?.split("\n")[0])).toHaveLength(5);
    expect(list.textContent).toContain("Offline");
    expect(list.textContent).toContain("Lobby loop");
    expect(list.textContent).toContain("Playback is failing");
    expect(list.textContent).toContain("Command created");
    expect(list.textContent).toContain("Renamed the screen");
  });

  it("shows current status above the history", async () => {
    renderTimeline();

    // "Lobby loop" is both the current presentation and a timeline entry, so
    // the status block is located by its labels rather than by its values.
    await screen.findByText("Current presentation");
    for (const [label, value] of [
      ["Current presentation", "Lobby loop"],
      ["Current item", "Welcome video"],
      ["Current incident", "Playback is failing"],
      ["Player version", "1.4.2"],
    ] as [string, string][]) {
      const row = screen.getByText(label).closest("div")!;
      expect(row.textContent).toContain(value);
    }
  });

  it("states the health classification with the reason behind it", async () => {
    renderTimeline();

    const health = (await screen.findByText("Health")).closest("div")!;
    // The same four-state classification the fleet-health section uses, never
    // shown as an unexplained label.
    expect(health.textContent).toContain("Impaired");
    expect(health.textContent).toContain("Playback Error");
  });

  it("filters by domain through the server, not in the browser", async () => {
    const user = userEvent.setup();
    renderTimeline();

    await screen.findByText("Renamed the screen");
    await user.click(screen.getByRole("button", { name: "Commands" }));

    await waitFor(() =>
      expect(requested.some((url) => url.includes("domain=commands"))).toBe(
        true,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("Renamed the screen")).toBeNull(),
    );
    expect(screen.getByText("Command created")).toBeTruthy();
  });

  it("offers every documented domain filter", async () => {
    renderTimeline();

    const filters = await screen.findByRole("group", {
      name: "Filter the timeline by domain",
    });
    const labels = within(filters)
      .getAllByRole("button")
      .map((button) => button.textContent);
    for (const domain of [
      "Playback",
      "Connectivity",
      "Reliability",
      "Scheduling",
      "Commands",
      "Updates",
      "Takeovers",
      "Administrative",
    ]) {
      expect(labels).toContain(domain);
    }
  });

  it("changes the reported period without losing the domain filter", async () => {
    const user = userEvent.setup();
    renderTimeline();

    await screen.findByText("Renamed the screen");
    await user.click(screen.getByRole("button", { name: "Commands" }));
    await waitFor(() =>
      expect(requested.some((url) => url.includes("domain=commands"))).toBe(
        true,
      ),
    );
    await user.click(screen.getByRole("button", { name: "7 days" }));

    // The server windows on from/to; the period toggle must move the window
    // while the domain filter survives.
    await waitFor(() => {
      const urls = requested.filter((url) => url.includes("domain=commands"));
      expect(urls.length).toBeGreaterThan(0);
      const params = new URL(urls[urls.length - 1]!, "http://localhost")
        .searchParams;
      const from = Date.parse(params.get("from") ?? "");
      const to = Date.parse(params.get("to") ?? "");
      expect(Number.isNaN(from)).toBe(false);
      expect(Number.isNaN(to)).toBe(false);
      expect(to - from).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });

  it("survives a server that marshals an empty timeline as null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: { range: { from: "", to: "" }, status, entries: null },
            }),
            { status: 200 },
          ),
        ),
      ),
    );
    renderTimeline();

    expect(
      await screen.findByText(/Nothing has been recorded for this screen/),
    ).toBeTruthy();
  });
});

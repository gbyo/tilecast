// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditTab, EventsTab, ProofTab } from "./ActivityReportTabs";

const range = {
  from: "2026-07-26T00:00:00.000Z",
  to: "2026-07-27T00:00:00.000Z",
};

const proofRecord = {
  id: "rec-1",
  startedAt: "2026-07-26T10:00:00.000Z",
  screenId: "screen-1",
  screenName: "Lobby north",
  groupName: "Main building",
  presentationType: "playlist",
  presentationId: "pl-1",
  presentationName: "Morning loop",
  contentType: "image",
  contentId: "img-1",
  contentName: "Welcome slide",
  actualDurationMs: 90_000,
  result: "completed",
  sessionType: "presentation",
  details: {},
};

const screenEvent = {
  id: "evt-1",
  timestamp: "2026-07-26T10:00:00.000Z",
  receivedAt: "2026-07-26T10:00:05.000Z",
  screenId: "screen-1",
  screenName: "Lobby north",
  groupName: "Main building",
  sequence: 42,
  eventType: "player_reboot",
  category: "player",
  severity: "warning",
  description: "Player rebooted",
  relatedType: "playlist",
  relatedId: "pl-1",
  result: "recovered",
  manifestVersion: 16,
  details: {},
};

const auditRecord = {
  id: "audit-1",
  timestamp: "2026-07-26T10:00:00.000Z",
  actorName: "Dana",
  actorUsername: "dana",
  action: "takeover_start",
  resourceType: "screen",
  resourceId: "screen-1",
  resourceName: "Lobby north",
  result: "success",
  summary: "Started a takeover on Lobby north",
  metadata: {},
};

const defaultMatchMedia = window.matchMedia.bind(window);

// Only the layout breakpoint: Base UI reads pointer queries too.
function mockDesktop() {
  window.matchMedia = (query: string) => ({
    matches: query === "(min-width: 1024px)",
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  });
}

function stubActivityFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = url.includes("/proof-of-play/summary")
        ? { data: { dimension: "screen", items: [] } }
        : url.includes("/proof-of-play")
          ? { data: { items: [proofRecord] } }
          : url.includes("/screen-events")
            ? { data: { items: [screenEvent] } }
            : url.includes("/audit")
              ? { data: { items: [auditRecord] } }
              : { data: { items: [] } };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
}

function renderTab(tab: "proof" | "events" | "audit") {
  stubActivityFetch();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {tab === "proof" && (
          <ProofTab
            range={range}
            filters={{}}
            dimension="screen"
            setDimension={() => undefined}
            hasActiveFilters={false}
            canExtendRange={false}
            onClearFilters={() => undefined}
            onExtendRange={() => undefined}
          />
        )}
        {tab === "events" && <EventsTab range={range} filters={{}} />}
        {tab === "audit" && <AuditTab range={range} filters={{}} />}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.matchMedia = defaultMatchMedia;
});

describe("Activity proof cards", () => {
  it("renders proof records as cards without a table on narrow screens", async () => {
    renderTab("proof");

    await screen.findByText("Morning loop · Welcome slide");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const card = screen.getByText("Lobby north").closest("li")!;
    expect(card.textContent).toContain("Completed");
    expect(card.textContent).toContain("Main building");
    expect(card.textContent).toContain("1m 30s");
  });

  it("opens record details from a narrow card", async () => {
    renderTab("proof");

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open details for Lobby north playback",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Welcome slide" }),
    ).toBeInTheDocument();
  });

  it("keeps the proof table on desktop", async () => {
    mockDesktop();
    renderTab("proof");

    const table = await screen.findByRole("table");
    expect(
      within(table).getByRole("columnheader", { name: "Started" }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("columnheader", { name: "Duration" }),
    ).toBeInTheDocument();
    expect(within(table).getByText("Lobby north")).toBeInTheDocument();
  });
});

describe("Activity event cards", () => {
  it("renders screen events as cards without a table on narrow screens", async () => {
    renderTab("events");

    await screen.findByText("Player Reboot");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const card = screen.getByText("Player Reboot").closest("li")!;
    expect(card.textContent).toContain("Warning");
    expect(card.textContent).toContain("Lobby north");
    expect(card.textContent).toContain("Recovered");
    expect(
      within(card).getByRole("button", { name: "View" }),
    ).toBeInTheDocument();
  });

  it("keeps the events table on desktop", async () => {
    mockDesktop();
    renderTab("events");

    const table = await screen.findByRole("table");
    expect(
      within(table).getByRole("columnheader", { name: "Severity" }),
    ).toBeInTheDocument();
    expect(within(table).getByText("Player Reboot")).toBeInTheDocument();
  });
});

describe("Activity audit cards", () => {
  it("renders audit records as cards without a table on narrow screens", async () => {
    renderTab("audit");

    await screen.findByText("Takeover Start");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const card = screen.getByText("Takeover Start").closest("li")!;
    expect(card.textContent).toContain("Success");
    expect(card.textContent).toContain("Dana");
    expect(card.textContent).toContain("Lobby north");
    expect(card.textContent).toContain("Started a takeover on Lobby north");
  });

  it("keeps the audit table on desktop", async () => {
    mockDesktop();
    renderTab("audit");

    const table = await screen.findByRole("table");
    expect(
      within(table).getByRole("columnheader", { name: "Actor" }),
    ).toBeInTheDocument();
    expect(within(table).getByText("Takeover Start")).toBeInTheDocument();
  });
});

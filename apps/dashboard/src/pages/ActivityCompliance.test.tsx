// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompliancePanel } from "./ActivityCompliance";
import type { ResolvedTimeRange } from "../components/TimeRangePicker";

const range: ResolvedTimeRange = {
  from: "2026-07-26T00:00:00.000Z",
  to: "2026-07-27T00:00:00.000Z",
  label: "last 24 hours",
};

const hour = 3_600_000;

const report = {
  // Two measurable hours, one confirmed: 50%. The excluded hour must not
  // change that number.
  measurableExpectedMs: 2 * hour,
  confirmedMs: hour,
  missedMs: hour,
  compliancePercent: 50,
  takeoverOverriddenMs: hour,
  cancelledMs: 30 * 60_000,
  notMeasurableMs: 0,
  windows: 4,
  lateStarts: 1,
  earlyEndings: 2,
  neverStarted: 1,
  offlineMisses: 1,
  failedWindows: 0,
  partialWindows: 1,
  dimension: "screen",
  breakdown: [
    {
      key: "screen-1",
      label: "Lobby north",
      measurableExpectedMs: 2 * hour,
      confirmedMs: hour,
      missedMs: hour,
      compliancePercent: 50,
      windows: 2,
      lateStarts: 1,
      earlyEndings: 0,
      neverStarted: 1,
      offlineMisses: 1,
      topFailureReason: "screen_offline",
    },
  ],
};

let requested: string[] = [];

function renderPanel(body: unknown = report) {
  requested = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      requested.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ data: body }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CompliancePanel range={range} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  requested = [];
});

describe("Playback compliance", () => {
  it("reports compliance from measurable expected screen-time", async () => {
    renderPanel();

    const tile = (await screen.findByText("Playback compliance")).closest(
      "a, article",
    )!;
    expect(tile.textContent).toContain("50.0%");
  });

  it("shows the excluded time rather than hiding it in the denominator", async () => {
    renderPanel();

    const excluded = (await screen.findByText("Excluded from the percentage"))
      .parentElement!;
    // A takeover and an operator's own stop are not missed playback, but
    // dropping them silently would make the percentage unexplainable.
    expect(
      within(excluded).getByText("Takeover overrode normal playback")
        .parentElement?.textContent,
    ).toContain("60 min");
    expect(
      within(excluded).getByText("Playback intentionally stopped").parentElement
        ?.textContent,
    ).toContain("30 min");
  });

  it("reports every specified headline figure", async () => {
    renderPanel();

    await screen.findByText("Playback compliance");
    for (const [label, value] of [
      ["Expected screen-minutes", "120 min"],
      ["Confirmed screen-minutes", "60 min"],
      ["Missed screen-minutes", "60 min"],
      ["Late starts", "1"],
      ["Never started", "1"],
    ] as [string, string][]) {
      const tile = screen.getByText(label).closest("a, article")!;
      expect(tile.textContent, label).toContain(value);
    }
    // Early endings and offline misses ride alongside their related tile.
    expect(
      screen.getByText("Late starts").closest("a, article")!.textContent,
    ).toContain("2 ended early");
    expect(
      screen.getByText("Never started").closest("a, article")!.textContent,
    ).toContain("1 while offline");
  });

  it("names the main reason time went missing", async () => {
    renderPanel();

    const row = (await screen.findByText("Lobby north")).closest("tr")!;
    expect(row.textContent).toContain("Screen Offline");
  });

  it("offers every documented drill-down", async () => {
    const user = userEvent.setup();
    renderPanel();

    const select = await screen.findByRole("combobox", {
      name: /Break down by/,
    });
    await user.click(select);
    for (const dimension of [
      "Screen",
      "Location",
      "Group",
      "Presentation",
      "Schedule",
      "Date",
      "Failure reason",
    ]) {
      expect(screen.getByRole("option", { name: dimension })).toBeTruthy();
    }

    await user.click(screen.getByRole("option", { name: "Schedule" }));
    await waitFor(() =>
      expect(requested.some((url) => url.includes("dimension=schedule"))).toBe(
        true,
      ),
    );
  });

  it("says there is no data rather than reporting zero percent", async () => {
    renderPanel({
      ...report,
      measurableExpectedMs: 0,
      confirmedMs: 0,
      missedMs: 0,
      compliancePercent: null,
      breakdown: [],
    });

    const tile = (await screen.findByText("Playback compliance")).closest(
      "a, article",
    )!;
    // 0% would claim every expected play was missed; none was expected.
    expect(tile.textContent).toContain("No data");
    expect(tile.textContent).not.toContain("0.0%");
  });

  it("states that it measures against the plan in force at the time", async () => {
    renderPanel();

    const panel = await screen.findByRole("region", {
      name: "Playback compliance",
    });
    expect(panel.textContent).toContain("expected at the time");
    expect(panel.textContent).toContain(
      "not against the current configuration",
    );
  });
});

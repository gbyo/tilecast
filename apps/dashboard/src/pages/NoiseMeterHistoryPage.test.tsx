// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import userEvent from "@testing-library/user-event";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NoiseMeterHistoryPage,
  buildNoiseChartData,
  formatDuration,
  formatShare,
  splitSeries,
} from "./NoiseMeterHistoryPage";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      authenticated: true,
      csrfToken: "csrf",
      user: { id: "owner", name: "Owner", role: "owner" },
    },
  }),
}));

const instance = {
  id: "meter-1",
  name: "Cafeteria noise",
  message: "Please lower the volume",
  warningLevel: 60,
  loudLevel: 80,
  sensitivity: 100,
  triggerHoldMs: 1000,
  clearHoldMs: 3000,
  displayMode: "overlay",
  heightPx: 96,
  historyEnabled: true,
  historyRetentionDays: 7,
  historyActiveHoursOnly: true,
  enabled: true,
  targetScope: "all",
  targetIds: [],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

const summary = {
  range: {
    key: "today",
    from: "2026-08-10T04:00:00Z",
    to: "2026-08-11T04:00:00Z",
  },
  summary: {
    buckets: 720,
    averageLevel: 48.2,
    peakLevel: 94,
    monitoredMs: 7_200_000,
    normalMs: 5_800_000,
    warningMs: 1_002_000,
    loudMs: 1_398_000,
    warningEvents: 12,
    longestLoudMs: 240_000,
    loudestWindowAt: "2026-08-10T17:15:00Z",
    loudestWindowLevel: 81.4,
    firstAt: "2026-08-10T13:00:00Z",
    lastAt: "2026-08-10T19:00:00Z",
  },
};

const emptySummary = {
  range: summary.range,
  summary: {
    buckets: 0,
    averageLevel: null,
    peakLevel: null,
    monitoredMs: 0,
    normalMs: 0,
    warningMs: 0,
    loudMs: 0,
    warningEvents: 0,
    longestLoudMs: 0,
  },
};

const series = {
  range: summary.range,
  resolution: "minute",
  points: [
    {
      at: "2026-08-10T13:00:00Z",
      averageLevel: 40,
      peakLevel: 55,
      monitoredMs: 60_000,
      warningMs: 0,
      loudMs: 0,
      triggerCount: 0,
    },
    {
      at: "2026-08-10T13:01:00Z",
      averageLevel: 85,
      peakLevel: 96,
      monitoredMs: 60_000,
      warningMs: 10_000,
      loudMs: 45_000,
      triggerCount: 1,
    },
  ],
};

const daily = {
  range: summary.range,
  days: [
    {
      date: "2026-08-08",
      averageLevel: 44,
      peakLevel: 88,
      monitoredMs: 7_200_000,
      warningMs: 500_000,
      loudMs: 600_000,
      triggerCount: 4,
    },
    {
      date: "2026-08-10",
      averageLevel: 52,
      peakLevel: 94,
      monitoredMs: 7_200_000,
      warningMs: 900_000,
      loudMs: 1_400_000,
      triggerCount: 12,
    },
  ],
};

let requested: string[] = [];
let screensPayload: { items: unknown[]; total: number } = {
  items: [{ screenId: "screen-1", name: "Cafeteria", buckets: 720 }],
  total: 1,
};
let summaryPayload: unknown = summary;

/** Base UI Select hides its native control, so pick the way a person does. */
async function chooseOption(selectLabel: string | RegExp, optionLabel: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: selectLabel }));
  await user.click(await screen.findByRole("option", { name: optionLabel }));
}

function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/plugins/noise-meter/meter-1/history"]}>
        <Routes>
          <Route
            path="/plugins/noise-meter/:id/history"
            element={<NoiseMeterHistoryPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  requested = [];
  screensPayload = {
    items: [{ screenId: "screen-1", name: "Cafeteria", buckets: 720 }],
    total: 1,
  };
  summaryPayload = summary;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requested.push(path);
      const body = path.includes("/history/screens")
        ? screensPayload
        : path.includes("/history/summary")
          ? summaryPayload
          : path.includes("/history/series")
            ? series
            : path.includes("/history/daily")
              ? daily
              : instance;
      return Promise.resolve(new Response(JSON.stringify({ data: body })));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("noise history formatting", () => {
  it("reads durations as time rather than milliseconds", () => {
    expect(formatDuration(1_398_000)).toBe("23m 18s");
    expect(formatDuration(7_200_000)).toBe("2h 0m");
    expect(formatDuration(0)).toBe("0s");
  });

  it("reports no share when nothing was monitored", () => {
    // Zero monitored time is an absence, not a zero percent.
    expect(formatShare(0, 0)).toBe("—");
    expect(formatShare(1, 4)).toBe("25%");
  });

  it("breaks the series where monitoring stopped", () => {
    const points = [
      { at: "2026-08-10T13:00:00Z" },
      { at: "2026-08-10T13:01:00Z" },
      // An hour with nothing measured: two segments, not one line across it.
      { at: "2026-08-10T14:01:00Z" },
    ] as never;
    expect(splitSeries(points, 60_000)).toHaveLength(2);
  });

  it("inserts a gap sample so the chart does not bridge unmonitored time", () => {
    const points = [
      series.points[0]!,
      series.points[1]!,
      { ...series.points[1]!, at: "2026-08-10T14:01:00Z" },
    ];

    expect(buildNoiseChartData(points, 60_000)).toEqual([
      {
        at: Date.parse("2026-08-10T13:00:00Z"),
        averageLevel: 40,
        peakLevel: 55,
      },
      {
        at: Date.parse("2026-08-10T13:01:00Z"),
        averageLevel: 85,
        peakLevel: 96,
      },
      {
        at: Date.parse("2026-08-10T13:31:00Z"),
        averageLevel: null,
        peakLevel: null,
      },
      {
        at: Date.parse("2026-08-10T14:01:00Z"),
        averageLevel: 85,
        peakLevel: 96,
      },
    ]);
  });
});

describe("Noise Meter history", () => {
  it("shows the summary statistics for the range", async () => {
    renderPage();
    expect(await screen.findByText("48")).toBeVisible();
    expect(screen.getByText("Average noise level")).toBeVisible();
    expect(screen.getByText("94")).toBeVisible();
    expect(screen.getByText("23m 18s")).toBeVisible();
    expect(screen.getByText("12")).toBeVisible();
    expect(screen.getByText("Warning events")).toBeVisible();
    // The descriptive extras, including the two that cannot be recomputed from
    // an average: the longest continuous run and the loudest window.
    expect(screen.getByText("4m 0s")).toBeVisible();
  });

  it("states the privacy position without needing the docs", async () => {
    renderPage();
    expect(
      await screen.findByText(/never records or stores microphone audio/i),
    ).toBeVisible();
    expect(
      screen.getByText(/not calibrated\s+decibel measurements/i),
    ).toBeVisible();
  });

  it("draws the timeline against the configured thresholds", async () => {
    renderPage();
    expect(
      await screen.findByRole("group", { name: "Noise level history chart" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        /warning threshold is 60; the too-loud threshold is 80/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Average")).toBeVisible();
    expect(screen.getByText("Peak")).toBeVisible();
  });

  it("requeries when the range changes and offers the daily comparison", async () => {
    renderPage();
    await screen.findByText("48");
    requested = [];
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() =>
      expect(requested.some((path) => path.includes("range=7d"))).toBe(true),
    );
    // Daily comparison is a multi-day question, so it appears with the range.
    expect(
      await screen.findByRole("heading", { name: "Daily comparison" }),
    ).toBeVisible();
    expect(await screen.findByText("52")).toBeVisible();
    // Switching the measure re-reads the same days rather than refetching.
    fireEvent.click(screen.getByRole("button", { name: "Time too loud" }));
    expect(await screen.findByText("23m 20s")).toBeVisible();
  });

  it("names the single screen it is showing", async () => {
    renderPage();
    expect(await screen.findByText("Cafeteria")).toBeVisible();
    // One screen needs no selector.
    expect(screen.queryByLabelText(/^Screen/)).not.toBeInTheDocument();
  });

  it("labels a combined view and lets one screen be chosen", async () => {
    screensPayload = {
      items: [
        { screenId: "screen-1", name: "Cafeteria", buckets: 720 },
        { screenId: "screen-2", name: "Gym", buckets: 500 },
      ],
      total: 2,
    };
    renderPage();
    // Combining different microphones has to be said out loud, not implied.
    expect(
      await screen.findByText(/Combining 2 screens/, { exact: false }),
    ).toBeVisible();
    requested = [];
    await chooseOption(/^Screen/, "Gym");
    await waitFor(() =>
      expect(requested.some((path) => path.includes("screenId=screen-2"))).toBe(
        true,
      ),
    );
  });

  it("exports the selected range, screen, and granularity", async () => {
    renderPage();
    await screen.findByText("48");
    const link = screen.getByRole("link", { name: /Export CSV/ });
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("range=today"),
    );
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("granularity=raw"),
    );
    await chooseOption("Export", "Daily summaries");
    expect(screen.getByRole("link", { name: /Export CSV/ })).toHaveAttribute(
      "href",
      expect.stringContaining("granularity=daily"),
    );
  });

  it("shows an empty state rather than zeroes when nothing was measured", async () => {
    summaryPayload = emptySummary;
    renderPage();
    expect(
      await screen.findByText("No measurements in this range"),
    ).toBeVisible();
    expect(screen.queryByText("Average noise level")).not.toBeInTheDocument();
  });
});

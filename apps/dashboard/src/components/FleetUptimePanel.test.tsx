// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetUptimePanel } from "./FleetUptimePanel";
import { api } from "../api/client";
import type { UptimeReport, UptimeWindow } from "../api/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FleetUptimePanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const report = (overrides: Partial<UptimeReport> = {}): UptimeReport => ({
  range: { from: "2026-07-24T12:00:00Z", to: "2026-07-25T12:00:00Z" },
  window: "24h",
  windowLabel: "Last 24 hours",
  bucketSeconds: 3600,
  screensTracked: 2,
  screensWithDowntime: 1,
  screensUnmeasured: 0,
  trackedSeconds: 14_400,
  upSeconds: 11_700,
  impairedSeconds: 900,
  downSeconds: 1800,
  uptimePercent: 81.25,
  previousUptimePercent: 76.25,
  buckets: [
    {
      start: "2026-07-25T10:00:00Z",
      upPercent: 100,
      impairedPercent: 0,
      downPercent: 0,
      unknownPercent: 0,
      uptimePercent: 100,
      screensDown: 0,
    },
    {
      start: "2026-07-25T11:00:00Z",
      upPercent: 50,
      impairedPercent: 25,
      downPercent: 25,
      unknownPercent: 0,
      uptimePercent: 50,
      screensDown: 1,
    },
  ],
  screens: [
    {
      screenId: "screen-library",
      screenName: "Library",
      uptimePercent: 62.5,
      trackedSeconds: 7200,
      upSeconds: 4500,
      impairedSeconds: 900,
      downSeconds: 1800,
      buckets: ["up", "down"],
    },
    {
      screenId: "screen-cafeteria",
      screenName: "Cafeteria",
      uptimePercent: 100,
      trackedSeconds: 7200,
      upSeconds: 7200,
      impairedSeconds: 0,
      downSeconds: 0,
      buckets: ["up", "up"],
    },
  ],
  ...overrides,
});

describe("FleetUptimePanel", () => {
  it("reports the measured uptime percentage, downtime, and per-screen rows", async () => {
    vi.spyOn(api, "fleetUptime").mockResolvedValue(report());
    renderPanel();

    expect(await screen.findByText("81.3%")).toBeTruthy();
    // Downtime is stated as a duration, not only as a colour in the chart.
    expect(screen.getByText("30m")).toBeTruthy();
    expect(screen.getByText("15m")).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(screen.getByText("+5.0 points vs previous window")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /^Per screen · / }),
    );
    // The worst screen keeps the order the server ranked it in.
    const links = screen
      .getAllByRole("link")
      .map((link) => link.textContent)
      .filter((label) => label === "Library" || label === "Cafeteria");
    expect(links).toEqual(["Library", "Cafeteria"]);
    expect(screen.getByText("30m down")).toBeTruthy();
    expect(screen.getByText("No interruptions")).toBeTruthy();
    // The chart legend names each series in text, not colour alone.
    for (const label of ["Up", "Impaired", "Down", "No data"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("keeps the per-screen strips collapsed so the overview stays short", async () => {
    vi.spyOn(api, "fleetUptime").mockResolvedValue(
      report({ screensTracked: 3, screensUnmeasured: 1 }),
    );
    renderPanel();

    const disclosure = await screen.findByRole("button", {
      name: /^Per screen · /,
    });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Library")).toBeNull();
    // A player that has not reported state yet is counted, not hidden.
    expect(disclosure.textContent).toBe(
      "Per screen · 3 screens · 1 with downtime · 1 not measured yet",
    );
  });

  it("requests the seven day window when the operator switches range", async () => {
    const fleetUptime = vi
      .spyOn(api, "fleetUptime")
      .mockImplementation((window: UptimeWindow) =>
        Promise.resolve(
          window === "7d"
            ? report({
                window: "7d",
                windowLabel: "Last 7 days",
                bucketSeconds: 21_600,
                uptimePercent: 91.5,
              })
            : report(),
        ),
      );
    renderPanel();
    await screen.findByText("81.3%");

    await userEvent.click(screen.getByRole("button", { name: "7 days" }));

    await waitFor(() => expect(screen.getByText("91.5%")).toBeTruthy());
    expect(fleetUptime).toHaveBeenCalledWith("7d");
  });

  it("renders measured figures without NaN or an empty chart when buckets are sparse", async () => {
    vi.spyOn(api, "fleetUptime").mockResolvedValue(
      report({
        buckets: [],
        screensUnmeasured: 1,
        screens: [
          {
            screenId: "screen-new",
            screenName: "New screen",
            uptimePercent: null,
            trackedSeconds: 0,
            upSeconds: 0,
            impairedSeconds: 0,
            downSeconds: 0,
            buckets: [],
          },
        ],
      }),
    );
    renderPanel();

    expect(await screen.findByText("81.3%")).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.queryByLabelText("Chart legend")).toBeNull();
    expect(
      screen.getByText(/Not enough interval data to chart yet/),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /^Per screen · / }),
    );
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.getByText("Not reporting yet")).toBeTruthy();
  });

  it("says so plainly when no player state has been recorded yet", async () => {
    vi.spyOn(api, "fleetUptime").mockResolvedValue(
      report({
        uptimePercent: null,
        previousUptimePercent: null,
        upSeconds: 0,
        impairedSeconds: 0,
        downSeconds: 0,
        screensWithDowntime: 0,
        buckets: [],
        screens: [],
      }),
    );
    renderPanel();

    expect(
      await screen.findByText("No player state recorded yet"),
    ).toBeTruthy();
    // No fabricated percentage stands in for missing measurements.
    expect(screen.queryByText("0.0%")).toBeNull();
  });
});

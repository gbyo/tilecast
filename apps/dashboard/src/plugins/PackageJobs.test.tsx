// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PackageJob } from "../api/types";
import { i18n } from "../i18n";
import { PackageJobs } from "./PackageJobs";

const jobsStub = vi.hoisted(() =>
  vi.fn((): Promise<PackageJob[]> => Promise.resolve([])),
);

vi.mock("../api/domains/fleet", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../api/domains/fleet")>();
  return { ...mod, listPackageJobs: jobsStub };
});

function renderJobs() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PackageJobs packageId="acme.kiosk" />
    </QueryClientProvider>,
  );
}

describe("PackageJobs", () => {
  afterEach(() => {
    cleanup();
    jobsStub.mockReset();
    jobsStub.mockResolvedValue([]);
  });

  it("renders each job with its cadence and cursor", async () => {
    jobsStub.mockResolvedValue([
      {
        jobId: "refresh",
        intervalMinutes: 15,
        nextRunAt: "2026-10-07T12:00:00Z",
        lastRunAt: "2026-10-07T11:45:00Z",
        lastStatus: "ok",
        lastError: "",
        consecutiveFailures: 0,
      },
      {
        jobId: "prune",
        intervalMinutes: 1440,
        nextRunAt: "2026-10-08T00:00:00Z",
        lastStatus: "never",
        lastError: "",
        consecutiveFailures: 0,
      },
      {
        jobId: "sync",
        intervalMinutes: 60,
        nextRunAt: "2026-10-07T13:00:00Z",
        lastRunAt: "2026-10-07T12:00:00Z",
        lastStatus: "error",
        lastError: "guest exited with status 2",
        consecutiveFailures: 3,
      },
    ]);
    await i18n.changeLanguage("en");
    renderJobs();
    expect(await screen.findByText("Background jobs")).toBeInTheDocument();
    expect(screen.getByText("refresh")).toBeInTheDocument();
    expect(screen.getByText(/Every 15 min/)).toBeInTheDocument();
    expect(screen.getByText(/Succeeded/)).toBeInTheDocument();
    expect(screen.getByText("prune")).toBeInTheDocument();
    expect(screen.getByText("Never run")).toBeInTheDocument();
    expect(screen.getByText("sync")).toBeInTheDocument();
    expect(screen.getByText(/Failed/)).toBeInTheDocument();
    expect(screen.getByText(/3 consecutive failures/)).toBeInTheDocument();
    expect(screen.getByText(/guest exited with status 2/)).toBeInTheDocument();
  });

  it("reports load failures", async () => {
    jobsStub.mockRejectedValue(new Error("offline"));
    await i18n.changeLanguage("en");
    renderJobs();
    expect(
      await screen.findByText("Background jobs could not be loaded."),
    ).toBeInTheDocument();
  });
});

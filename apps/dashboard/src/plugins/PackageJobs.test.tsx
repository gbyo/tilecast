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

  it("renders each job with its cadence and outcome", async () => {
    const now = Date.now();
    const at = (minutes: number) =>
      new Date(now + minutes * 60_000).toISOString();
    jobsStub.mockResolvedValue([
      {
        jobId: "refresh-scores",
        intervalMinutes: 5,
        nextRunAt: at(3),
        lastRunAt: at(-2),
        lastStatus: "ok",
        lastError: "",
        consecutiveFailures: 0,
      },
      {
        jobId: "prune",
        intervalMinutes: 1440,
        nextRunAt: at(600),
        lastStatus: "never",
        lastError: "",
        consecutiveFailures: 0,
      },
      {
        jobId: "sync",
        intervalMinutes: 60,
        nextRunAt: at(40),
        lastRunAt: at(-20),
        lastStatus: "error",
        lastError: "guest exited with status 2",
        consecutiveFailures: 3,
      },
    ]);
    await i18n.changeLanguage("en");
    renderJobs();
    expect(
      await screen.findByRole("heading", { name: "Background jobs" }),
    ).toBeInTheDocument();
    // The friendly name leads; raw job ids belong to Technical details.
    expect(screen.getByText("Refresh scores")).toBeInTheDocument();
    expect(screen.queryByText("refresh-scores")).not.toBeInTheDocument();
    expect(screen.getByText("Every 5 minutes")).toBeInTheDocument();
    expect(
      screen.getByText("Last run 2 minutes ago · Successful"),
    ).toBeInTheDocument();
    expect(screen.getByText("Next run in 3 minutes")).toBeInTheDocument();
    expect(screen.getByText("Every day")).toBeInTheDocument();
    expect(screen.getByText("Never run")).toBeInTheDocument();
    expect(screen.getByText("Every hour")).toBeInTheDocument();
    expect(
      screen.getByText("Last failed run 20 minutes ago"),
    ).toBeInTheDocument();
    expect(screen.getByText("3 consecutive failures")).toBeInTheDocument();
    expect(screen.getByText("guest exited with status 2")).toBeInTheDocument();
  });

  it("marks a failed job with a warning, not color alone", async () => {
    jobsStub.mockResolvedValue([
      {
        jobId: "sync",
        intervalMinutes: 60,
        nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
        lastRunAt: new Date(Date.now() - 600_000).toISOString(),
        lastStatus: "error",
        lastError: "boom",
        consecutiveFailures: 1,
      },
    ]);
    await i18n.changeLanguage("en");
    renderJobs();
    const row = (await screen.findByText("Sync")).closest(
      "[data-slot='item']",
    ) as HTMLElement;
    expect(row).toHaveAttribute("data-status", "failed");
    expect(row).toHaveTextContent("Last failed run");
    expect(row.querySelector("svg")).not.toBeNull();
    // A failure marks its own lines, not the whole row: the Item stays the
    // quiet muted variant with no destructive border or fill.
    expect(row).toHaveAttribute("data-variant", "muted");
    expect(row.className).not.toMatch(/destructive/);
    expect(screen.getByText("boom")).toHaveClass("text-destructive");
    expect(screen.getByText(/Next run in/)).not.toHaveClass("text-destructive");
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

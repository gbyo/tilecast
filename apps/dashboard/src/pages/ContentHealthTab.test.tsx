// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ContentHealthTab } from "./ContentHealthTab";
import { api } from "../api/client";
import type { ContentHealthReport } from "../api/types";

const empty: ContentHealthReport = {
  staleSources: [],
  expiringAssets: [],
  emptyPlaylists: [],
  unassignedScreens: [],
  thresholds: { staleSourceHours: 12, expiringMediaDays: 14 },
  generatedAt: "2026-03-04T12:00:00Z",
};

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ContentHealthTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Content health", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(cleanup);

  it("says nothing is wrong instead of showing four empty lists", async () => {
    vi.spyOn(api, "contentHealth").mockResolvedValue(empty);
    renderTab();
    expect(await screen.findByText("Nothing needs attention.")).toBeTruthy();
  });

  it("names the playlist that has nothing to play and how many screens see it", async () => {
    vi.spyOn(api, "contentHealth").mockResolvedValue({
      ...empty,
      emptyPlaylists: [{ id: "p1", name: "Cafeteria Menu", screenCount: 3 }],
    });
    renderTab();
    expect(await screen.findByText("Cafeteria Menu")).toBeTruthy();
    expect(screen.getByText("3 screens")).toBeTruthy();
  });

  it("reports a stale source as cached rather than as an outage", async () => {
    vi.spyOn(api, "contentHealth").mockResolvedValue({
      ...empty,
      staleSources: [
        {
          id: "d1",
          name: "District Calendar",
          provider: "calendar",
          lastSuccessAt: "2026-02-25T09:00:00Z",
          errorCode: "http_500",
          usingCachedData: true,
        },
      ],
    });
    renderTab();
    expect(await screen.findByText("District Calendar")).toBeTruthy();
    expect(screen.getByText(/Last error: http_500/)).toBeTruthy();
    expect(
      screen.getByText(/Screens keep showing the cached copy/),
    ).toBeTruthy();
  });

  it("separates a screen with nothing assigned from a fault", async () => {
    vi.spyOn(api, "contentHealth").mockResolvedValue({
      ...empty,
      unassignedScreens: [{ id: "s1", name: "Lobby" }],
    });
    renderTab();
    expect(await screen.findByText("Lobby")).toBeTruthy();
    expect(screen.getByText(/setup state, not a\s+fault/)).toBeTruthy();
  });

  it("reports a failed load as an error with retry, not as healthy", async () => {
    vi.spyOn(api, "contentHealth").mockRejectedValue(new Error("boom"));
    renderTab();
    expect(
      await screen.findByText(/Content health could not be loaded/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs attention.")).toBeNull();
  });
});

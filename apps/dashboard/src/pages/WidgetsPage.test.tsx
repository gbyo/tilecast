// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { WidgetsPage } from "./WidgetsPage";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      csrfToken: "csrf-token",
      user: { id: "user-1", role: "administrator" },
    },
  }),
}));

vi.mock("../content/WidgetSnapshotBackfill", () => ({
  WidgetSnapshotBackfill: () => <div data-testid="widget-snapshot-backfill" />,
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WidgetsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Widgets library", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows only the load error when the list query fails", async () => {
    vi.spyOn(api, "assets").mockRejectedValue(new Error("Network unavailable"));
    vi.spyOn(api, "contentDefinitions").mockResolvedValue({
      revision: "1",
      compilerVersion: "1",
      fingerprint: "test",
      widgets: [],
      dataSources: [],
    });

    renderPage();

    expect(
      await screen.findByText("Widgets could not be loaded."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No Widgets yet")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("widget-snapshot-backfill"),
    ).not.toBeInTheDocument();
  });
});

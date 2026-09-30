// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { CampaignsPage } from "./CampaignsPage";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { csrfToken: "csrf", user: { role: "viewer" } },
  }),
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CampaignsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CampaignsPage library", () => {
  it("shows a retry state instead of the empty state when loading fails", async () => {
    const campaigns = vi
      .spyOn(api, "campaignPage")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });

    renderPage();

    expect(
      await screen.findByText("Campaigns could not be loaded."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No campaigns yet")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("No campaigns yet")).toBeInTheDocument();
    expect(campaigns).toHaveBeenCalledTimes(2);
  });
});

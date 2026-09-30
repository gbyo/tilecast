// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ArchivedScreensPage } from "./ArchivedScreensPage";
import { archivedScreens } from "../api/archivedScreens";
import { ApiError } from "../api/client";
import { apiErrorMessage, i18n } from "../i18n";

vi.mock("../api/archivedScreens", () => ({
  archivedScreens: vi.fn(),
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ArchivedScreensPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ArchivedScreensPage load errors", () => {
  beforeEach(() => {
    vi.mocked(archivedScreens).mockRejectedValue(new Error("boom"));
  });
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await i18n.changeLanguage("en");
  });

  it("shows localized copy instead of the raw error", async () => {
    renderPage();

    expect(
      await screen.findByText("Archived screens could not be loaded."),
    ).toBeInTheDocument();
    expect(screen.queryByText("boom")).toBeNull();
    expect(screen.queryByText("No archived screens")).toBeNull();
  });

  it("routes structured API errors through the shared formatter", async () => {
    const failure = new ApiError("Server error.", 500, "internal_error");
    vi.mocked(archivedScreens).mockRejectedValue(failure);
    renderPage();

    expect(
      await screen.findByText(apiErrorMessage(failure)),
    ).toBeInTheDocument();
  });
});

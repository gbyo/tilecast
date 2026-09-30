// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ArchivedScreensPage } from "./ArchivedScreensPage";
import { archivedScreens } from "../api/archivedScreens";
import { i18n } from "../i18n";

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

describe("ArchivedScreensPage", () => {
  beforeEach(() => {
    vi.mocked(archivedScreens).mockResolvedValue({
      items: [
        {
          id: "screen-1",
          name: "Lobby screen",
          platform: "linux",
          deviceManufacturer: "BrightSign",
          deviceModel: "XT5",
          archivedAt: "2026-02-10T09:30:00Z",
          archivedReason: "Replaced by new hardware",
          lastContactAt: "2026-02-09T18:00:00Z",
        },
      ],
      total: 1,
    } as never);
  });
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await i18n.changeLanguage("en");
  });

  it("renders the desktop table", async () => {
    renderPage();

    const table = await screen.findByRole("table");
    expect(within(table).getByText("Lobby screen")).toBeInTheDocument();
    const wrapper = table.closest("div[class*='lg:block']");
    expect(wrapper?.className).toContain("hidden");
    expect(wrapper?.className).toContain("lg:block");
  });

  it("renders a compact card with reason and contact info", async () => {
    renderPage();

    const card = await screen.findByRole("article");
    expect(within(card).getByText("Lobby screen")).toBeInTheDocument();
    expect(
      within(card).getByText(/Replaced by new hardware/),
    ).toBeInTheDocument();
    expect(within(card).getByText(/BrightSign/)).toBeInTheDocument();
    const wrapper = card.parentElement;
    expect(wrapper?.className).toContain("lg:hidden");
  });
});

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProofTab } from "./ActivityReportTabs";
import { i18n } from "../i18n";

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});

const summaryItem = {
  key: "screen-1",
  label: "Lobby",
  confirmedScreenPlaybackMs: 3_600_000,
  contentExposureMs: 1_800_000,
  records: 1234,
  completed: 1000,
  failures: 120,
  partial: 100,
  unknown: 14,
  interrupted: 1100,
  sessionCompletionPercent: 66.666,
};

function renderProofTab() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = url.includes("/proof-of-play/summary")
        ? { dimension: "screen", items: [summaryItem] }
        : { items: [] };
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
      <MemoryRouter>
        <ProofTab
          range={{
            from: "2026-07-26T00:00:00.000Z",
            to: "2026-07-27T00:00:00.000Z",
          }}
          filters={{}}
          dimension="screen"
          setDimension={() => undefined}
          hasActiveFilters={false}
          canExtendRange={false}
          onClearFilters={() => undefined}
          onExtendRange={() => undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ProofTab summary", () => {
  it("formats summary numbers in the Studio language, not the browser locale", async () => {
    await i18n.changeLanguage("ru");
    renderProofTab();

    // Russian grouping uses a non-breaking space; the browser default
    // (en-US under jsdom) would render 1,234 with a comma.
    expect(await screen.findByText("1 234")).toBeInTheDocument();
    expect(screen.queryByText("1,234")).toBe(null);
  });
});

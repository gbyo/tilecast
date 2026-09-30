// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { Asset } from "../api/types";
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

  it("loads further library pages through Load more", async () => {
    const widget = (id: string, name: string) =>
      ({ id, name, type: "widget", metadata: {} }) as Asset;
    vi.spyOn(api, "assets").mockImplementation((params: URLSearchParams) =>
      Promise.resolve(
        params.get("page") === "2"
          ? {
              items: [widget("w2", "Second widget")],
              total: 2,
              page: 2,
              pageSize: 1,
            }
          : {
              items: [widget("w1", "First widget")],
              total: 2,
              page: 1,
              pageSize: 1,
            },
      ),
    );
    vi.spyOn(api, "contentDefinitions").mockResolvedValue({
      revision: "1",
      compilerVersion: "1",
      fingerprint: "test",
      widgets: [],
      dataSources: [],
    });

    renderPage();
    const user = userEvent.setup();

    expect(await screen.findByText("First widget")).toBeInTheDocument();
    expect(screen.queryByText("Second widget")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second widget")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
  });

  it("hides Load more when the library fits on one page", async () => {
    vi.spyOn(api, "assets").mockResolvedValue({
      items: [
        {
          id: "w1",
          name: "Only widget",
          type: "widget",
          metadata: {},
        } as Asset,
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    vi.spyOn(api, "contentDefinitions").mockResolvedValue({
      revision: "1",
      compilerVersion: "1",
      fingerprint: "test",
      widgets: [],
      dataSources: [],
    });

    renderPage();

    expect(await screen.findByText("Only widget")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
  });
});

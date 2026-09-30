// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { Asset } from "../api/types";
import { ContentPage } from "./ContentPage";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      csrfToken: "csrf",
      user: { id: "u1", role: "owner" },
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function asset(id: string, name: string): Asset {
  return {
    id,
    name,
    description: "",
    type: "image",
    originalFilename: `${id}.png`,
    declaredMimeType: "image/png",
    detectedMimeType: "image/png",
    sha256: "aabbcc",
    originalSize: 2048,
    width: 1920,
    height: 1080,
    metadata: {},
    processingStatus: "ready",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    variants: [],
    playlistUsage: 0,
    layoutUsage: [],
    tags: [],
    collectionIds: [],
  };
}

function mockLibrary() {
  const active = Array.from({ length: 50 }, (_, index) =>
    asset(`poster-${index + 1}`, `Poster-${index + 1}`),
  );
  const archived = Array.from({ length: 49 }, (_, index) =>
    asset(`old-${index + 1}`, `Old-${index + 1}`),
  );
  const calls = vi.spyOn(api, "assets").mockImplementation((params) => {
    const items = params.get("archived") === "true" ? archived : active;
    const page = Number(params.get("page")) || 1;
    const pageSize = Number(params.get("pageSize")) || 48;
    const start = (page - 1) * pageSize;
    return Promise.resolve({
      items: items.slice(start, start + pageSize),
      total: items.length,
      page,
      pageSize,
    });
  });
  vi.spyOn(api, "contentFolders").mockResolvedValue([]);
  vi.spyOn(api, "contentCollections").mockResolvedValue([]);
  vi.spyOn(api, "contentTags").mockResolvedValue([]);
  return { calls };
}

function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <ContentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Media library paging", () => {
  it("loads further pages on demand instead of stopping at 48", async () => {
    const { calls } = mockLibrary();
    renderPage();

    expect(await screen.findByText("Poster-1")).toBeInTheDocument();
    expect(screen.queryByText("Poster-50")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Poster-50")).toBeInTheDocument();
    expect(calls.mock.calls.map(([params]) => params.get("page"))).toEqual([
      "1",
      "2",
    ]);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Load more" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("selects every loaded item across pages, not just page one", async () => {
    mockLibrary();
    renderPage();

    expect(await screen.findByText("Poster-1")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Poster-50")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Poster-1" }));
    expect(await screen.findByText("1 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select loaded" }));
    expect(await screen.findByText("50 selected")).toBeInTheDocument();
  });

  it("pages the archive view with the same query", async () => {
    const { calls } = mockLibrary();
    renderPage();

    expect(await screen.findByText("Poster-1")).toBeInTheDocument();
    const viewToggle = screen.getByRole("group", { name: "Library view" });
    fireEvent.click(
      within(viewToggle).getByRole("button", { name: "Archive" }),
    );
    expect(await screen.findByText("Old-1")).toBeInTheDocument();
    expect(
      calls.mock.calls.some(([params]) => params.get("archived") === "true"),
    ).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Old-49")).toBeInTheDocument();
  });
});

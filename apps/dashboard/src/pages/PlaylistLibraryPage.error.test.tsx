// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { PlaylistLibraryPage } from "./PlaylistLibraryPage";

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
        <PlaylistLibraryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PlaylistLibraryPage loading", () => {
  it("shows a retry state instead of the empty state when loading fails", async () => {
    const playlists = vi
      .spyOn(api, "playlists")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });

    renderPage();

    expect(
      await screen.findByText("Playlists could not be loaded."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No playlists yet")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("No playlists yet")).toBeInTheDocument();
    expect(playlists).toHaveBeenCalledTimes(2);
  });
});

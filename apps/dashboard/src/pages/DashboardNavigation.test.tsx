// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useHref, useNavigate } from "react-router";
import { Provider as SpectrumProvider } from "@react-spectrum/s2/Provider";
import { api } from "../api/client";
import { SidebarNavigation } from "./Dashboard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function RoutedNavigation() {
  const navigate = useNavigate();

  return (
    <SpectrumProvider router={{ navigate, useHref }}>
      <SidebarNavigation />
    </SpectrumProvider>
  );
}

describe("Studio sidebar navigation", () => {
  it("renders the nested workspaces with unique collection identities", async () => {
    vi.spyOn(api, "listForms").mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/"]}>
          <RoutedNavigation />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("treegrid", { name: "Primary navigation" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Content" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Media" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Presentations" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Playlists" })).toBeTruthy();
  });
});

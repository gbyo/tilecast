// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { Screen } from "../api/types";
import { ScreenDetailPage } from "./ScreensPage";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      csrfToken: "csrf",
      user: { id: "u1", name: "Owner", role: "owner" },
    },
  }),
}));

vi.mock("maplibre-gl", () => {
  class Map {
    addControl = vi.fn();
    on = vi.fn();
    remove = vi.fn();
    getZoom = vi.fn(() => 1);
    easeTo = vi.fn();
    getCenter = vi.fn();
  }
  class Marker {
    setLngLat = vi.fn(() => this);
    addTo = vi.fn(() => this);
    on = vi.fn();
    remove = vi.fn();
  }
  class NavigationControl {}
  return { Map, Marker, NavigationControl };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("screen details opened for editing", () => {
  it("keeps the saved map position when editing opens before the screen loads", async () => {
    let resolveScreen: (value: Screen) => void = () => undefined;
    vi.spyOn(api, "screen").mockReturnValue(
      new Promise<Screen>((resolve) => {
        resolveScreen = resolve;
      }),
    );
    const updateScreen = vi
      .spyOn(api, "updateScreen")
      .mockResolvedValue({} as Screen);

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter initialEntries={["/screens/screen-1?edit=details"]}>
          <Routes>
            <Route path="/screens/:id" element={<ScreenDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    resolveScreen({
      id: "screen-1",
      name: "Lobby",
      description: "",
      location: "",
      mapPositionOverride: { latitude: 34.157, longitude: -82.027 },
      platform: "android-tv",
      status: "online",
      enabled: true,
      hasActiveCredential: true,
    } as Screen);

    const interaction = userEvent.setup();
    await interaction.click(
      await screen.findByRole("button", { name: "Save details" }),
    );
    await waitFor(() => expect(updateScreen).toHaveBeenCalledTimes(1));
    expect(updateScreen.mock.calls[0]?.[1]).toMatchObject({
      name: "Lobby",
      mapPositionOverride: { latitude: 34.157, longitude: -82.027 },
    });
  });
});

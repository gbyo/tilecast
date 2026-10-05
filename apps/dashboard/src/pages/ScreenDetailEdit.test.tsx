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
  return { Map, Marker, NavigationControl, setWorkerUrl: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("screen details opened for editing", () => {
  it("offers Archive screen in the detail action menu and returns to the fleet", async () => {
    const item = {
      id: "screen-1",
      name: "Lobby",
      description: "",
      location: "Main entrance",
      platform: "android-tv",
      deviceManufacturer: "Google",
      deviceModel: "ADT-3",
      playerVersion: "0.2.0",
      screenWidth: 1920,
      screenHeight: 1080,
      enabled: true,
      pairedAt: new Date().toISOString(),
      lastContactAt: new Date().toISOString(),
      status: "online",
      hasActiveCredential: true,
    } as Screen;
    vi.spyOn(api, "screen").mockResolvedValue(item);
    vi.spyOn(api, "screens").mockResolvedValue({ items: [item], total: 1 });
    vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "screenReliability").mockResolvedValue({} as never);
    vi.spyOn(api, "screenCommands").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "screenPlayerHistory").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(api, "screenPolicy").mockResolvedValue({ values: {} } as never);
    const revoke = vi.spyOn(api, "revokeScreen").mockResolvedValue();

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter initialEntries={["/screens/screen-1"]}>
          <Routes>
            <Route path="/screens/:id" element={<ScreenDetailPage />} />
            <Route path="/screens" element={<div>Fleet destination</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const interaction = userEvent.setup();
    await interaction.click(
      await screen.findByRole("button", { name: "More screen actions" }),
    );
    await interaction.click(
      await screen.findByRole("menuitem", { name: "Archive screen…" }),
    );
    expect(
      screen.getByRole("alertdialog", { name: "Archive Lobby?" }),
    ).toBeInTheDocument();

    await interaction.click(
      screen.getByRole("button", { name: "Archive screen" }),
    );
    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith(
        "screen-1",
        "Archived in Tilecast Studio",
        "csrf",
      ),
    );
    expect(await screen.findByText("Fleet destination")).toBeInTheDocument();
  });

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

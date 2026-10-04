// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapLibreSurface } from "./MapLibreSurface";

const maplibre = vi.hoisted(() => ({
  constructed: 0,
  failConstruction: true,
  handlers: new Map<string, (event?: unknown) => void>(),
}));

vi.mock("maplibre-gl", () => {
  class Map {
    constructor() {
      maplibre.constructed += 1;
      if (maplibre.failConstruction) {
        throw new Error("WebGL2 is unavailable");
      }
    }

    addControl = vi.fn();
    on = vi.fn((event: string, handler: (event?: unknown) => void) => {
      maplibre.handlers.set(event, handler);
    });
    resize = vi.fn();
    remove = vi.fn();
  }

  class NavigationControl {}

  return {
    Map,
    NavigationControl,
    setWorkerUrl: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  maplibre.constructed = 0;
  maplibre.failConstruction = true;
  maplibre.handlers.clear();
});

describe("MapLibreSurface", () => {
  it("shows constructor failures instead of leaving a blank map", () => {
    render(
      <MapLibreSurface
        className="h-56"
        initialCenter={[0, 0]}
        initialZoom={1}
        loadingLabel="Loading map"
        errorTitle="Map couldn't load"
        errorBody="The map renderer could not start."
        retryLabel="Retry"
      />,
    );

    expect(screen.getByText("Map couldn't load")).toBeInTheDocument();
    expect(screen.getByText("WebGL2 is unavailable")).toBeInTheDocument();
  });

  it("keeps the map available when a source fails after startup", () => {
    maplibre.failConstruction = false;
    const { container } = render(
      <MapLibreSurface
        className="h-56"
        initialCenter={[0, 0]}
        initialZoom={1}
        loadingLabel="Loading map"
        errorTitle="Map data problem"
        errorBody="The map renderer could not start."
        retryLabel="Retry"
      />,
    );

    act(() => {
      maplibre.handlers.get("error")?.({
        error: new Error("Failed to load /planet: 403"),
      });
      maplibre.handlers.get("idle")?.();
    });

    expect(
      container.querySelector('[data-map-state="degraded"]'),
    ).not.toBeNull();
    expect(screen.getByText("Map data problem")).toBeInTheDocument();
    expect(screen.getByText("Failed to load /planet: 403")).toBeInTheDocument();
  });

  it("recreates the map when the user retries", () => {
    render(
      <MapLibreSurface
        className="h-56"
        initialCenter={[0, 0]}
        initialZoom={1}
        loadingLabel="Loading map"
        errorTitle="Map couldn't load"
        errorBody="The map renderer could not start."
        retryLabel="Retry"
      />,
    );

    expect(maplibre.constructed).toBe(1);
    maplibre.failConstruction = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(maplibre.constructed).toBe(2);
  });
});

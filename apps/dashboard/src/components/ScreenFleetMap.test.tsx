// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Screen } from "../api/types";
import type { NativeHost } from "../native-host/NativeHostProvider";
import { ScreenFleetMap } from "./ScreenFleetMap";

const maplibre = vi.hoisted(() => ({
  constructed: 0,
  handlers: new Map<string, () => void>(),
  addSource: vi.fn(),
  addLayer: vi.fn(),
  resize: vi.fn(),
}));

vi.mock("maplibre-gl", () => {
  class Map {
    constructor() {
      maplibre.constructed += 1;
    }
    addControl = vi.fn();
    once = vi.fn();
    getContainer = () => document.createElement("div");
    addSource = maplibre.addSource;
    addLayer = maplibre.addLayer;
    on = vi.fn((event: string, layerOrHandler: unknown) => {
      if (typeof layerOrHandler === "function") {
        maplibre.handlers.set(event, layerOrHandler as () => void);
      }
    });
    resize = maplibre.resize;
    remove = vi.fn();
    isStyleLoaded = vi.fn(() => false);
    getSource = vi.fn();
    getCanvas = vi.fn();
    easeTo = vi.fn();
    fitBounds = vi.fn();
  }
  class NavigationControl {}
  class GeoJSONSource {}
  class LngLatBounds {
    extend = vi.fn();
  }
  return {
    Map,
    NavigationControl,
    GeoJSONSource,
    LngLatBounds,
    setWorkerUrl: vi.fn(),
  };
});

const hostState = vi.hoisted(() => ({ current: null as NativeHost | null }));
vi.mock("../native-host/NativeHostProvider", () => ({
  useNativeHost: () => hostState.current,
}));

const lobby = {
  id: "screen-1",
  name: "Lobby",
  status: "online",
  location: "",
  mapPosition: { latitude: 34.157, longitude: -82.027, source: "screen" },
} as unknown as Screen;

function nativeHost(send: NativeHost["send"]): NativeHost {
  return {
    status: "ready",
    context: "main",
    capabilities: { systemMap: true } as NativeHost["capabilities"],
    send,
    subscribe: () => () => undefined,
  };
}

function renderMap() {
  return render(
    <MemoryRouter>
      <ScreenFleetMap screens={[lobby]} />
    </MemoryRouter>,
  );
}

describe("ScreenFleetMap native presentation", () => {
  beforeEach(() => {
    maplibre.constructed = 0;
    maplibre.handlers.clear();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("adds fleet overlays as soon as the style is ready", () => {
    hostState.current = {
      status: "unavailable",
      context: null,
      capabilities: {} as NativeHost["capabilities"],
      send: vi.fn(),
      subscribe: () => () => undefined,
    };

    renderMap();
    expect(maplibre.constructed).toBe(1);
    expect(maplibre.addSource).not.toHaveBeenCalled();

    maplibre.handlers.get("style.load")?.();

    expect(maplibre.addSource).toHaveBeenCalledWith(
      "fleet-screens",
      expect.objectContaining({ type: "geojson" }),
    );
    expect(maplibre.addLayer).toHaveBeenCalled();
    expect(maplibre.resize).toHaveBeenCalled();
  });

  it("keeps the native map when the host accepts the presentation", async () => {
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    hostState.current = nativeHost(send as unknown as NativeHost["send"]);
    renderMap();
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "system/map-present",
        expect.objectContaining({ mapId: "fleet-screens" }),
      ),
    );
    expect(screen.getByRole("button")).toBeInTheDocument();
    expect(maplibre.constructed).toBe(0);
  });

  it("falls back to the browser map when the host replies with a failure", async () => {
    const send = vi.fn(() => Promise.resolve({ ok: false }));
    hostState.current = nativeHost(send as unknown as NativeHost["send"]);
    renderMap();
    await waitFor(() => expect(maplibre.constructed).toBe(1));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("falls back to the browser map when the send is rejected", async () => {
    const send = vi.fn(() => Promise.reject(new Error("bridge down")));
    hostState.current = nativeHost(send);
    renderMap();
    await waitFor(() => expect(maplibre.constructed).toBe(1));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

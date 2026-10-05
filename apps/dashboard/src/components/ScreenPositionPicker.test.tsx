// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenPositionPicker } from "./ScreenPositionPicker";

const maplibre = vi.hoisted(() => ({
  easeTo: vi.fn(),
  center: { lng: 12.5, lat: 41.9 },
}));

vi.mock("maplibre-gl", () => {
  class Map {
    addControl = vi.fn();
    once = vi.fn();
    getContainer = () => document.createElement("div");
    on = vi.fn();
    remove = vi.fn();
    getZoom = vi.fn(() => 1);
    easeTo = maplibre.easeTo;
    getCenter = () => ({
      wrap: () => maplibre.center,
    });
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
  vi.clearAllMocks();
});

describe("ScreenPositionPicker", () => {
  it("places a position at the map center without a pointer", () => {
    const onChange = vi.fn();
    render(<ScreenPositionPicker onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /map center/i }));
    expect(onChange).toHaveBeenCalledWith({ longitude: 12.5, latitude: 41.9 });
  });

  it("does not recenter when a new object carries the same coordinates", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ScreenPositionPicker
        locationPosition={{ latitude: 34.1, longitude: -82.0 }}
        onChange={onChange}
      />,
    );
    expect(maplibre.easeTo).toHaveBeenCalledTimes(1);
    rerender(
      <ScreenPositionPicker
        locationPosition={{ latitude: 34.1, longitude: -82.0 }}
        onChange={onChange}
      />,
    );
    expect(maplibre.easeTo).toHaveBeenCalledTimes(1);
    rerender(
      <ScreenPositionPicker
        locationPosition={{ latitude: 35.0, longitude: -82.0 }}
        onChange={onChange}
      />,
    );
    expect(maplibre.easeTo).toHaveBeenCalledTimes(2);
  });
});

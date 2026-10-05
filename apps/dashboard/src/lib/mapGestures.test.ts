// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { classifyWheel, installTrackpadGestures } from "./mapGestures";

const pixel = { deltaMode: 0, ctrlKey: false, deltaX: 0, deltaY: 0 };

describe("classifyWheel", () => {
  it("treats ctrl+wheel, which is how browsers report a pinch, as a pinch", () => {
    expect(classifyWheel({ ...pixel, ctrlKey: true, deltaY: -3.5 }, null)).toBe(
      "pinch",
    );
  });

  it("treats line-mode and whole-notch deltas as a mouse wheel", () => {
    expect(classifyWheel({ ...pixel, deltaMode: 1, deltaY: 3 }, null)).toBe(
      "wheel",
    );
    expect(classifyWheel({ ...pixel, deltaY: 120 }, null)).toBe("wheel");
    expect(classifyWheel({ ...pixel, deltaY: -4.000244140625 }, null)).toBe(
      "wheel",
    );
    expect(classifyWheel({ ...pixel, deltaY: 12.000732421875 }, null)).toBe(
      "wheel",
    );
  });

  it("treats small or sideways pixel deltas as a two-finger scroll", () => {
    expect(classifyWheel({ ...pixel, deltaY: 7 }, null)).toBe("pan");
    expect(classifyWheel({ ...pixel, deltaX: 2, deltaY: 120 }, null)).toBe(
      "pan",
    );
    expect(classifyWheel({ ...pixel, deltaY: 4 }, null)).toBe("pan");
  });

  it("keeps the intent of a gesture that is already under way", () => {
    expect(classifyWheel({ ...pixel, deltaY: 120 }, "pan")).toBe("pan");
    expect(classifyWheel({ ...pixel, deltaY: 7 }, "wheel")).toBe("wheel");
  });
});

describe("installTrackpadGestures", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
  });

  function setup() {
    const container = document.createElement("div");
    const inner = document.createElement("div");
    container.append(inner);
    const innerWheel = vi.fn();
    inner.addEventListener("wheel", innerWheel);
    let zoom = 10;
    const map = {
      getContainer: () => container,
      getZoom: () => zoom,
      unproject: vi.fn(([x, y]: [number, number]) => ({ lng: x, lat: y })),
      easeTo: vi.fn((options: { zoom: number; around?: unknown }) => {
        zoom = options.zoom;
      }),
      panBy: vi.fn(),
    };
    cleanups.push(installTrackpadGestures(map as unknown as MapLibreMap));
    return { container, inner, innerWheel, map };
  }

  function wheel(init: WheelEventInit) {
    return new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
  }

  it("zooms a pinch around the pointer without MapLibre also handling it", () => {
    const { inner, innerWheel, map } = setup();
    const event = wheel({
      ctrlKey: true,
      deltaY: -20,
      clientX: 30,
      clientY: 40,
    });
    inner.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(innerWheel).not.toHaveBeenCalled();
    const call = map.easeTo.mock.calls[0]![0] as {
      zoom: number;
      around: unknown;
      duration: number;
    };
    expect(call.zoom).toBeCloseTo(10 + 20 * (0.01 / Math.LN2));
    expect(call.around).toEqual({ lng: 30, lat: 40 });
    expect(call.duration).toBe(0);
  });

  it("zooms out when the fingers pinch in", () => {
    const { inner, map } = setup();
    inner.dispatchEvent(wheel({ ctrlKey: true, deltaY: 10 }));
    expect(map.easeTo.mock.calls[0]![0].zoom).toBeLessThan(10);
  });

  it("caps a single huge ctrl+wheel step", () => {
    const { inner, map } = setup();
    inner.dispatchEvent(wheel({ ctrlKey: true, deltaY: -1000 }));
    expect(map.easeTo.mock.calls[0]![0].zoom).toBeCloseTo(
      10 + 50 * (0.01 / Math.LN2),
    );
  });

  it("pans on a two-finger scroll instead of zooming", () => {
    const { inner, innerWheel, map } = setup();
    const event = wheel({ deltaX: 5, deltaY: 9 });
    inner.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(innerWheel).not.toHaveBeenCalled();
    expect(map.panBy).toHaveBeenCalledWith([5, 9], { duration: 0 });
    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it("leaves mouse-wheel events for MapLibre", () => {
    const { inner, innerWheel, map } = setup();
    const event = wheel({ deltaY: 120 });
    inner.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(innerWheel).toHaveBeenCalledOnce();
    expect(map.panBy).not.toHaveBeenCalled();
    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it("zooms a Safari pinch in proportion to the gesture scale", () => {
    const { container, map } = setup();
    const start = new Event("gesturestart", { cancelable: true });
    container.dispatchEvent(start);
    const change = Object.assign(
      new Event("gesturechange", { cancelable: true }),
      {
        scale: 2,
        clientX: 12,
        clientY: 8,
      },
    );
    container.dispatchEvent(change);

    expect(start.defaultPrevented).toBe(true);
    expect(change.defaultPrevented).toBe(true);
    expect(map.easeTo.mock.calls[0]![0].zoom).toBeCloseTo(11);
    expect(map.easeTo.mock.calls[0]![0].around).toEqual({ lng: 12, lat: 8 });
  });

  it("stops handling gestures once removed", () => {
    const { container, map } = setup();
    cleanups.splice(0).forEach((cleanup) => cleanup());
    container.dispatchEvent(wheel({ ctrlKey: true, deltaY: -5 }));
    expect(map.easeTo).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => {
  class Map {
    addControl = vi.fn();
    once = vi.fn();
    getContainer = vi.fn(() => document.createElement("div"));
  }
  class NavigationControl {}

  return {
    Map,
    NavigationControl,
    setWorkerUrl: vi.fn(),
  };
});

import { OPENFREEMAP_STYLE_URL, proxyOpenFreeMapURL } from "./maplibre";

describe("OpenFreeMap request routing", () => {
  it("uses Tilecast's same-origin style endpoint", () => {
    expect(OPENFREEMAP_STYLE_URL).toBe("/maps/openfreemap/styles/liberty");
  });

  it("rewrites OpenFreeMap resources through Tilecast", () => {
    expect(
      proxyOpenFreeMapURL(
        "https://tiles.openfreemap.org/planet/20260927_080001_pt/7/34/51.pbf?x=1",
      ),
    ).toBe("/maps/openfreemap/planet/20260927_080001_pt/7/34/51.pbf?x=1");
  });

  it("does not proxy lookalike or unrelated hosts", () => {
    expect(
      proxyOpenFreeMapURL("https://tiles.openfreemap.org.example.com/planet/x"),
    ).toBe("https://tiles.openfreemap.org.example.com/planet/x");
    expect(proxyOpenFreeMapURL("https://example.com/style.json")).toBe(
      "https://example.com/style.json",
    );
  });
});

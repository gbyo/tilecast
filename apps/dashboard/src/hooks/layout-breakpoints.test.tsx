// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCompactLayout } from "./use-compact-layout";
import { useDesktopLayout } from "./use-desktop-layout";
import { useIsMobile } from "./use-mobile";
import { usePhoneLayout } from "./use-phone-layout";
import {
  useAnyCoarsePointer,
  useFineHoverPointer,
} from "./use-media-query";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function widthMatches(query: string, width: number) {
  if (query === "(max-width: 639px)") return width <= 639;
  if (query === "(max-width: 1023px)") return width <= 1023;
  if (query === "(max-width: 1279px)") return width <= 1279;
  if (query === "(min-width: 1024px)") return width >= 1024;
  return false;
}

function stubWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: widthMatches(query, width),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function layoutAt(width: number) {
  stubWidth(width);
  return {
    phone: renderHook(() => usePhoneLayout()).result.current,
    compact: renderHook(() => useCompactLayout()).result.current,
    offcanvasNavigation: renderHook(() => useIsMobile()).result.current,
    desktop: renderHook(() => useDesktopLayout()).result.current,
  };
}

describe("Studio layout breakpoints", () => {
  it("uses phone presentations and a narrow workspace at phone widths", () => {
    expect(layoutAt(390)).toEqual({
      phone: true,
      compact: true,
      offcanvasNavigation: true,
      desktop: false,
    });
  });

  it("keeps iPad-mini widths narrow without using phone presentations", () => {
    expect(layoutAt(744)).toEqual({
      phone: false,
      compact: true,
      offcanvasNavigation: true,
      desktop: false,
    });
  });

  it("uses desktop page layouts without pinning navigation at 1024px", () => {
    expect(layoutAt(1024)).toEqual({
      phone: false,
      compact: false,
      offcanvasNavigation: true,
      desktop: true,
    });
  });

  it("pins browser navigation only when space allows", () => {
    expect(layoutAt(1280)).toEqual({
      phone: false,
      compact: false,
      offcanvasNavigation: false,
      desktop: true,
    });
  });
});

describe("Studio input capabilities", () => {
  it("treats touch as coarse without inventing hover", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(any-pointer: coarse)",
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }));

    expect(renderHook(() => useAnyCoarsePointer()).result.current).toBe(true);
    expect(renderHook(() => useFineHoverPointer()).result.current).toBe(false);
  });

  it("allows touch and fine-hover capabilities at the same time", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches:
        query === "(any-pointer: coarse)" ||
        query === "(hover: hover) and (pointer: fine)",
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }));

    expect(renderHook(() => useAnyCoarsePointer()).result.current).toBe(true);
    expect(renderHook(() => useFineHoverPointer()).result.current).toBe(true);
  });

  it("keeps fine hover separate from touch capability", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(hover: hover) and (pointer: fine)",
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }));

    expect(renderHook(() => useAnyCoarsePointer()).result.current).toBe(false);
    expect(renderHook(() => useFineHoverPointer()).result.current).toBe(true);
  });
});

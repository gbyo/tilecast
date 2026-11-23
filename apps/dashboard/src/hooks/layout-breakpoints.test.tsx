// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCompactLayout } from "./use-compact-layout";
import { useDesktopLayout } from "./use-desktop-layout";
import { useAnyCoarsePointer, useFineHoverPointer } from "./use-media-query";
import { useIsMobile } from "./use-mobile";
import { usePhoneLayout } from "./use-phone-layout";

const phoneQuery = "(max-width: 639px)";
const compactQuery = "(max-width: 1023px)";
const offcanvasQuery = "(max-width: 1279px)";
const desktopQuery = "(min-width: 1024px)";
const coarsePointerQuery = "(any-pointer: coarse)";
const fineHoverQuery = "(any-hover: hover) and (any-pointer: fine)";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubQueries(...matchedQueries: string[]) {
  const matched = new Set(matchedQueries);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matched.has(query),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function layout() {
  return {
    phone: renderHook(() => usePhoneLayout()).result.current,
    compact: renderHook(() => useCompactLayout()).result.current,
    offcanvasNavigation: renderHook(() => useIsMobile()).result.current,
    desktop: renderHook(() => useDesktopLayout()).result.current,
  };
}

describe("Studio layout breakpoints", () => {
  it("uses phone presentation in a phone workspace", () => {
    stubQueries(phoneQuery, compactQuery, offcanvasQuery);
    expect(layout()).toEqual({
      phone: true,
      compact: true,
      offcanvasNavigation: true,
      desktop: false,
    });
  });

  it("keeps iPad mini narrow without using phone presentation", () => {
    stubQueries(compactQuery, offcanvasQuery);
    expect(layout()).toEqual({
      phone: false,
      compact: true,
      offcanvasNavigation: true,
      desktop: false,
    });
  });

  it("uses desktop page layout before pinning navigation", () => {
    stubQueries(desktopQuery, offcanvasQuery);
    expect(layout()).toEqual({
      phone: false,
      compact: false,
      offcanvasNavigation: true,
      desktop: true,
    });
  });

  it("pins navigation only when the viewport can spare it", () => {
    stubQueries(desktopQuery);
    expect(layout()).toEqual({
      phone: false,
      compact: false,
      offcanvasNavigation: false,
      desktop: true,
    });
  });
});

describe("Studio input capabilities", () => {
  it("treats touch as coarse without inventing hover", () => {
    stubQueries(coarsePointerQuery);
    expect(renderHook(() => useAnyCoarsePointer()).result.current).toBe(true);
    expect(renderHook(() => useFineHoverPointer()).result.current).toBe(false);
  });

  it("preserves Apple Pencil hover while touch remains available", () => {
    stubQueries(coarsePointerQuery, fineHoverQuery);
    expect(renderHook(() => useAnyCoarsePointer()).result.current).toBe(true);
    expect(renderHook(() => useFineHoverPointer()).result.current).toBe(true);
  });

  it("keeps fine hover separate from touch capability", () => {
    stubQueries(fineHoverQuery);
    expect(renderHook(() => useAnyCoarsePointer()).result.current).toBe(false);
    expect(renderHook(() => useFineHoverPointer()).result.current).toBe(true);
  });
});

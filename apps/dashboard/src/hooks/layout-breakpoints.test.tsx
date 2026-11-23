// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCompactLayout } from "./use-compact-layout";
import { useDesktopLayout } from "./use-desktop-layout";
import { useIsMobile } from "./use-mobile";
import { usePhoneLayout } from "./use-phone-layout";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      query === "(max-width: 639px)"
        ? width <= 639
        : query === "(max-width: 1023px)"
          ? width <= 1023
          : query === "(min-width: 1024px)"
            ? width >= 1024
            : false,
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

  it("switches to the desktop workspace at 1024px", () => {
    expect(layoutAt(1024)).toEqual({
      phone: false,
      compact: false,
      offcanvasNavigation: false,
      desktop: true,
    });
  });
});

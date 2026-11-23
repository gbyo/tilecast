import * as React from "react";

/**
 * Reactive capability/layout query shared by Studio.
 *
 * Keeping every media-query decision behind one hook makes viewport and input
 * capability changes behave the same way during iPad rotation, Stage Manager
 * resizing, pointer attachment, and browser resizing.
 */
export function useMediaQuery(query: string, serverValue = false) {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia?.(query);
      if (!media) return () => {};
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );

  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.(query).matches ?? serverValue,
    () => serverValue,
  );
}

/** True when any available pointer is coarse, including iPad touch. */
export function useAnyCoarsePointer() {
  return useMediaQuery("(any-pointer: coarse)");
}

/**
 * True when any available input can hover precisely.
 *
 * iPad keeps touch as the primary pointer even when Apple Pencil, a trackpad,
 * or a mouse is available, so this must use the any-* media features.
 */
export function useFineHoverPointer() {
  return useMediaQuery("(any-hover: hover) and (any-pointer: fine)");
}

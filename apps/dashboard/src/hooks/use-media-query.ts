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

/** True only when the primary pointer can accurately hover. */
export function useFineHoverPointer() {
  return useMediaQuery("(hover: hover) and (pointer: fine)");
}

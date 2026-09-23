import * as React from "react";

const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSnapshot() {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

function getServerSnapshot() {
  return false;
}

// useDesktopLayout reports whether the viewport is wide enough for the
// multi-pane editor layouts (playlist, layout, and form builders). Editors
// render exactly one branch — the Resizable desktop panes or the
// stacked/Sheet narrow fallback — so control ids are never duplicated.
export function useDesktopLayout() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

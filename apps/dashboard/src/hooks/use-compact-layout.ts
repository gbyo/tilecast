import * as React from "react";

const COMPACT_QUERY = "(max-width: 1023px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(COMPACT_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSnapshot() {
  return window.matchMedia(COMPACT_QUERY).matches;
}

function getServerSnapshot() {
  return false;
}

// useCompactLayout reports a narrow workspace: phones, portrait tablets, and
// constrained iPad windows. It is deliberately the inverse of
// useDesktopLayout's 1024px threshold so there is no 640–1023px tablet
// no-man's-land where each toolbar makes a different density decision.
//
// Toolbars use it to render exactly one progressive-disclosure branch (a Drawer
// instead of a Popover, a combined View options menu instead of separate
// controls) so no control id or accessible name is duplicated in the document.
export function useCompactLayout() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

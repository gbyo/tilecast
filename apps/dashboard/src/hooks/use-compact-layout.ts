import * as React from "react";

const COMPACT_QUERY = "(max-width: 639px)";

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

// useCompactLayout reports a phone-width viewport. Toolbars use it to render
// exactly one branch (a Drawer instead of a Popover, a combined View options
// menu instead of separate controls) so no control id or accessible name is
// ever duplicated in the document.
export function useCompactLayout() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

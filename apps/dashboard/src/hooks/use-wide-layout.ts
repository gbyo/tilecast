import * as React from "react";

const WIDE_QUERY = "(min-width: 1280px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSnapshot() {
  return window.matchMedia(WIDE_QUERY).matches;
}

function getServerSnapshot() {
  return false;
}

// useWideLayout reports a viewport wide enough for a content column beside a
// 21rem sidebar once the app's own navigation has taken its share. Pages that
// switch layouts at this width render exactly one branch of anything they would
// otherwise duplicate, so no control or accessible name appears twice.
export function useWideLayout() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

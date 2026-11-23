import * as React from "react";

// The sidebar primitive calls this state "mobile", but it is really the
// off-canvas navigation boundary. Keeping navigation off-canvas below the
// desktop workspace threshold stops it consuming a large share of an iPad or
// a resized window.
const MOBILE_QUERY = "(max-width: 1023px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSnapshot() {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getServerSnapshot() {
  return false;
}

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

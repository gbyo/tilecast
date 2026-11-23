import * as React from "react";

const PHONE_QUERY = "(max-width: 639px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSnapshot() {
  return window.matchMedia(PHONE_QUERY).matches;
}

function getServerSnapshot() {
  return false;
}

// usePhoneLayout answers a presentation question, not a density question.
// Phone-sized content areas use bottom drawers/full-height compact surfaces.
// iPad-sized medium windows keep the narrow workspace controls from
// useCompactLayout, but have enough room for popovers, dialogs, and side
// panels. Keeping the two decisions separate avoids turning iPad into a
// stretched phone UI.
export function usePhoneLayout() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

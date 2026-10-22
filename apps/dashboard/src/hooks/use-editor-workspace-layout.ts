import * as React from "react";

/**
 * Below this width an editor should spend space on the document, canvas, or
 * inspector instead of permanently reserving the global Studio sidebar.
 * The sidebar remains reachable from its trigger as temporary navigation.
 */
const CONSTRAINED_EDITOR_QUERY = "(max-width: 1180px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(CONSTRAINED_EDITOR_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSnapshot() {
  return window.matchMedia(CONSTRAINED_EDITOR_QUERY).matches;
}

function getServerSnapshot() {
  return false;
}

export function useConstrainedEditorWorkspace() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

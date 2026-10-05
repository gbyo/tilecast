import { useCallback, useSyncExternalStore } from "react";

// Fleet filters, grouping, sorting, and view persist in localStorage so the
// page opens as it was left. They are read through one shared store, not
// per-component state, because the page summary (which offers a "needs
// attention" quick filter) and the fleet list sit in different components and
// must always agree on the active status.

const listeners = new Set<() => void>();
// Used only when storage is unavailable (private browsing), so a preference
// still holds for the lifetime of the page.
const fallbackValues = new Map<string, string>();

function readStored(key: string): string | null {
  try {
    const stored = window.localStorage?.getItem(key) ?? null;
    if (stored !== null) return stored;
  } catch {
    // Fall through to the in-memory value.
  }
  return fallbackValues.get(key) ?? null;
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage?.setItem(key, value);
    fallbackValues.delete(key);
  } catch {
    // Preferences are an enhancement; private browsing may reject storage.
    fallbackValues.set(key, value);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function useFleetPreference<T extends string>(key: string, fallback: T) {
  const value = useSyncExternalStore(
    subscribe,
    () => (readStored(key) as T | null) ?? fallback,
    () => fallback,
  );
  const update = useCallback((next: T) => writeStored(key, next), [key]);
  return [value, update] as const;
}

export const fleetPreferenceKeys = {
  search: "tilecast.screens.search",
  status: "tilecast.screens.status",
  location: "tilecast.screens.location",
  platform: "tilecast.screens.platform",
  playing: "tilecast.screens.playing",
  syncGroup: "tilecast.screens.syncGroup",
  orientation: "tilecast.screens.orientation",
  update: "tilecast.screens.update",
  groupBy: "tilecast.screens.groupBy",
  sort: "tilecast.screens.sort",
  view: "tilecast.screens.view",
} as const;

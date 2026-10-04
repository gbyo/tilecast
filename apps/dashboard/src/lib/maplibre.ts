import {
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
  type MapOptions,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

// MapLibre GL JS v6 is ESM-only. Vite must bundle the worker through its
// worker pipeline so the worker and its shared module stay self-contained.
setWorkerUrl(maplibreWorkerUrl);

export const OPENFREEMAP_STYLE_URL =
  "https://tiles.openfreemap.org/styles/liberty";

export function createTilecastMap(
  options: Omit<MapOptions, "style" | "attributionControl">,
) {
  const map = new MapLibreMap({
    ...options,
    style: OPENFREEMAP_STYLE_URL,
    attributionControl: {},
  });
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  return map;
}

export function mapLibreErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message || error.name || null;
  }
  if (typeof error === "string") {
    const message = error.trim();
    return message || null;
  }
  return null;
}

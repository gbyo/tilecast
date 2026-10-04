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

const OPENFREEMAP_ORIGIN = "https://tiles.openfreemap.org";
const OPENFREEMAP_PROXY_PREFIX = "/maps/openfreemap";

export const OPENFREEMAP_STYLE_URL = `${OPENFREEMAP_PROXY_PREFIX}/styles/liberty`;

export function proxyOpenFreeMapURL(url: string): string {
  const prefix = `${OPENFREEMAP_ORIGIN}/`;
  if (!url.startsWith(prefix)) return url;
  return `${OPENFREEMAP_PROXY_PREFIX}/${url.slice(prefix.length)}`;
}

export function createTilecastMap(
  options: Omit<
    MapOptions,
    "style" | "attributionControl" | "transformRequest"
  >,
) {
  const map = new MapLibreMap({
    ...options,
    style: OPENFREEMAP_STYLE_URL,
    attributionControl: {},
    transformRequest: (url) => {
      const proxied = proxyOpenFreeMapURL(url);
      if (
        proxied !== url ||
        proxied.startsWith(`${OPENFREEMAP_PROXY_PREFIX}/`)
      ) {
        return { url: proxied, credentials: "same-origin" };
      }
      return { url };
    },
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

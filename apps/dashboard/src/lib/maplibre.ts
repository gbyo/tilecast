import { setWorkerUrl } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

// MapLibre GL JS v6 no longer embeds its worker when consumed through a
// bundler. Vite must bundle the worker explicitly or production maps can mount
// without ever loading vector tiles.
setWorkerUrl(maplibreWorkerUrl);

export const OPENFREEMAP_STYLE_URL =
  "https://tiles.openfreemap.org/styles/liberty";

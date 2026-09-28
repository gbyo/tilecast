import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseSpotlightConfig,
  resolveSpotlightData,
  TilecastSpotlightWidget,
  type SpotlightConfig,
  type SpotlightData,
} from "./spotlight.ts";

export default defineWidget<SpotlightConfig, SpotlightData>({
  type: "tilecast.spotlight",
  version: 1,
  tagName: "tc-widget-spotlight",
  parseConfig: parseSpotlightConfig,
  // Spotlight shows the first usable prepared record. No source or no
  // usable records is an expected empty state, never an error; a source
  // without a records dataset is a configuration error. Artwork resolves
  // only through the presentation's media grant.
  resolveData: (config, resources) => resolveSpotlightData(config, resources),
  element: TilecastSpotlightWidget,
});

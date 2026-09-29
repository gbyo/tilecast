import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseMetricsConfig,
  resolveMetricsData,
  TilecastMetricsWidget,
  type MetricsConfig,
  type MetricsData,
} from "./metrics.ts";

export default defineWidget<MetricsConfig, MetricsData>({
  type: "tilecast.metrics",
  version: 1,
  tagName: "tc-widget-metrics",
  parseConfig: parseMetricsConfig,
  // Metrics read the first record of a records source, or the single
  // value object of an object source. No source or no usable values is an
  // expected empty state, never an error; a source with neither shape is
  // a configuration error.
  resolveData: (config, resources) => resolveMetricsData(config, resources),
  element: TilecastMetricsWidget,
});

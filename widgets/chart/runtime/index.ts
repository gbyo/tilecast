import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseChartConfig,
  resolveChartData,
  TilecastChartWidget,
  type ChartConfig,
  type ChartData,
} from "./chart.ts";

export default defineWidget<ChartConfig, ChartData>({
  type: "tilecast.chart",
  version: 1,
  tagName: "tc-widget-chart",
  parseConfig: parseChartConfig,
  // Chart plots records with category or time labels, or time-series
  // points with their prepared timestamps. No source or no usable points
  // is an expected empty state, never an error; a source with neither
  // shape is a configuration error.
  resolveData: (config, resources) => resolveChartData(config, resources),
  element: TilecastChartWidget,
});

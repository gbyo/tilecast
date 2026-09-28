import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseTickerConfig,
  resolveTickerData,
  TilecastTickerWidget,
  type TickerConfig,
  type TickerData,
} from "./ticker.ts";

export default defineWidget<TickerConfig, TickerData>({
  type: "tilecast.ticker",
  version: 1,
  tagName: "tc-widget-ticker",
  parseConfig: parseTickerConfig,
  // A Ticker reads the one records source the author connected. No source or
  // no usable items is an expected empty state, never an error; a source
  // without a records dataset, or with no primary text to scroll, is a
  // configuration error.
  resolveData: (config, resources) => resolveTickerData(config, resources),
  element: TilecastTickerWidget,
});

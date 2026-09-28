import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseProgressConfig,
  resolveProgressData,
  TilecastProgressWidget,
  type ProgressConfig,
  type ProgressData,
} from "./progress.ts";

export default defineWidget<ProgressConfig, ProgressData>({
  type: "tilecast.progress",
  version: 1,
  tagName: "tc-widget-progress",
  parseConfig: parseProgressConfig,
  // Progress reads the first record of a records source, or the single
  // value object of an object source. No source or no usable value is an
  // expected empty state, never an error; a source with neither shape, or
  // a missing or non-positive target, is a configuration failure.
  resolveData: (config, resources) => resolveProgressData(config, resources),
  element: TilecastProgressWidget,
});

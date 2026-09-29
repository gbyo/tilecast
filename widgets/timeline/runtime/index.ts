import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseTimelineConfig,
  resolveTimelineData,
  TilecastTimelineWidget,
  type TimelineConfig,
  type TimelineData,
} from "./timeline.ts";

export default defineWidget<TimelineConfig, TimelineData>({
  type: "tilecast.timeline",
  version: 1,
  tagName: "tc-widget-timeline",
  parseConfig: parseTimelineConfig,
  // Timeline shows records in source order up to the configured maximum.
  // No source or no usable records is an expected empty state, never an
  // error; a source without a records dataset is a configuration error.
  // Timeline never sorts, filters, or drops the past.
  resolveData: (config, resources) => resolveTimelineData(config, resources),
  element: TilecastTimelineWidget,
});

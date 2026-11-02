import { defineWidget } from "@tilecast/widget-sdk";
import { TilecastEventScrollerWidget } from "./event-scroller.ts";
import {
  parseEventScrollerConfig,
  resolveEventScrollerData,
  type EventScrollerConfig,
  type EventScrollerData,
} from "./events.ts";

export default defineWidget<EventScrollerConfig, EventScrollerData>({
  type: "tilecast.event-scroller",
  version: 1,
  tagName: "tc-widget-event-scroller",
  parseConfig: parseEventScrollerConfig,
  resolveData: resolveEventScrollerData,
  element: TilecastEventScrollerWidget,
});

import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseCountdownConfig,
  resolveCountdownData,
  TilecastCountdownWidget,
  type CountdownConfig,
  type CountdownData,
} from "./countdown.ts";

export default defineWidget<CountdownConfig, CountdownData>({
  type: "tilecast.countdown",
  version: 1,
  tagName: "tc-widget-countdown",
  parseConfig: parseCountdownConfig,
  // A Countdown reads no Data Source; its only resource is a chosen
  // library font. Without a target it is an expected empty state; a
  // hidden completion is decided by the element against the Widget clock.
  resolveData: (config, resources) => resolveCountdownData(config, resources),
  element: TilecastCountdownWidget,
});

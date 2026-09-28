import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseCountdownConfig,
  resolveCountdownData,
  TilecastCountdownWidget,
  type CountdownConfig,
} from "./countdown.ts";

export default defineWidget<CountdownConfig, null>({
  type: "tilecast.countdown",
  version: 1,
  tagName: "tc-widget-countdown",
  parseConfig: parseCountdownConfig,
  // A Countdown is standalone: it reads no Data Source. Without a target
  // it is an expected empty state; a hidden completion is decided by the
  // element against the Widget clock.
  resolveData: (config) => resolveCountdownData(config),
  element: TilecastCountdownWidget,
});

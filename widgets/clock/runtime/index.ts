import { defineWidget, ready } from "@tilecast/widget-sdk";
import {
  parseClockConfig,
  TilecastClockWidget,
  type ClockConfig,
} from "./clock.ts";

export default defineWidget<ClockConfig, null>({
  type: "tilecast.clock",
  version: 1,
  tagName: "tc-widget-clock",
  parseConfig: parseClockConfig,
  // A Clock is standalone: it reads no Data Source and is never empty.
  resolveData: () => ready(null),
  element: TilecastClockWidget,
});

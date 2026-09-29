import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseStatusConfig,
  resolveStatusData,
  TilecastStatusWidget,
  type StatusConfig,
  type StatusData,
} from "./status.ts";

export default defineWidget<StatusConfig, StatusData>({
  type: "tilecast.status",
  version: 1,
  tagName: "tc-widget-status",
  parseConfig: parseStatusConfig,
  resolveData: (config, resources) => resolveStatusData(config, resources),
  element: TilecastStatusWidget,
});

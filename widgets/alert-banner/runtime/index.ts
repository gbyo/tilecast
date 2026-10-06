import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseAlertBannerConfig,
  resolveAlertBannerData,
  TilecastAlertBannerWidget,
  type AlertBannerConfig,
  type AlertBannerData,
} from "./alert-banner.ts";

export default defineWidget<AlertBannerConfig, AlertBannerData>({
  type: "tilecast.alert-banner",
  version: 1,
  tagName: "tc-widget-alert-banner",
  parseConfig: parseAlertBannerConfig,
  resolveData: (config, resources) => resolveAlertBannerData(config, resources),
  element: TilecastAlertBannerWidget,
});

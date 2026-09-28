import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseImageNoticeConfig,
  resolveImageNoticeData,
  TilecastImageNoticeWidget,
  type ImageNoticeConfig,
  type ImageNoticeData,
} from "./image-notice.ts";

export default defineWidget<ImageNoticeConfig, ImageNoticeData>({
  type: "tilecast.image-notice",
  version: 1,
  tagName: "tc-widget-image-notice",
  parseConfig: parseImageNoticeConfig,
  // The image comes only from the presentation's media grant. A missing
  // selection or an image the Player cannot show is expected empty content.
  resolveData: (config, resources) => resolveImageNoticeData(config, resources),
  element: TilecastImageNoticeWidget,
});

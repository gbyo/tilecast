import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseTextConfig,
  resolveTextData,
  TilecastTextWidget,
  type TextConfig,
} from "./text.ts";

export default defineWidget<TextConfig, null>({
  type: "tilecast.text",
  version: 1,
  tagName: "tc-widget-text",
  parseConfig: parseTextConfig,
  // Text is standalone: it reads no Data Source. Without any words it is
  // an expected empty state, never an error.
  resolveData: (config) => resolveTextData(config),
  element: TilecastTextWidget,
});

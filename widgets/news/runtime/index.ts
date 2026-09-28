import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseNewsConfig,
  resolveNewsData,
  TilecastNewsWidget,
  type NewsConfig,
  type NewsData,
} from "./news.ts";

export default defineWidget<NewsConfig, NewsData>({
  type: "tilecast.news",
  version: 1,
  tagName: "tc-widget-news",
  parseConfig: parseNewsConfig,
  // News reads the one compatible source the author connected and resolves
  // story slots from feed roles first. No source or no usable stories is an
  // expected empty state, never an error; a source without a records
  // dataset, or one with no headline-like field, is a configuration error.
  resolveData: (config, resources) => resolveNewsData(config, resources),
  element: TilecastNewsWidget,
});

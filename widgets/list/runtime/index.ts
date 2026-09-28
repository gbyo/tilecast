import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseListConfig,
  resolveListData,
  TilecastListWidget,
  type ListConfig,
  type ListData,
} from "./list.ts";

export default defineWidget<ListConfig, ListData>({
  type: "tilecast.list",
  version: 1,
  tagName: "tc-widget-list",
  parseConfig: parseListConfig,
  // A List reads the one records source the author connected. No source or
  // no usable records is an expected empty state, never an error; a source
  // without a records dataset is a configuration error.
  resolveData: (config, resources) => resolveListData(config, resources),
  element: TilecastListWidget,
});

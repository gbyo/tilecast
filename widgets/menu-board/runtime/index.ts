import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseMenuBoardConfig,
  resolveMenuBoardData,
  TilecastMenuBoardWidget,
  type MenuBoardConfig,
  type MenuBoardData,
} from "./menu-board.ts";

export default defineWidget<MenuBoardConfig, MenuBoardData>({
  type: "tilecast.menu-board",
  version: 1,
  tagName: "tc-widget-menu-board",
  parseConfig: parseMenuBoardConfig,
  // A Menu Board reads the one records source the author connected. No
  // source or no usable records is an expected empty state, never an
  // error; a source without a records dataset is a configuration error.
  // Section grouping happens in the element, where the screen locale is
  // known.
  resolveData: (config, resources) => resolveMenuBoardData(config, resources),
  element: TilecastMenuBoardWidget,
});

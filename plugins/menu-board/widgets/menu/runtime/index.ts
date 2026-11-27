import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseMenuConfig,
  resolveMenuData,
  TilecastMenuWidget,
  type MenuConfig,
  type MenuData,
} from "./menu.ts";

export default defineWidget<MenuConfig, MenuData>({
  type: "menuboard.menu",
  version: 1,
  tagName: "tc-widget-menuboard-menu",
  parseConfig: parseMenuConfig,
  // No feed and an empty menu are empty states; a source without a records
  // dataset is a configuration error.
  resolveData: (config, resources) => resolveMenuData(config, resources),
  element: TilecastMenuWidget,
});

import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseTableConfig,
  resolveTableData,
  TilecastTableWidget,
  type TableConfig,
  type TableData,
} from "./table.ts";

export default defineWidget<TableConfig, TableData>({
  type: "tilecast.table",
  version: 1,
  tagName: "tc-widget-table",
  parseConfig: parseTableConfig,
  // A Table reads the one records source the author connected. No source,
  // no usable records or no usable columns is an expected empty state,
  // never an error; a source without a records dataset is one.
  resolveData: (config, resources) => resolveTableData(config, resources),
  element: TilecastTableWidget,
});

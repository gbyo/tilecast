import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseCardsConfig,
  resolveCardsData,
  TilecastCardsWidget,
  type CardsConfig,
  type CardsData,
} from "./cards.ts";

export default defineWidget<CardsConfig, CardsData>({
  type: "tilecast.cards",
  version: 1,
  tagName: "tc-widget-cards",
  parseConfig: parseCardsConfig,
  // Cards read the one records source the author connected. No source or
  // no usable records is an expected empty state, never an error; a source
  // without a records dataset is one.
  resolveData: (config, resources) => resolveCardsData(config, resources),
  element: TilecastCardsWidget,
});

import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseRoomSignConfig,
  resolveRoomSignData,
  TilecastRoomSignWidget,
  type RoomSignConfig,
  type RoomSignData,
} from "./room-sign.ts";

export default defineWidget<RoomSignConfig, RoomSignData>({
  type: "roomsign.room-sign",
  version: 1,
  tagName: "tc-widget-roomsign-room-sign",
  parseConfig: parseRoomSignConfig,
  // No source is the sign's resting state; a room without meetings is
  // free, which is a ready sign, not an empty one.
  resolveData: (config, resources) => resolveRoomSignData(config, resources),
  element: TilecastRoomSignWidget,
});

import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseAgendaConfig,
  resolveAgendaData,
  TilecastAgendaWidget,
  type AgendaConfig,
  type AgendaData,
} from "./agenda.ts";

export default defineWidget<AgendaConfig, AgendaData>({
  type: "tilecast.agenda",
  version: 1,
  tagName: "tc-widget-agenda",
  parseConfig: parseAgendaConfig,
  // An Agenda reads the one calendar or records source the author
  // connected. No source, no start mapping or no placeable events is an
  // expected empty state, never an error; a source without a records
  // dataset is a configuration error. Ended-event removal happens in the
  // element against the Widget clock, where time is known.
  resolveData: (config, resources) => resolveAgendaData(config, resources),
  element: TilecastAgendaWidget,
});

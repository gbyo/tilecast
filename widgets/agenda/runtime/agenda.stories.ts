import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import standard from "../fixtures/default.json";
import empty from "../fixtures/empty.json";
import noSource from "../fixtures/no-source.json";
import agenda from "./index.ts";

const meta: Meta = { title: "Widgets/Agenda" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(agenda, manifest as never, fixture, frame);

export const DefaultLandscape = story(standard, "landscape");
export const DefaultPortrait = story(standard, "portrait");
export const DefaultStrip = story(standard, "strip");
export const DefaultSidebar = story(standard, "sidebar");
export const DefaultZone = story(standard, "zone");
export const EmptyZone = story(empty, "zone");
export const NoSourceZone = story(noSource, "zone");
export const NowNextLandscape = story(
  {
    ...standard,
    name: "Now and next",
    configuration: {
      ...standard.configuration,
      style: "now-next",
      nowLabel: "Happening now",
      nextLabel: "Coming up",
    },
  },
  "landscape",
);
export const ScheduleBoardLandscape = story(
  {
    ...standard,
    name: "Schedule board",
    configuration: { ...standard.configuration, style: "schedule-board" },
  },
  "landscape",
);

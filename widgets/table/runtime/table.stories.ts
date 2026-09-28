import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import standard from "../fixtures/default.json";
import empty from "../fixtures/empty.json";
import noSource from "../fixtures/no-source.json";
import table from "./index.ts";

const meta: Meta = { title: "Widgets/Table" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(table, manifest as never, fixture, frame);

export const DefaultLandscape = story(standard, "landscape");
export const DefaultPortrait = story(standard, "portrait");
export const DefaultStrip = story(standard, "strip");
export const DefaultZone = story(standard, "zone");
export const EmptyZone = story(empty, "zone");
export const NoSourceZone = story(noSource, "zone");

import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import standard from "../fixtures/default.json";
import horizontal from "../fixtures/horizontal.json";
import long from "../fixtures/long.json";
import empty from "../fixtures/empty.json";
import noSource from "../fixtures/no-source.json";
import timeline from "./index.ts";

const meta: Meta = { title: "Widgets/Timeline" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(timeline, manifest as never, fixture, frame);

export const DefaultLandscape = story(standard, "landscape");
export const DefaultPortrait = story(standard, "portrait");
export const DefaultZone = story(standard, "zone");
export const HorizontalLandscape = story(horizontal, "landscape");
export const HorizontalStrip = story(horizontal, "strip");
export const LongPortrait = story(long, "portrait");
export const EmptyZone = story(empty, "zone");
export const NoSourceZone = story(noSource, "zone");

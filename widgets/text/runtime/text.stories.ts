import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import callout from "../fixtures/callout.json";
import standard from "../fixtures/default.json";
import empty from "../fixtures/empty.json";
import headline from "../fixtures/headline.json";
import long from "../fixtures/long.json";
import text from "./index.ts";

const meta: Meta = { title: "Widgets/Text" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(text, manifest as never, fixture, frame);

export const DefaultLandscape = story(standard, "landscape");
export const DefaultPortrait = story(standard, "portrait");
export const DefaultStrip = story(standard, "strip");
export const DefaultSidebar = story(standard, "sidebar");
export const DefaultZone = story(standard, "zone");
export const HeadlineLandscape = story(headline, "landscape");
export const HeadlineStrip = story(headline, "strip");
export const HeadlinePortrait = story(headline, "portrait");
export const CalloutQuarter = story(callout, "quarter");
export const CalloutSidebar = story(callout, "sidebar");
export const LongLandscape = story(long, "landscape");
export const LongZone = story(long, "zone");
export const EmptyZone = story(empty, "zone");

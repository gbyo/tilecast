import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import cover from "../fixtures/cover.json";
import standard from "../fixtures/default.json";
import imageNotice from "./index.ts";

const meta: Meta = { title: "Widgets/Image Notice (compatibility)" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(imageNotice, manifest as never, fixture, frame);

export const DefaultLandscape = story(standard, "landscape");
export const DefaultPortrait = story(standard, "portrait");
export const DefaultZone = story(standard, "zone");
export const CoverLandscape = story(cover, "landscape");

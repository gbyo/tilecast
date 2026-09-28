import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import standard from "../fixtures/default.json";
import withImage from "../fixtures/image.json";
import long from "../fixtures/long.json";
import minimal from "../fixtures/minimal.json";
import empty from "../fixtures/empty.json";
import noSource from "../fixtures/no-source.json";
import spotlight from "./index.ts";

const meta: Meta = { title: "Widgets/Spotlight" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(spotlight, manifest as never, fixture, frame);

export const DefaultLandscape = story(standard, "landscape");
export const DefaultPortrait = story(standard, "portrait");
export const DefaultStrip = story(standard, "strip");
export const DefaultZone = story(standard, "zone");
export const ImageLandscape = story(withImage, "landscape");
export const ImagePortrait = story(withImage, "portrait");
export const LongZone = story(long, "zone");
export const MinimalZone = story(minimal, "zone");
export const EmptyZone = story(empty, "zone");
export const NoSourceZone = story(noSource, "zone");

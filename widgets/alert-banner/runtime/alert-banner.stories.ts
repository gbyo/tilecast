import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import standard from "../fixtures/default.json";
import noSource from "../fixtures/no-source.json";
import alertBanner from "./index.ts";

const meta: Meta = { title: "Widgets/Alert Banner" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(alertBanner, manifest as never, fixture, frame);

export const Strip = story(standard, "strip");
export const SmallZone = story(standard, "zone");
export const NoSource = story(noSource, "strip");

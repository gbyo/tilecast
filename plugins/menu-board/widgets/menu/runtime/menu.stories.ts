import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import fixture from "../fixtures/default.json";
import widget from "./index.ts";

const meta: Meta = { title: "Plugins/menu_board/menu" };
export default meta;

const story = (frame: Parameters<typeof widgetStory>[3]): StoryObj =>
  widgetStory(widget, manifest as never, fixture, frame);

export const Landscape = story("landscape");
export const Portrait = story("portrait");
export const Strip = story("strip");
export const Zone = story("zone");

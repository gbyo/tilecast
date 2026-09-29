import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import standard from "../fixtures/default.json";
import banner from "../fixtures/banner.json";
import empty from "../fixtures/empty.json";
import noSource from "../fixtures/no-source.json";
import status from "./index.ts";

const meta: Meta = { title: "Widgets/Status" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(status, manifest as never, fixture, frame);

export const PanelLandscape = story(standard, "landscape");
export const PanelPortrait = story(standard, "portrait");
export const PanelSidebar = story(standard, "sidebar");
export const PanelSmallZone = story(standard, "zone");
export const BannerStrip = story(banner, "strip");
export const BannerLandscape = story(banner, "landscape");
export const EmptyZone = story(empty, "zone");
export const NoSourceZone = story(noSource, "zone");

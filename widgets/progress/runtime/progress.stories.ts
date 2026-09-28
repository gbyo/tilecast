import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import standard from "../fixtures/default.json";
import ring from "../fixtures/ring.json";
import thermometer from "../fixtures/thermometer.json";
import overTarget from "../fixtures/over-target.json";
import empty from "../fixtures/empty.json";
import noSource from "../fixtures/no-source.json";
import progress from "./index.ts";

const meta: Meta = { title: "Widgets/Progress" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(progress, manifest as never, fixture, frame);

export const DefaultLandscape = story(standard, "landscape");
export const DefaultStrip = story(standard, "strip");
export const DefaultZone = story(standard, "zone");
export const RingLandscape = story(ring, "landscape");
export const RingZone = story(ring, "zone");
export const ThermometerLandscape = story(thermometer, "landscape");
export const ThermometerPortrait = story(thermometer, "portrait");
export const OverTargetStrip = story(overTarget, "strip");
export const EmptyZone = story(empty, "zone");
export const NoSourceZone = story(noSource, "zone");

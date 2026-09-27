import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import analog from "../fixtures/analog.json";
import dateSeconds from "../fixtures/date-seconds.json";
import standard from "../fixtures/default.json";
import lightBrand from "../fixtures/light-brand.json";
import longLocale from "../fixtures/long-locale.json";
import minimal from "../fixtures/minimal.json";
import otherZone from "../fixtures/other-zone.json";
import clock from "./index.ts";

const meta: Meta = { title: "Widgets/Clock" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(clock, manifest as never, fixture, frame);

export const DefaultLandscape = story(standard, "landscape");
export const DefaultPortrait = story(standard, "portrait");
export const DefaultQuarter = story(standard, "quarter");
export const DefaultStrip = story(standard, "strip");
export const DefaultSidebar = story(standard, "sidebar");
export const DefaultZone = story(standard, "zone");
export const DateSecondsLandscape = story(dateSeconds, "landscape");
export const DateSecondsStrip = story(dateSeconds, "strip");
export const DateSecondsSidebar = story(dateSeconds, "sidebar");
export const OtherZoneLandscape = story(otherZone, "landscape");
export const OtherZoneZone = story(otherZone, "zone");
export const MinimalLandscape = story(minimal, "landscape");
export const MinimalPortrait = story(minimal, "portrait");
export const AnalogLandscape = story(analog, "landscape");
export const AnalogPortrait = story(analog, "portrait");
export const AnalogStrip = story(analog, "strip");
export const AnalogZone = story(analog, "zone");
export const LightBrandQuarter = story(lightBrand, "quarter");
export const LongLocaleSidebar = story(longLocale, "sidebar");
export const LongLocaleStrip = story(longLocale, "strip");

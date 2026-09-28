import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import complete from "../fixtures/complete.json";
import countUp from "../fixtures/count-up.json";
import standard from "../fixtures/default.json";
import noTarget from "../fixtures/no-target.json";
import seconds from "../fixtures/seconds.json";
import weekly from "../fixtures/weekly.json";
import countdown from "./index.ts";

const meta: Meta = { title: "Widgets/Countdown" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(countdown, manifest as never, fixture, frame);

export const DefaultLandscape = story(standard, "landscape");
export const DefaultPortrait = story(standard, "portrait");
export const DefaultStrip = story(standard, "strip");
export const DefaultSidebar = story(standard, "sidebar");
export const DefaultZone = story(standard, "zone");
export const SecondsQuarter = story(seconds, "quarter");
export const SecondsStrip = story(seconds, "strip");
export const CountUpLandscape = story(countUp, "landscape");
export const CountUpPortrait = story(countUp, "portrait");
export const WeeklyLandscape = story(weekly, "landscape");
export const CompleteLandscape = story(complete, "landscape");
export const NoTargetZone = story(noTarget, "zone");

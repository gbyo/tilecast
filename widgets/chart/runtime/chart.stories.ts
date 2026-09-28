import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import standard from "../fixtures/default.json";
import lines from "../fixtures/lines.json";
import area from "../fixtures/area.json";
import timeSeries from "../fixtures/time-series.json";
import mixed from "../fixtures/mixed.json";
import flat from "../fixtures/flat.json";
import singlePoint from "../fixtures/single-point.json";
import empty from "../fixtures/empty.json";
import noSource from "../fixtures/no-source.json";
import chart from "./index.ts";

const meta: Meta = { title: "Widgets/Chart" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(chart, manifest as never, fixture, frame);

export const DefaultLandscape = story(standard, "landscape");
export const DefaultStrip = story(standard, "strip");
export const DefaultZone = story(standard, "zone");
export const LinesLandscape = story(lines, "landscape");
export const AreaPortrait = story(area, "portrait");
export const TimeSeriesLandscape = story(timeSeries, "landscape");
export const MixedZone = story(mixed, "zone");
export const FlatZone = story(flat, "zone");
export const SinglePointZone = story(singlePoint, "zone");
export const EmptyZone = story(empty, "zone");
export const NoSourceZone = story(noSource, "zone");

import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import standard from "../fixtures/default.json";
import legacy from "../fixtures/legacy-fields.json";
import empty from "../fixtures/empty.json";
import noSource from "../fixtures/no-source.json";
import ticker from "./index.ts";

const meta: Meta = { title: "Widgets/Ticker" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(ticker, manifest as never, fixture, frame);

export const DefaultStrip = story(standard, "strip");
export const DefaultLandscape = story(standard, "landscape");
export const DefaultZone = story(standard, "zone");
export const LegacyFieldsStrip = story(legacy, "strip");
export const EmptyZone = story(empty, "zone");
export const NoSourceZone = story(noSource, "zone");

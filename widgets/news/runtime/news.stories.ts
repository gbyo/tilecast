import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import standard from "../fixtures/default.json";
import lead from "../fixtures/lead.json";
import compact from "../fixtures/compact.json";
import legacyKeys from "../fixtures/legacy-keys.json";
import empty from "../fixtures/empty.json";
import noSource from "../fixtures/no-source.json";
import news from "./index.ts";

const meta: Meta = { title: "Widgets/News" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(news, manifest as never, fixture, frame);

export const DefaultLandscape = story(standard, "landscape");
export const DefaultPortrait = story(standard, "portrait");
export const DefaultStrip = story(standard, "strip");
export const DefaultSidebar = story(standard, "sidebar");
export const DefaultZone = story(standard, "zone");
export const LeadLandscape = story(lead, "landscape");
export const LeadPortrait = story(lead, "portrait");
export const LeadZone = story(lead, "zone");
export const CompactLandscape = story(compact, "landscape");
export const CompactZone = story(compact, "zone");
export const LegacyKeysZone = story(legacyKeys, "zone");
export const EmptyZone = story(empty, "zone");
export const NoSourceZone = story(noSource, "zone");

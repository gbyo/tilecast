import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import codeOnly from "../fixtures/code-only.json";
import standard from "../fixtures/default.json";
import empty from "../fixtures/empty.json";
import lightBrand from "../fixtures/light-brand.json";
import qrCode from "./index.ts";

const meta: Meta = { title: "Widgets/QR Code" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(qrCode, manifest as never, fixture, frame);

export const DefaultLandscape = story(standard, "landscape");
export const DefaultPortrait = story(standard, "portrait");
export const DefaultStrip = story(standard, "strip");
export const DefaultSidebar = story(standard, "sidebar");
export const DefaultZone = story(standard, "zone");
export const CodeOnlyLandscape = story(codeOnly, "landscape");
export const CodeOnlyZone = story(codeOnly, "zone");
export const LightBrandLandscape = story(lightBrand, "landscape");
export const LightBrandPortrait = story(lightBrand, "portrait");
export const EmptyZone = story(empty, "zone");

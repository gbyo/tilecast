import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import standard from "../fixtures/default.json";
import longMessage from "../fixtures/long-message.json";
import longMessageMotion from "../fixtures/long-message-motion.json";
import messageOnly from "../fixtures/message-only.json";
import noSource from "../fixtures/no-source.json";
import alertBanner from "./index.ts";

const meta: Meta = { title: "Widgets/Alert Banner" };
export default meta;

const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3],
): StoryObj => widgetStory(alertBanner, manifest as never, fixture, frame);

// Alert Banner exists for its geometry, so the same full fixture is reviewed
// across the strip sizes a Layout can give it, from very wide down to a
// phone-width band. Label chrome drops first, severity last.
export const Natural = story(standard, { width: 1920, height: 160 });
export const Strip1920x240 = story(standard, { width: 1920, height: 240 });
export const Strip1920x180 = story(standard, { width: 1920, height: 180 });
export const Strip1920x120 = story(standard, { width: 1920, height: 120 });
export const Strip1920x80 = story(standard, { width: 1920, height: 80 });
export const Strip1280x96 = story(standard, { width: 1280, height: 96 });
export const Strip960x72 = story(standard, { width: 960, height: 72 });
export const Strip640x64 = story(standard, { width: 640, height: 64 });
// Below 48px high or 360px wide, the severity badge drops too and only the
// message remains.
export const Strip640x48 = story(standard, { width: 640, height: 48 });
export const Strip320x64 = story(standard, { width: 320, height: 64 });

// It must never behave like a fullscreen or 16:9 surface.
export const SmallZone = story(standard, "zone");
export const WideStrip = story(standard, "strip");

// A source with only a message needs no severity or label.
export const MessageOnly = story(messageOnly, { width: 1920, height: 160 });
export const MessageOnlyNarrow = story(messageOnly, { width: 640, height: 64 });

// Overflow stays inside the band, static and with the marquee track.
export const LongMessageStatic = story(longMessage, {
  width: 960,
  height: 72,
});
export const LongMessageWide = story(longMessage, { width: 1920, height: 160 });
export const LongMessageMotion = story(longMessageMotion, {
  width: 1920,
  height: 160,
});
export const LongMessageMotionNarrow = story(longMessageMotion, {
  width: 640,
  height: 64,
});

export const NoSource = story(noSource, { width: 1920, height: 160 });
export const NoSourceNarrow = story(noSource, { width: 640, height: 64 });

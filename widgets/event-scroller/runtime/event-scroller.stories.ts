import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import standard from "../fixtures/default.json";
import few from "../fixtures/few.json";
import many from "../fixtures/many.json";
import dates from "../fixtures/date-only.json";
import reduced from "../fixtures/reduced-motion.json";
import empty from "../fixtures/empty.json";
import noSource from "../fixtures/no-source.json";
import widget from "./index.ts";

const meta: Meta = { title: "Widgets/Event Scroller" };
export default meta;
const story = (
  fixture: unknown,
  frame: Parameters<typeof widgetStory>[3] = "landscape",
): StoryObj => widgetStory(widget, manifest as never, fixture, frame);
const withConfig = (configuration: Record<string, unknown>) => ({
  ...standard,
  configuration: { ...standard.configuration, ...configuration },
});

export const Fullscreen = story(standard);
export const FewEvents = story(few);
export const ManyEvents = story(many);
export const Compact = story(withConfig({ density: "compact" }));
export const Spacious = story(withConfig({ density: "spacious" }));
export const LargerText = story(
  withConfig({ textScale: 160, headingScale: 120 }),
);
export const TightRows = story(
  withConfig({
    textScale: 135,
    rowLayout: "natural",
    rowSpacing: 10,
    contentPadding: 30,
    headingSpacing: 25,
  }),
);
export const NaturalSpacing = story(withConfig({ rowLayout: "natural" }));
export const LargeRail = story(
  withConfig({
    textScale: 160,
    headingScale: 90,
    rowSpacing: 10,
    contentPadding: 30,
  }),
  "strip",
);
export const NoHeading = story(withConfig({ heading: "" }));
export const AutoRail = story(standard, "strip");
export const Horizontal = story(
  withConfig({ flow: "horizontal", heading: "" }),
  "strip",
);
export const ForcedHorizontal = story(withConfig({ flow: "horizontal" }));
export const ForcedVertical = story(withConfig({ flow: "vertical" }), "strip");
export const Down = story(withConfig({ verticalDirection: "down" }));
export const Right = story(
  withConfig({ horizontalDirection: "right" }),
  "strip",
);
export const ReducedMotion = story(reduced);
export const ScrollingDisabled = story(withConfig({ scrolling: false }));
export const Empty = story(empty);
export const NoSource = story(noSource, "zone");
export const DateOnly = story(dates);
export const Sidebar = story(standard, "sidebar");
export const LayoutZone = story(standard, "zone");
export const SmallZone = story(standard, { width: 280, height: 200 });
export const InProgress = story({
  ...standard,
  context: { ...standard.context, now: "2026-10-12T22:00:00Z" },
});
export const CustomTheme = story(
  withConfig({
    backgroundColor: "#f7f5ef",
    foregroundColor: "#16202c",
    accentColor: "#8b2c28",
    showLocation: true,
    showCategory: true,
  }),
);
export const LongTitle = story({
  ...standard,
  documents: {
    ...standard.documents,
    "11111111-1111-4111-8111-111111111111": {
      ...standard.documents["11111111-1111-4111-8111-111111111111"],
      datasets: [
        {
          ...standard.documents["11111111-1111-4111-8111-111111111111"]
            .datasets[0],
          records: standard.documents[
            "11111111-1111-4111-8111-111111111111"
          ].datasets[0]!.records.map((record) => ({
            ...record,
            values: {
              ...record.values,
              title: {
                kind: "text",
                text: "Community celebration and annual volunteer recognition evening with families and friends",
              },
            },
          })),
        },
      ],
    },
  },
});

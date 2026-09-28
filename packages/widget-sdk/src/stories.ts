/**
 * Story helpers for Widget modules. A story is a fixture rendered in a
 * fixed frame through renderFixture(), the same path the tests take, so a
 * story can never use a Storybook-only Widget API. The visual-regression
 * suite loads these stories at their frame size.
 */
import type { AnyWidgetDefinition } from "./definition.ts";
import {
  FIXTURE_FRAMES,
  renderFixture,
  type FixtureFrame,
} from "./fixtures.ts";
import { widgetFixtureSchema, type WidgetManifestInput } from "./manifest.ts";

export interface WidgetStory {
  name: string;
  render: () => HTMLElement;
  parameters: { tilecastFrame: { width: number; height: number } };
}

/** One story: `fixture` rendered in `frame`. */
export function widgetStory(
  definition: AnyWidgetDefinition,
  manifest: WidgetManifestInput,
  fixture: unknown,
  frame: FixtureFrame,
): WidgetStory {
  const parsed = widgetFixtureSchema.parse(fixture);
  const size = FIXTURE_FRAMES[frame];
  return {
    name: `${parsed.name} · ${size.label}`,
    parameters: { tilecastFrame: { width: size.width, height: size.height } },
    render() {
      const container = document.createElement("div");
      container.className = "tc-story-frame";
      container.dataset["frame"] = frame;
      container.style.setProperty("width", `${size.width}px`);
      container.style.setProperty("height", `${size.height}px`);
      renderFixture({ definition, manifest, fixture: parsed, container });
      return container;
    },
  };
}

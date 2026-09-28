/**
 * Render a Widget fixture exactly as a host would: compile the persisted
 * configuration with the manifest's configTemplate, build a deterministic
 * context on a manual clock, grant the fixture's resources and mount with
 * WidgetMount. Storybook, the Playwright visual suite and the Widget tests
 * all use this, so none of them has a private Widget API.
 */
import { resolveTheme, TILECAST_DISPLAY_THEME } from "./context.ts";
import type { AnyWidgetDefinition } from "./definition.ts";
import { WidgetRegistry } from "./definition.ts";
import {
  compileComponentConfig,
  type WidgetFixture,
  type WidgetManifestInput,
} from "./manifest.ts";
import { WidgetMount, type WidgetMountState } from "./mount.ts";
import type { WidgetDataDocument } from "./resources.ts";
import {
  createManualClock,
  createTestContext,
  FIXTURE_NOW,
  fixtureResources,
  type ManualWidgetClock,
} from "./testing.ts";

/** Container sizes every V2 Widget is reviewed and regression-tested at. */
export const FIXTURE_FRAMES = {
  landscape: { width: 1920, height: 1080, label: "1920×1080 landscape" },
  portrait: { width: 1080, height: 1920, label: "1080×1920 portrait" },
  quarter: { width: 960, height: 540, label: "960×540" },
  strip: { width: 1920, height: 200, label: "Wide strip" },
  sidebar: { width: 480, height: 1080, label: "Tall sidebar" },
  zone: { width: 420, height: 260, label: "Small Layout zone" },
} as const;

export type FixtureFrame = keyof typeof FIXTURE_FRAMES;

export interface RenderedFixture {
  readonly mount: WidgetMount;
  readonly clock: ManualWidgetClock;
  readonly state: () => WidgetMountState;
  dispose(): void;
}

export function renderFixture(options: {
  definition: AnyWidgetDefinition;
  manifest: WidgetManifestInput;
  fixture: WidgetFixture;
  container: HTMLElement;
  registry?: WidgetRegistry;
  mode?: "playback" | "preview";
  /**
   * The configTemplate of a compatibility provider the fixture names;
   * defaults to the module's own template.
   */
  configTemplate?: Readonly<Record<string, unknown>>;
}): RenderedFixture {
  const { definition, manifest, fixture, container } = options;
  const context = fixture.context ?? {};
  const clock = createManualClock(
    context.now ? Date.parse(context.now) : FIXTURE_NOW,
  );
  const config = compileComponentConfig(
    options.configTemplate ?? manifest.component.configTemplate,
    fixture.configuration,
  );
  let state: WidgetMountState = { state: "pending" };
  const mount = new WidgetMount({
    registry: options.registry ?? new WidgetRegistry([definition]),
    container,
    component: {
      type: definition.type,
      version: definition.version,
      config,
    },
    resources: fixtureResources({
      documents: fixture.documents as
        Record<string, WidgetDataDocument> | undefined,
      media: fixture.media,
    }),
    context: createTestContext({
      clock,
      locale: context.locale,
      timeZone: context.timeZone,
      hourCycle: context.hourCycle,
      reducedMotion: context.reducedMotion ?? true,
      theme: context.theme
        ? resolveTheme(context.theme, TILECAST_DISPLAY_THEME)
        : TILECAST_DISPLAY_THEME,
      mode: options.mode ?? "preview",
    }),
    onState: (next) => {
      state = next;
    },
  });
  return {
    mount,
    clock,
    state: () => state,
    dispose: () => mount.dispose(),
  };
}

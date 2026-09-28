/// <reference types="vite/client" />
/**
 * The Player Runtime's side of Widgets V2 (docs/widgets-v2.md).
 *
 * The runtime finds every Widget module below widgets/ when it is built,
 * builds each Widget's context (the corrected clock, regional formatting,
 * theme, motion and mode) and mounts it with the shared WidgetMount. Every
 * Widget renders the same way whether it is fullscreen or in a Layout
 * zone; only its container differs. The runtime, not the Widget, turns the
 * mount's state into playback evidence (surfaces/widget-surface.ts,
 * surfaces/layout-surface.ts).
 *
 * There is no Widget switch here: adding a Widget adds a directory.
 */
import {
  createWidgetResources,
  TILECAST_DISPLAY_THEME,
  type WidgetClock,
  type WidgetContext,
  type WidgetDataDocument,
  type WidgetRegistry,
} from "@tilecast/widget-sdk";
import {
  discoverSourcedWidgets,
  pairSourcedEntries,
  pluginIdResolver,
  type PluginManifestRef,
  type WidgetDiscovery,
} from "@tilecast/widget-sdk/discovery";
import type { WidgetManifestInput } from "@tilecast/widget-sdk/manifest";
import { WidgetMount, type WidgetMountState } from "@tilecast/widget-sdk/mount";
import type { RuntimeClock } from "../clock/scheduler";
import type { RuntimeWidgetComponentPayload } from "../host/contract";

// Stable plugin identities from each plugin's tilecast.plugin.json. The
// plugin directory is a filesystem location, never identity.
const resolvePluginId = pluginIdResolver(
  import.meta.glob<PluginManifestRef>(
    "../../../../plugins/*/tilecast.plugin.json",
    { eager: true, import: "default" },
  ),
);

export const widgetDiscovery: WidgetDiscovery = discoverSourcedWidgets(
  pairSourcedEntries(
    import.meta.glob<WidgetManifestInput>(
      "../../../../widgets/*/tilecast.widget.json",
      { eager: true, import: "default" },
    ),
    import.meta.glob<{ default?: unknown }>(
      "../../../../widgets/*/runtime/index.ts",
      { eager: true },
    ),
  ).concat(
    pairSourcedEntries(
      import.meta.glob<WidgetManifestInput>(
        "../../../../plugins/*/widgets/*/tilecast.widget.json",
        { eager: true, import: "default" },
      ),
      import.meta.glob<{ default?: unknown }>(
        "../../../../plugins/*/widgets/*/runtime/index.ts",
        { eager: true },
      ),
      resolvePluginId,
    ),
  ),
);

export interface RuntimeWidgetHostOptions {
  clock: RuntimeClock;
  registry?: WidgetRegistry;
  /** 0 in snapshot conformance runs. */
  animationScale: number;
  reducedMotion(): boolean;
}

export class RuntimeWidgetHost {
  readonly registry: WidgetRegistry;
  private offsetMs = 0;
  private readonly clock: WidgetClock;

  constructor(private readonly options: RuntimeWidgetHostOptions) {
    this.registry = options.registry ?? widgetDiscovery.registry;
    const clock = options.clock;
    this.clock = Object.freeze({
      now: () => clock.wallNow() + this.offsetMs,
      monotonicNow: () => clock.monotonicNow(),
      after: (delayMs: number, run: () => void) =>
        clock.at(clock.monotonicNow() + Math.max(0, delayMs), run),
    });
  }

  /**
   * The host's latest corrected-minus-local offset. Widgets read it on every
   * `now()`, so a new estimate moves their time without remounting them.
   */
  setClockOffset(offsetMs: number | undefined): void {
    if (typeof offsetMs === "number" && Number.isFinite(offsetMs)) {
      this.offsetMs = offsetMs;
    }
  }

  /** `widget.<type>` → version for every bundled Widget. */
  capabilities(): Record<string, number> {
    return this.registry.capabilities();
  }

  context(payload: RuntimeWidgetComponentPayload): WidgetContext {
    const { regional } = payload;
    return Object.freeze({
      clock: this.clock,
      locale: regional.locale,
      timeZone: regional.timeZone,
      hourCycle: regional.hourCycle,
      theme: TILECAST_DISPLAY_THEME,
      motion: Object.freeze({
        reduced:
          this.options.animationScale === 0 || this.options.reducedMotion(),
      }),
      mode: "playback" as const,
    });
  }

  /** Mount a projected component into `container`. */
  mount(
    container: HTMLElement,
    payload: RuntimeWidgetComponentPayload,
    onState: (state: WidgetMountState) => void,
  ): WidgetMount {
    const { component } = payload;
    return new WidgetMount({
      registry: this.registry,
      container,
      component: {
        type: component.type,
        version: component.version,
        config: component.config,
      },
      resources: createWidgetResources(
        {
          documents: new Map(
            Object.entries(payload.documents) as [string, WidgetDataDocument][],
          ),
          media: new Map(Object.entries(payload.media)),
        },
        { dataSources: component.dataSources, media: component.media },
      ),
      context: this.context(payload),
      onState,
      // The runtime's CSP refuses <style> elements, so a Widget whose styles
      // cannot be adopted fails visibly instead of rendering unstyled.
      requireAdoptedStyleSheets: true,
    });
  }
}

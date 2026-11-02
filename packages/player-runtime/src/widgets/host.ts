/// <reference types="vite/client" />
/**
 * The Player Runtime's side of Widgets V2 (docs/widgets-v2.md).
 *
 * The runtime finds every Widget module below widgets/ when it is built,
 * builds each Widget's context (the corrected clock, regional formatting,
 * theme, motion and mode) and mounts it with the shared Widget executors:
 * bundled Widgets mount trusted, package-contributed Widgets run in a
 * sandboxed frame. Every Widget renders the same way whether it is
 * fullscreen or in a Layout zone; only its container differs. The runtime,
 * not the Widget, turns the mount's state into playback evidence
 * (surfaces/widget-surface.ts, surfaces/layout-surface.ts).
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
import type { WidgetMountState } from "@tilecast/widget-sdk/mount";
import {
  TrustedWidgetExecutor,
  type WidgetExecution,
} from "@tilecast/widget-sdk/executor";
import { SandboxedWidgetExecutor } from "@tilecast/widget-sdk/sandboxed-executor";
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
  /**
   * Where a served frame's sandbox comes from. `response` navigates
   * bare and takes the sandbox from the response `sandbox` directive,
   * for hosts whose serving layer only sees bare navigations (a
   * browser service worker never sees a sandboxed iframe's
   * navigation). Absent means `attribute`.
   */
  externalFrameSandbox?: "attribute" | "response";
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

  /**
   * Mount a projected component into `container`. The payload's
   * `execution` descriptor selects the executor: sandboxed for
   * package-contributed Widgets, trusted for bundled ones. The host
   * never inspects the component type to decide.
   */
  mount(
    container: HTMLElement,
    payload: RuntimeWidgetComponentPayload,
    onState: (state: WidgetMountState) => void,
  ): WidgetExecution {
    const { component } = payload;
    const request = {
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
    };
    if (payload.execution?.kind === "sandboxed") {
      // The Server compiled these grants from the Widget manifest, so
      // the granted names are the declaration the frame filters by.
      return new SandboxedWidgetExecutor().mount(container, {
        ...request,
        declared: {
          dataSources: component.dataSources,
          media: component.media,
        },
        embedding: "hosted",
        frameUrl: payload.execution.frameUrl,
        frameSandbox: this.options.externalFrameSandbox ?? "attribute",
      });
    }
    return new TrustedWidgetExecutor({
      registry: this.registry,
      // The runtime's CSP refuses <style> elements, so a Widget whose styles
      // cannot be adopted fails visibly instead of rendering unstyled.
      requireAdoptedStyleSheets: true,
    }).mount(container, request);
  }
}

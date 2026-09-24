/**
 * The contract for first-class Tilecast widgets.
 *
 * Today's widgets are server-compiled into the RenderNode tree and drawn by the
 * compatibility interpreter (src/compat). That model is preserved for existing
 * content but is not the future widget API. A future widget is a custom
 * element, normally a Lit component, that receives typed inputs and renders
 * directly with HTML, CSS, SVG or Canvas as appropriate.
 *
 * A widget component must stay engine-agnostic: it runs unchanged in the
 * Electron/Chromium host, the WPE/WebKit host and Tilecast Studio's preview.
 * So it may not:
 *
 * - read `globalThis.tilecastRuntimeHost`, host capabilities or host names;
 * - fetch, open sockets, read storage, or address media except through the
 *   URIs in its data and context;
 * - schedule its own playback advancement, or keep time with anything but
 *   `context.clock` (so a Studio preview and a synchronized group agree);
 * - report playback evidence itself (it signals `ready`/`error`; the runtime
 *   turns that into evidence).
 *
 * The widget redesign itself is not part of Edge 1; this file only fixes the
 * seam so it can land without changing the playback engine or any host.
 */

/** Corrected time for widgets: server-offset wall time and a monotonic clock. */
export interface WidgetClock {
  /** Corrected (server) Unix milliseconds. */
  now(): number;
  /** Monotonic milliseconds for animation and elapsed time. */
  monotonicNow(): number;
}

export interface WidgetEnvironment {
  /** BCP 47 locale for formatting. */
  locale: string;
  /** IANA time zone of the screen's organization. */
  timeZone: string;
  /** Rendered size of the widget's box, in CSS pixels. */
  width: number;
  height: number;
}

export interface WidgetContext {
  clock: WidgetClock;
  environment: WidgetEnvironment;
  /** Where the widget is shown: on a screen, or in a Studio preview. */
  mode: "playback" | "preview";
}

/**
 * What a widget definition declares. `Config` is authored in Studio; `Data`
 * is resolved server-side (data sources, media URIs) and delivered with it.
 */
export interface WidgetDefinition<Config, Data> {
  /** Stable identifier, e.g. "tilecast.clock". */
  readonly type: string;
  /** Schema version of `Config`; bumped on incompatible changes. */
  readonly version: number;
  /** Custom element tag name the component registers. */
  readonly tagName: string;
  /** Validate untrusted configuration before it reaches the element. */
  parseConfig(value: unknown): Config | null;
  parseData(value: unknown): Data | null;
}

/** Properties every widget element accepts. */
export interface WidgetElementInputs<Config, Data> {
  config: Config;
  data: Data;
  context: WidgetContext;
}

/** Events a widget element dispatches (bubbling, composed). */
export interface WidgetElementEvents {
  /** The widget has painted meaningful content for its current inputs. */
  "tilecast-widget-ready": CustomEvent<void>;
  /** The widget cannot render its current inputs. */
  "tilecast-widget-error": CustomEvent<{ message: string }>;
}

export type AnyWidgetDefinition = WidgetDefinition<unknown, unknown>;

/**
 * The runtime's registry of first-class widgets. It is empty in Edge 1:
 * every existing widget still renders through the compatibility interpreter.
 */
export class WidgetRegistry {
  private readonly definitions = new Map<string, AnyWidgetDefinition>();

  register(definition: AnyWidgetDefinition): void {
    if (this.definitions.has(definition.type)) {
      throw new Error(`widget ${definition.type} is already registered`);
    }
    if (!/^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(definition.tagName)) {
      throw new Error(`widget ${definition.type} has an invalid tag name`);
    }
    this.definitions.set(definition.type, definition);
  }

  lookup(type: string): AnyWidgetDefinition | null {
    return this.definitions.get(type) ?? null;
  }

  get size(): number {
    return this.definitions.size;
  }
}

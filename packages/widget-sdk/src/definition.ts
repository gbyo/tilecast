/**
 * defineWidget(): the one contribution a Widget module makes.
 *
 * A Widget module's `runtime/index.ts` default-exports a definition. The
 * Player Runtime and Studio discover it when they are built; nothing is
 * downloaded or registered at run time. Built-in Widgets use exactly the
 * API a future plugin-contributed Widget would use.
 */
import type { WidgetContext } from "./context.ts";
import { identityProblem } from "./identity.ts";
import type { WidgetResolution, WidgetResources } from "./resources.ts";

export type ConfigResult<Config> =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly problem: string };

/**
 * Properties every Widget element accepts. The mount assigns them as
 * object properties, never as attributes.
 */
export interface WidgetElementInputs<Config, Data> {
  config: Config;
  /** Resolved data when the resolution is ready, otherwise null. */
  data: Data | null;
  /** The empty reason when the resolution is empty, otherwise null. */
  empty: string | null;
  context: WidgetContext;
}

export type WidgetElement<Config, Data> = HTMLElement &
  WidgetElementInputs<Config, Data>;

export type WidgetElementConstructor<Config, Data> = new () => WidgetElement<
  Config,
  Data
>;

export interface WidgetDefinition<Config, Data> {
  /** Qualified component type, for example "tilecast.clock". */
  readonly type: string;
  /** Component version; must equal tilecast.widget.json component.version. */
  readonly version: number;
  /** Custom-element tag the mount defines the element under. */
  readonly tagName: string;
  /**
   * Validate untrusted configuration. Must not throw. `version` is the
   * component version the Server compiled the configuration for; a
   * definition at version N accepts the configuration of every version from
   * 1 to N, because a Player reports the newest version it renders.
   */
  parseConfig(value: unknown, version: number): ConfigResult<Config>;
  /**
   * Read prepared resources only. Pure and synchronous: it may not fetch,
   * schedule or read the clock. Time-aware choices belong to the element.
   */
  resolveData(
    config: Config,
    resources: WidgetResources,
  ): WidgetResolution<Data>;
  readonly element: WidgetElementConstructor<Config, Data>;
}

// Definitions are stored heterogeneously; the mount only ever pairs a
// definition's own parseConfig output with its own resolveData and element.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyWidgetDefinition = WidgetDefinition<any, any>;

/** Identity helper that type-checks and freezes a Widget definition. */
export function defineWidget<Config, Data>(
  definition: WidgetDefinition<Config, Data>,
): WidgetDefinition<Config, Data> {
  return Object.freeze({ ...definition });
}

/**
 * Why a definition is unusable, or null. Discovery calls this rather than
 * defineWidget() throwing, because a throw while the runtime bundle loads
 * would take the whole display down with it.
 */
export function definitionProblem(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return "runtime/index.ts must default-export defineWidget(...)";
  }
  const definition = value as Partial<AnyWidgetDefinition>;
  const identity = identityProblem({
    type: definition.type,
    version: definition.version,
    tagName: definition.tagName,
  });
  if (identity) return identity;
  if (typeof definition.parseConfig !== "function") {
    return "definition lacks parseConfig()";
  }
  if (typeof definition.resolveData !== "function") {
    return "definition lacks resolveData()";
  }
  if (typeof definition.element !== "function") {
    return "definition lacks an element class";
  }
  return null;
}

/** Look up definitions by component type. */
export class WidgetRegistry {
  private readonly byType = new Map<string, AnyWidgetDefinition>();

  constructor(definitions: Iterable<AnyWidgetDefinition> = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: AnyWidgetDefinition): void {
    const problem = definitionProblem(definition);
    if (problem) throw new Error(`widget ${definition.type}: ${problem}`);
    if (this.byType.has(definition.type)) {
      throw new Error(`widget ${definition.type} is already registered`);
    }
    for (const other of this.byType.values()) {
      if (other.tagName === definition.tagName) {
        throw new Error(
          `widget ${definition.type} reuses tag ${definition.tagName}`,
        );
      }
    }
    this.byType.set(definition.type, definition);
  }

  /**
   * The definition that renders `type` at `version`, or null. A definition
   * renders its own version and every earlier one.
   */
  lookup(type: string, version: number): AnyWidgetDefinition | null {
    const definition = this.byType.get(type);
    return definition &&
      Number.isInteger(version) &&
      version >= 1 &&
      version <= definition.version
      ? definition
      : null;
  }

  /** `widget.<type>` → version for every registered Widget, sorted. */
  capabilities(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const type of [...this.byType.keys()].sort()) {
      out[`widget.${type}`] = this.byType.get(type)!.version;
    }
    return out;
  }

  get size(): number {
    return this.byType.size;
  }
}

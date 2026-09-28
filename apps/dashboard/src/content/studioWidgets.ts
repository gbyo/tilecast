/// <reference types="vite/client" />
/**
 * Studio's side of Widgets V2 discovery (docs/widgets-v2.md, PR 2).
 *
 * The same trusted source set the Player Runtime builds in — the root
 * widgets directory and each plugin widgets directory — is discovered here
 * through the same source-aware mechanism, with ownership passed
 * structurally from each path. There is deliberately no plugin-specific
 * preview code: every migrated Widget renders through `WidgetPreviewHost`
 * below, which mounts the real Web Component from this registry.
 */
import type { AnyWidgetDefinition } from "@tilecast/widget-sdk";
import {
  discoverSourcedWidgets,
  pairSourcedEntries,
  pluginIdResolver,
  type PluginManifestRef,
  type WidgetDiscovery,
} from "@tilecast/widget-sdk/discovery";
import type { WidgetManifestInput } from "@tilecast/widget-sdk/manifest";
import type { ContentDefinitionCatalog, WidgetDefinition } from "../api/types";

const coreManifests = import.meta.glob<WidgetManifestInput>(
  "../../../../widgets/*/tilecast.widget.json",
  { eager: true, import: "default" },
);
const coreModules = import.meta.glob<{ default?: unknown }>(
  "../../../../widgets/*/runtime/index.ts",
  { eager: true },
);
const pluginManifests = import.meta.glob<WidgetManifestInput>(
  "../../../../plugins/*/widgets/*/tilecast.widget.json",
  { eager: true, import: "default" },
);
const pluginModules = import.meta.glob<{ default?: unknown }>(
  "../../../../plugins/*/widgets/*/runtime/index.ts",
  { eager: true },
);
// Stable plugin identities from each plugin's tilecast.plugin.json. The
// plugin directory is a filesystem location, never identity.
const resolvePluginId = pluginIdResolver(
  import.meta.glob<PluginManifestRef>(
    "../../../../plugins/*/tilecast.plugin.json",
    { eager: true, import: "default" },
  ),
);

export const studioWidgetDiscovery: WidgetDiscovery = discoverSourcedWidgets(
  pairSourcedEntries(coreManifests, coreModules).concat(
    pairSourcedEntries(pluginManifests, pluginModules, resolvePluginId),
  ),
);

/** A migrated Widget's component as Studio renders it. */
export interface StudioWidgetComponent {
  readonly definition: AnyWidgetDefinition;
  readonly type: string;
  readonly version: number;
  readonly configTemplate: Record<string, unknown>;
  readonly dataSourceFields: readonly string[];
}

/**
 * Resolve a catalog Widget to its real component. Returns null when the
 * provider is not a migrated V2 Widget or its bundled runtime module is
 * not part of this Studio build; callers keep their legacy preview then.
 */
export function studioWidgetComponent(
  catalog: ContentDefinitionCatalog | undefined | null,
  provider: string,
): StudioWidgetComponent | null {
  const entry = catalog?.widgets.find(
    (candidate: WidgetDefinition) => candidate.id === provider,
  );
  const component = entry?.component;
  if (!component) return null;
  const definition = studioWidgetDiscovery.registry.lookup(
    component.type,
    component.version,
  );
  if (!definition) return null;
  return {
    definition,
    type: component.type,
    version: component.version,
    configTemplate: component.configTemplate ?? {},
    dataSourceFields: component.dataSourceFields ?? [],
  };
}

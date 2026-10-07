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

/** An external Widget as Studio previews it: sandboxed, never imported. */
export interface StudioSandboxWidget {
  readonly type: string;
  readonly version: number;
  readonly configTemplate: Record<string, unknown>;
  readonly dataSourceFields: readonly string[];
  /** Same-origin frame document; the Server interpolates verified bytes. */
  readonly frameUrl: string;
}

/** Either previewable component: trusted in-document, or sandboxed. */
export type StudioPreviewComponent =
  | { readonly kind: "trusted"; readonly component: StudioWidgetComponent }
  | { readonly kind: "sandbox"; readonly sandbox: StudioSandboxWidget };

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

/**
 * Resolve a catalog Widget to either previewable component. Trusted
 * source-built Widgets keep their in-document mount; package-source
 * Widgets preview through the sandbox executor behind a Server-built
 * frame document. Returns null when the provider has no component
 * contract or its package identity does not qualify the catalog ID;
 * callers keep their legacy preview then. The Server revalidates the
 * identity before serving any bytes.
 */
export function studioPreviewComponent(
  catalog: ContentDefinitionCatalog | undefined | null,
  provider: string,
): StudioPreviewComponent | null {
  const trusted = studioWidgetComponent(catalog, provider);
  if (trusted) return { kind: "trusted", component: trusted };
  const entry = catalog?.widgets.find(
    (candidate: WidgetDefinition) => candidate.id === provider,
  );
  const component = entry?.component;
  const source = entry?.source;
  if (!component || source?.kind !== "package") return null;
  const prefix = `${source.packageId}.`;
  if (!provider.startsWith(prefix)) return null;
  const nestedId = provider.slice(prefix.length);
  if (nestedId.length === 0) return null;
  return {
    kind: "sandbox",
    sandbox: {
      type: component.type,
      version: component.version,
      configTemplate: component.configTemplate ?? {},
      dataSourceFields: component.dataSourceFields ?? [],
      frameUrl: `/api/v1/packages/${encodeURIComponent(source.packageId)}/widgets/${encodeURIComponent(nestedId)}/frame`,
    },
  };
}

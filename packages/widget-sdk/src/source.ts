/**
 * Extension source and provenance (docs/content-extension-model.md §4).
 *
 * The source of an extension is orthogonal to what the extension is: a
 * Widget is a Widget whether it ships in Tilecast, is owned by a bundled
 * plugin, or comes from an installed external package. Source metadata is used
 * for availability, collision diagnostics, Studio provenance, support
 * bundles, audit, updates, backup/restore, and package trust. It never
 * changes the Widget contract: there are no CoreWidget/PluginWidget runtime
 * types.
 */

export type ExtensionSource =
  | { readonly kind: "core" }
  | { readonly kind: "plugin"; readonly pluginId: string }
  | {
      readonly kind: "package";
      readonly packageId: string;
      readonly packageVersion: string;
      readonly digest: string;
    };

/** Plugin IDs that may own bundled Widgets. */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;

/** Package identities are qualified like component types. */
export const PACKAGE_ID_PATTERN =
  /^[a-z][a-z0-9]{1,31}(\.[a-z][a-z0-9-]{0,47})+$/;

/** Why a source descriptor is invalid, or null. */
export function sourceProblem(value: unknown): string | null {
  if (!value || typeof value !== "object") return "source must be an object";
  const source = value as Partial<ExtensionSource> & Record<string, unknown>;
  if (source.kind === "core") return null;
  if (source.kind === "plugin") {
    if (
      typeof source.pluginId !== "string" ||
      !PLUGIN_ID_PATTERN.test(source.pluginId)
    ) {
      return `plugin source id ${String(source.pluginId)} is invalid`;
    }
    return null;
  }
  if (source.kind === "package") {
    if (
      typeof source.packageId !== "string" ||
      !PACKAGE_ID_PATTERN.test(source.packageId)
    ) {
      return `package source id ${String(source.packageId)} is invalid`;
    }
    if (
      typeof source.packageVersion !== "string" ||
      source.packageVersion.length < 1 ||
      source.packageVersion.length > 64
    ) {
      return "package source version is invalid";
    }
    if (
      typeof source.digest !== "string" ||
      source.digest.length < 1 ||
      source.digest.length > 256
    ) {
      return "package source digest is invalid";
    }
    return null;
  }
  return `source kind ${String(source.kind)} is invalid`;
}

/**
 * A package's contributions must equal its package ID or live beneath its
 * namespace. Moving an artifact between registries never changes its ID.
 */
export function packageOwnsType(packageId: string, type: string): boolean {
  return type === packageId || type.startsWith(`${packageId}.`);
}

/** Short provenance label for Studio ("Built in", "Plugin · Athletics"). */
export function sourceLabel(source: ExtensionSource): string {
  switch (source.kind) {
    case "core":
      return "Built in";
    case "plugin":
      return `Plugin · ${source.pluginId}`;
    case "package":
      return `Custom · ${source.packageId}`;
  }
}

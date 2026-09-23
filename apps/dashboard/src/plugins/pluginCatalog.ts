import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { api, ApiError } from "../api/client";
import type { PluginInUseResource, PluginSummary } from "../api/types";

export type PluginsT = TFunction<"plugins", undefined>;

export const pluginCategories = [
  "Display",
  "Automation",
  "Workflow",
  "Hardware",
] as const;

export type PluginStatusKey =
  | "status.attention"
  | "status.active"
  | "status.configured"
  | "status.needsSetup";

/**
 * The single status shown for an installed plugin. Attention notes are
 * advisory — a plugin may be installed before its Player exists — so a plugin
 * nobody has set up yet reads as needing setup, with the note alongside.
 * Returns a key into the plugins namespace; the caller translates at render.
 */
export function pluginStatusKey(plugin: PluginSummary): PluginStatusKey {
  if (!plugin.configured) return "status.needsSetup";
  if (plugin.attention.length > 0) return "status.attention";
  if (plugin.active) return "status.active";
  if (plugin.configured) return "status.configured";
  return "status.needsSetup";
}

export function instanceSummary(plugin: PluginSummary) {
  const noun =
    plugin.instanceCount === 1
      ? plugin.instanceNounSingular
      : plugin.instanceNounPlural;
  return `${plugin.instanceCount} ${noun}`;
}

/**
 * The requirements worth a line in the catalog list: where the plugin can run
 * at all. The detail step shows every requirement.
 */
export function headlineRequirements(plugin: PluginSummary) {
  return plugin.requirements.filter((requirement) =>
    ["platform", "hardware", "region"].includes(requirement.kind),
  );
}

/** True when this Studio bundle has a page for the server's route. */
export function hasStudioRoute(path: string) {
  return knownManagementPaths.has(path);
}

const knownManagementPaths = new Set([
  "/plugins/countdown-bar",
  "/plugins/emergency-alerts",
  "/plugins/forms",
  "/plugins/brand-bug",
  "/plugins/noise-meter",
]);

export const pluginsQueryKey = ["plugins"] as const;

export function usePluginCatalog() {
  return useQuery({ queryKey: pluginsQueryKey, queryFn: api.plugins });
}

export function usePluginLifecycle(csrfToken: string) {
  const queryClient = useQueryClient();
  const settle = () =>
    queryClient.invalidateQueries({ queryKey: pluginsQueryKey });
  const install = useMutation({
    mutationFn: (id: string) => api.installPlugin(id, csrfToken),
    onSuccess: settle,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.removePlugin(id, csrfToken),
    onSuccess: settle,
  });
  return { install, remove };
}

/** The plugin-owned resources a 409 plugin_in_use response says remain. */
export function inUseResources(error: unknown): PluginInUseResource[] | null {
  if (!(error instanceof ApiError) || error.code !== "plugin_in_use")
    return null;
  const resources = error.details?.resources;
  return Array.isArray(resources) ? (resources as PluginInUseResource[]) : [];
}

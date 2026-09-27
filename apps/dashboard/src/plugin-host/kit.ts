/**
 * `@tilecast/studio` — the Studio side of the Tilecast Plugin API v1.
 *
 * A plugin's `studio/index.tsx` default-exports `defineStudioPlugin(...)`.
 * Studio discovers it at build time (see registry.tsx); nothing central lists
 * plugins. Plugin code imports Studio only through this module, so the
 * surface below is the contract: the chrome and primitives every plugin
 * shares, and the hooks that reach the server on its behalf.
 */
import type { ComponentType } from "react";
import type { RouteObject } from "react-router";

export type PluginIconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

/** A global search destination the plugin adds, relative to its route. */
export interface StudioPluginSearchEntry {
  /** Path below the plugin's route, for example "history". Empty for the root. */
  path: string;
  label: string;
  description: string;
  keywords?: string[];
}

export interface StudioPluginDefinition {
  /** Must equal the manifest's id. */
  id: string;
  /** The plugin's icon. Studio falls back to a generic icon without one. */
  icon?: PluginIconComponent;
  /**
   * Routes below the manifest's `studio.route`. The host mounts them, adds
   * the plugin name as the breadcrumb, and wraps them in the install gate, so
   * an uninstalled plugin's page explains how to install it.
   */
  routes?: RouteObject[];
  /** Extra global search destinations. The plugin itself is always offered. */
  search?: StudioPluginSearchEntry[];
}

/** Identity helper that type-checks a plugin's Studio contribution. */
export function defineStudioPlugin<
  const Definition extends StudioPluginDefinition,
>(definition: Definition): Definition {
  return definition;
}

export { PluginPage } from "./PluginPage";
export { PluginRouteGate as PluginInstallGate } from "../plugins/PluginRouteGate";
export { PluginActionsMenu } from "../plugins/PluginActionsMenu";
export { usePluginCatalog } from "../plugins/pluginCatalog";
export { canManage } from "../plugins/shared";

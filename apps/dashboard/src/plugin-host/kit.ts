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
   *
   * A route's `handle.breadcrumb` is the English label, and
   * `handle.breadcrumbKey` names its translation in the plugin's namespace
   * (`studio/locales/<language>.json`), for example
   * `{ breadcrumb: "New instance", breadcrumbKey: "breadcrumbs.newInstance" }`.
   */
  routes?: RouteObject[];
  /**
   * Routes outside the normal `/plugins/<plugin>` management subtree, for
   * plugins that own a wider Studio surface (a submitter portal, a reviewer
   * inbox). Each entry is explicit: the host mounts it at its absolute path,
   * refuses collisions with core and other plugins' routes, and requires the
   * path to be declared in the manifest's `studio.additionalRoutes`. This is
   * not a generic router escape hatch; a plugin cannot override existing
   * Studio routes.
   */
  standaloneRoutes?: StudioPluginStandaloneRoute[];
  /** Extra global search destinations. The plugin itself is always offered. */
  search?: StudioPluginSearchEntry[];
}

/**
 * One plugin-owned Studio route outside the management subtree.
 */
export interface StudioPluginStandaloneRoute {
  /** Absolute Studio path, for example "/forms". */
  path: string;
  /**
   * Installation gating, deliberate per route. "install" wraps the route in
   * the normal plugin installation gate; "none" renders directly, for pages
   * that handle an uninstalled plugin themselves without exposing broken UI.
   */
  gate: "install" | "none";
  /**
   * Where the route mounts. Standalone routes mount inside the authenticated
   * Studio chrome by default; `topLevel` mounts as a top-level route with its
   * own shell and its own authentication, for areas intentionally outside the
   * operator sidebar.
   */
  topLevel?: boolean;
  /** The route's content below `path`, as relative child routes. */
  children: RouteObject[];
}

/** Identity helper that type-checks a plugin's Studio contribution. */
export function defineStudioPlugin<
  const Definition extends StudioPluginDefinition,
>(definition: Definition): Definition {
  return definition;
}

// Plugin chrome and lifecycle.
export { PluginPage } from "./PluginPage";
export { PluginRouteGate as PluginInstallGate } from "../plugins/PluginRouteGate";
export { PluginActionsMenu } from "../plugins/PluginActionsMenu";
export { usePluginCatalog, pluginsQueryKey } from "../plugins/pluginCatalog";

// The signed-in user, the API, and errors.
export { useStudioSession, type StudioSession } from "./session";
export { request as studioRequest, ApiError } from "../api/client";
export { apiErrorMessage, useFormatLocale } from "../i18n";
export {
  usePluginTranslation,
  type LocaleKey,
  type PluginT,
} from "./translation";
export type { BreadcrumbResourceLoader } from "../navigation/studioRoutes";

// Shared form and targeting primitives. Targeting is a property of Tilecast,
// not of one plugin, so every plugin uses the same scopes and picker.
export {
  RegisterCheckbox,
  TargetFields,
  targetScopeLabel,
  toLocalInputValue,
  useTargetSource,
  weekdayShortLabel,
  type TargetScope,
  type TargetSource,
} from "../plugins/shared";
export type { PluginTargetScope, PluginTargeting } from "../api/types";
export type { VariantProps } from "class-variance-authority";
export { FormField } from "../components/FormField";
export {
  localDateTimeToRfc3339,
  rfc3339ToLocalDateTime,
} from "../lib/dateTime";
export { Pagination } from "../components/Pagination";
export { Brand } from "../components/Brand";
export { useDesktopLayout } from "../hooks/use-desktop-layout";
export { DateInput, DateTimeInput } from "../components/date-picker";
export { useConfirm } from "../components/ConfirmDialog";
export { toast } from "../components/ui/toast";
export { scheduleWeekdays } from "../schedules/scheduleBuilderModel";
export { useOrganizationRegionalProfile } from "../settings/regionalProfile";

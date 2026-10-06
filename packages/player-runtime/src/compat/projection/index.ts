/**
 * COMPATIBILITY CODE. Server-compiled Widget and Layout projection into the
 * RenderNode tree (render-tree.ts), shared unchanged by every host.
 *
 * This is the current widget system, preserved so that Electron and WPE show
 * the same thing. It is deliberately not the permanent widget API of the
 * Player Runtime: Widgets V2 are first-class components
 * (docs/widgets-v2.md) that receive typed configuration, data and context
 * and render directly; projectWidgetComponent() projects them. Do not
 * extend the RenderNode vocabulary for new widget work; do not add
 * host-specific branches here.
 *
 * Hosts that project in Node (the Electron main process) import this entry;
 * the runtime projects references itself when a host sends a projection
 * context instead of trees.
 */
export * from "./types";
export * from "./content-types";
export * from "./render-tree";
export { projectManifestItems, type ItemProjectionDefaults } from "./items";
export {
  brandingLogoUri,
  layoutIdFromItemId,
  layoutItemId,
  planPresentation,
  realizePresentation,
  statusSurface,
  type CompatibilityFailure,
  type ConfigurationSections,
  type MediaBinding,
  type MediaRequirement,
  type PresentationPlan,
  type PresentationSelection,
  type ResolveInput,
  type ResolvedKind,
  type ResolvedPresentation,
  type SelectionFacts,
  type StatusKind,
  type StatusOverrides,
} from "./resolve";
export { renderLayout, spanViewport } from "./layout-render";
export { renderWidget } from "./widget-render";
export { isRemoteWebWidget, remoteWebForWidget } from "./web-widget";
export {
  COMPONENT_PRESENTATION_SCHEMA,
  isComponentWidget,
  projectWidgetComponent,
  type ComponentProjectionContext,
} from "../../widgets/projection";
export { resolveRegionalFormatting } from "./format";
export {
  fallbackDurationMsFor,
  resolvePlaybackItemSettings,
} from "./playback-defaults";
export {
  isAvailableAt,
  nextAvailabilityTransition,
  type AvailabilityWindow,
} from "./content-availability";

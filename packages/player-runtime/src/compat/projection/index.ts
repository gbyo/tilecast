/**
 * COMPATIBILITY CODE. Server-compiled Widget and Layout projection into the
 * RenderNode tree (render-tree.ts), shared unchanged by every host.
 *
 * This is the current widget system, preserved so that Electron and WPE show
 * the same thing. It is deliberately not the permanent widget API of the
 * Player Runtime: future widgets are first-class components (see
 * src/widgets/contract.ts) that receive typed configuration, data and context
 * and render directly. Do not extend the RenderNode vocabulary for new widget
 * work; do not add host-specific branches here.
 *
 * Hosts that project in Node (the Electron main process) import this entry;
 * the runtime projects references itself when a host sends a projection
 * context instead of trees.
 */
export * from "./types";
export * from "./content-types";
export * from "./render-tree";
export { renderLayout, spanViewport } from "./layout-render";
export { renderWidget } from "./widget-render";
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

/**
 * @tilecast/widget-kit — the signage visual system for Widgets V2.
 *
 * It knows nothing about Player hosts, Studio, Electron, WPE, Android or
 * server APIs: only the Widget context from @tilecast/widget-sdk.
 * Primitives are added when a real Widget needs them (docs/widgets-v2.md).
 */
export { TilecastWidgetElement } from "./base.ts";
export {
  ClockController,
  type ClockControllerOptions,
  type ClockGranularity,
} from "./controllers/clock.ts";
export { GeometryController, type WidgetSize } from "./controllers/geometry.ts";
export {
  MOTION_DURATIONS,
  MOTION_EASING,
  MotionController,
} from "./controllers/motion.ts";
export {
  boundText,
  formatDate,
  formatNumber,
  formatWidgetValue,
  type DisplayValueOptions,
  localDayKey,
  timeParts,
  zoneAbbreviation,
  zoneCity,
  type DateStyle,
  type HourCycle,
  type NumberOptions,
  type TimeParts,
} from "./format.ts";
export {
  badge,
  emptyState,
  statusStyles,
  unavailableState,
  type Tone,
} from "./templates.ts";
export {
  displayTokens,
  hostStyles,
  mixColors,
  surfaceStyles,
  themeProperties,
} from "./tokens.ts";

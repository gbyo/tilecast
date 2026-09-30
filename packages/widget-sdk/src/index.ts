/**
 * @tilecast/widget-sdk — the Widgets V2 contract. See docs/widgets-v2.md.
 *
 * This entry is what a Widget module imports. Hosts additionally import
 * `./mount` and `./discovery`; tests and stories import `./testing`.
 */
export {
  defineWidget,
  definitionProblem,
  WidgetRegistry,
  type AnyWidgetDefinition,
  type ConfigResult,
  type WidgetDefinition,
  type WidgetElement,
  type WidgetElementConstructor,
  type WidgetElementInputs,
} from "./definition.ts";
export {
  luminance,
  parseHexColor,
  resolveTheme,
  TILECAST_DISPLAY_THEME,
  validLocale,
  validTimeZone,
  type ThemeScheme,
  type WidgetClock,
  type WidgetContext,
  type WidgetTheme,
  type WidgetTimer,
} from "./context.ts";
export {
  createWidgetResources,
  empty,
  failure,
  firstRecordsDataset,
  ready,
  type ResourceGrant,
  type ResourceTables,
  type WidgetCacheState,
  type WidgetDateSelection,
  type WidgetDataDocument,
  type WidgetDataset,
  type WidgetField,
  type WidgetMediaRef,
  type WidgetPoint,
  type WidgetRecord,
  type WidgetResolution,
  type WidgetResources,
  type WidgetValue,
} from "./resources.ts";
export {
  announceEmpty,
  announceError,
  announceReady,
  WIDGET_EMPTY_EVENT,
  WIDGET_ERROR_EVENT,
  WIDGET_READY_EVENT,
  type WidgetElementEventMap,
  type WidgetEmptyDetail,
  type WidgetErrorDetail,
} from "./events.ts";
export {
  boundedCode,
  componentCapability,
  COMPONENT_TYPE_PATTERN,
  identityProblem,
  MAX_COMPONENT_CAPABILITY_LENGTH,
  MAX_COMPONENT_TYPE_LENGTH,
  MAX_COMPONENT_VERSION,
  TAG_NAME_PATTERN,
} from "./identity.ts";
export {
  packageOwnsType,
  sourceLabel,
  sourceProblem,
  type ExtensionSource,
} from "./source.ts";
export {
  AUTHORING_SECTIONS,
  authoringUiOf,
  groupAuthoringFields,
  visibleAuthoringFields,
  type AuthoringField,
  type WidgetAuthoringSection,
  type WidgetAuthoringUi,
  type WidgetVisibleWhen,
} from "./authoring.ts";

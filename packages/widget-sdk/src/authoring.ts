/**
 * Config-authoring metadata for Widget definitions
 * (docs/widget-authoring.md).
 *
 * The vocabulary moved to @tilecast/config-schema, which Widgets and
 * Plugin Manifest API 3 plugins share. These names stay so existing Widgets
 * and Studio code keep their imports.
 */
export {
  AUTHORING_SECTIONS,
  authoringUiOf,
  groupAuthoringFields,
  visibleAuthoringFields,
  type AuthoringField,
  type AuthoringSection as WidgetAuthoringSection,
  type AuthoringUi as WidgetAuthoringUi,
  type VisibleWhen as WidgetVisibleWhen,
} from "@tilecast/config-schema";

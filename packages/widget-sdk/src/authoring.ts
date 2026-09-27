/**
 * Config-authoring metadata for V2 Widget manifests
 * (docs/widgets-v2-authoring-and-first-wave.md).
 *
 * The manifest's `configurationSchema` fields may carry a small `ui` object
 * with the hints the generic Studio inspector needs: which section a
 * control belongs to, its order, when it is visible, whether a select
 * renders as visual style cards, and which semantic field it suggests.
 * Everything else (control type, label, help text, compatible Data Source
 * kinds) already lives on the field itself. Studio renders one generic
 * inspector from this metadata; Widgets never get one-off React editors.
 */

export type WidgetAuthoringSection =
  | "data"
  | "content"
  | "appearance"
  | "behavior";

/** The canonical inspector order. Sections without controls are hidden. */
export const AUTHORING_SECTIONS: readonly WidgetAuthoringSection[] = [
  "data",
  "content",
  "appearance",
  "behavior",
];

/** Show a control only when another configuration value matches. */
export interface WidgetVisibleWhen {
  /** The other configuration key to compare. */
  readonly key: string;
  /** Visible when the value equals this (or any of these). */
  readonly equals?: unknown;
  /** Visible when the value differs from this (and all of these). */
  readonly notEquals?: unknown;
}

export interface WidgetAuthoringUi {
  readonly section?: WidgetAuthoringSection;
  readonly order?: number;
  readonly visibleWhen?: WidgetVisibleWhen;
  /** Render a select's options as visual cards instead of a dropdown. */
  readonly styleCard?: boolean;
  /** The semantic field role this control suggests, if any. */
  readonly semanticRole?: string;
}

/** A configuration-schema field with optional authoring hints. */
export interface AuthoringField {
  readonly key: string;
  readonly ui?: unknown;
}

/** Read a field's authoring hints, tolerating absent or malformed `ui`. */
export function authoringUiOf(field: AuthoringField): WidgetAuthoringUi {
  const ui = field.ui;
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) return {};
  const record = ui as Record<string, unknown>;
  const out: {
    section?: WidgetAuthoringSection;
    order?: number;
    visibleWhen?: WidgetVisibleWhen;
    styleCard?: boolean;
    semanticRole?: string;
  } = {};
  if (
    record["section"] === "data" ||
    record["section"] === "content" ||
    record["section"] === "appearance" ||
    record["section"] === "behavior"
  ) {
    out.section = record["section"];
  }
  if (typeof record["order"] === "number" && Number.isFinite(record["order"])) {
    out.order = record["order"];
  }
  const visibleWhen = record["visibleWhen"];
  if (
    visibleWhen &&
    typeof visibleWhen === "object" &&
    !Array.isArray(visibleWhen) &&
    typeof (visibleWhen as Record<string, unknown>)["key"] === "string"
  ) {
    out.visibleWhen = visibleWhen as WidgetVisibleWhen;
  }
  if (record["styleCard"] === true) out.styleCard = true;
  if (typeof record["semanticRole"] === "string") {
    out.semanticRole = record["semanticRole"];
  }
  return out;
}

function matches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((item) => item === actual);
  return expected === actual;
}

function isVisible(
  ui: WidgetAuthoringUi,
  configuration: Readonly<Record<string, unknown>>,
): boolean {
  const rule = ui.visibleWhen;
  if (!rule) return true;
  const actual = configuration[rule.key];
  if (rule.equals !== undefined && !matches(rule.equals, actual)) return false;
  if (rule.notEquals !== undefined && matches(rule.notEquals, actual)) {
    return false;
  }
  return true;
}

/**
 * The fields an inspector shows for this configuration: hidden controls
 * removed, manifest order preserved. Ordering and section grouping happen
 * in {@link groupAuthoringFields}.
 */
export function visibleAuthoringFields<Field extends AuthoringField>(
  fields: readonly Field[],
  configuration: Readonly<Record<string, unknown>>,
): Field[] {
  return fields.filter((field) =>
    isVisible(authoringUiOf(field), configuration),
  );
}

/**
 * Group visible fields by section in canonical order, omitting sections
 * with no controls. Within a section, explicit `order` comes first, then
 * manifest order. Fields without a section land in `content`.
 */
export function groupAuthoringFields<Field extends AuthoringField>(
  fields: readonly Field[],
): { section: WidgetAuthoringSection; fields: Field[] }[] {
  const groups = new Map<WidgetAuthoringSection, { field: Field; index: number }[]>();
  fields.forEach((field, index) => {
    const section = authoringUiOf(field).section ?? "content";
    const group = groups.get(section);
    if (group) group.push({ field, index });
    else groups.set(section, [{ field, index }]);
  });
  const byOrder = (
    a: { field: Field; index: number },
    b: { field: Field; index: number },
  ) => {
    const orderA = authoringUiOf(a.field).order ?? Number.MAX_SAFE_INTEGER;
    const orderB = authoringUiOf(b.field).order ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB || a.index - b.index;
  };
  return AUTHORING_SECTIONS.flatMap((section) => {
    const sectionFields = groups.get(section);
    return sectionFields
      ? [{ section, fields: sectionFields.sort(byOrder).map((entry) => entry.field) }]
      : [];
  });
}

/**
 * Authoring metadata for configuration schemas (docs/widget-authoring.md).
 * Widget definitions and Plugin Manifest API 3 schemas share it.
 *
 * A definition's `configurationSchema` fields may carry a small `ui` object
 * with the hints the Studio inspector needs: which section a control
 * belongs to, its order, when it is visible, whether a select renders as
 * visual choices, whether a bounded number is better as a slider, whether
 * a rare setting belongs under Advanced, and which semantic field it
 * suggests. Everything else (control type, label, help text, compatible
 * Data Source kinds) already lives on the field itself. Studio renders one
 * inspector from this metadata; Widgets never get their own React editors.
 */

import type {
  ConfigAuthoringSection,
  ConfigVisibleWhen,
} from "./fields.ts";

export type AuthoringSection = ConfigAuthoringSection;

/** The canonical inspector order. Sections without controls are hidden. */
export const AUTHORING_SECTIONS: readonly AuthoringSection[] = [
  "data",
  "content",
  "appearance",
  "behavior",
];

export type VisibleWhen = ConfigVisibleWhen;

export interface AuthoringUi {
  readonly section?: AuthoringSection;
  readonly order?: number;
  /** One rule, or a list of rules that must all match. */
  readonly visibleWhen?: VisibleWhen | readonly VisibleWhen[];
  /** Render a select's options as visible choices instead of a dropdown. */
  readonly styleCard?: boolean;
  /** Render a bounded number or integer as a slider beside its input. */
  readonly slider?: boolean;
  /** A rarely changed setting, shown under the section's Advanced group. */
  readonly advanced?: boolean;
  /** The semantic field role this control suggests, if any. */
  readonly semanticRole?: string;
  /**
   * Known legacy source keys for the suggested slot, matched
   * case-insensitively after declared roles (§4.1 step 2).
   */
  readonly legacyKeys?: readonly string[];
  /**
   * `false` keeps automatic mapping from guessing this slot by compatible
   * type. An optional slot (Alert Banner's severity) then stays unmapped
   * unless the source declares its role or a legacy key, instead of
   * borrowing an unrelated text column.
   */
  readonly typeFallback?: boolean;
  /**
   * A retained key: validated and kept on save, never shown in the
   * inspector. Migrated providers use it for keys that compatibility
   * presentations still read (docs/widgets-v2-catalog.md §8).
   */
  readonly hidden?: boolean;
  /**
   * An integer stored in seconds that a person enters in whole minutes.
   * The stored value and its bounds stay in seconds.
   */
  readonly inputUnit?: "minutes";
}

/** A configuration-schema field with optional authoring hints. */
export interface AuthoringField {
  readonly key: string;
  readonly ui?: unknown;
}

/** Read a field's authoring hints, tolerating absent or malformed `ui`. */
export function authoringUiOf(field: AuthoringField): AuthoringUi {
  const ui = field.ui;
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) return {};
  const record = ui as Record<string, unknown>;
  const out: {
    section?: AuthoringSection;
    order?: number;
    visibleWhen?: VisibleWhen | readonly VisibleWhen[];
    styleCard?: boolean;
    slider?: boolean;
    advanced?: boolean;
    semanticRole?: string;
    legacyKeys?: readonly string[];
    typeFallback?: boolean;
    hidden?: boolean;
    inputUnit?: "minutes";
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
  const isRule = (value: unknown): value is VisibleWhen =>
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)["key"] === "string";
  if (isRule(visibleWhen)) {
    out.visibleWhen = visibleWhen;
  } else if (
    Array.isArray(visibleWhen) &&
    visibleWhen.length > 0 &&
    visibleWhen.every(isRule)
  ) {
    out.visibleWhen = visibleWhen as VisibleWhen[];
  }
  if (record["styleCard"] === true) out.styleCard = true;
  if (record["slider"] === true) out.slider = true;
  if (record["advanced"] === true) out.advanced = true;
  if (record["hidden"] === true) out.hidden = true;
  if (record["typeFallback"] === false) out.typeFallback = false;
  if (record["inputUnit"] === "minutes") out.inputUnit = "minutes";
  if (typeof record["semanticRole"] === "string") {
    out.semanticRole = record["semanticRole"];
  }
  const legacyKeys = record["legacyKeys"];
  if (Array.isArray(legacyKeys)) {
    const keys = legacyKeys.filter(
      (key): key is string => typeof key === "string" && key !== "",
    );
    if (keys.length > 0) out.legacyKeys = keys;
  }
  return out;
}

function matches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((item) => item === actual);
  return expected === actual;
}

function isVisible(
  ui: AuthoringUi,
  configuration: Readonly<Record<string, unknown>>,
): boolean {
  if (ui.hidden) return false;
  const rules = ui.visibleWhen;
  if (!rules) return true;
  const list: readonly VisibleWhen[] = Array.isArray(rules)
    ? rules
    : [rules as VisibleWhen];
  return list.every((rule) => {
    const actual = configuration[rule.key];
    if (rule.equals !== undefined && !matches(rule.equals, actual)) {
      return false;
    }
    return !(rule.notEquals !== undefined && matches(rule.notEquals, actual));
  });
}

/**
 * The fields an inspector shows for this configuration: retained
 * (`hidden`) fields and fields whose visibility rule fails are removed,
 * manifest order preserved. Ordering and section grouping happen
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
): { section: AuthoringSection; fields: Field[] }[] {
  const groups = new Map<
    AuthoringSection,
    { field: Field; index: number }[]
  >();
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
      ? [
          {
            section,
            fields: sectionFields.sort(byOrder).map((entry) => entry.field),
          },
        ]
      : [];
  });
}

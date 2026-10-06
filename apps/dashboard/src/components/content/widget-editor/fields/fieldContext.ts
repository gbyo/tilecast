import type { ContentDefinitionField } from "@/api/types";
import type { WidgetConfiguration } from "../widgetEditorModel";

/** Everything one inspector control needs, at any nesting depth. */
export type InspectorFieldProps = {
  readonly field: ContentDefinitionField;
  /** "title" at the root, "items.2.label" inside a repeating group. */
  readonly path: string;
  readonly value: unknown;
  /** The object holding this field: the configuration or a group item. */
  readonly values: WidgetConfiguration;
  /** This field's siblings, for resolving which Data Source it reads. */
  readonly fields: readonly ContentDefinitionField[];
  readonly rootValues: WidgetConfiguration;
  readonly rootFields: readonly ContentDefinitionField[];
  readonly onChange: (value: unknown) => void;
  readonly readOnly: boolean;
  readonly csrf: string;
  /** Validation messages, shown only after an attempted save. */
  readonly errorFor: (path: string) => string | undefined;
  /** A path the editor wants focused; containers holding it open. */
  readonly focusPath: string | null;
};

/** A DOM id for a field path that is safe in selectors and htmlFor. */
export function fieldDomId(path: string) {
  return `widget-field-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

export function fieldText(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

/** The ARIA wiring shared by every control: description, error, required. */
export function controlAria(
  path: string,
  field: ContentDefinitionField,
  error: string | undefined,
) {
  const id = fieldDomId(path);
  const describedBy = [
    field.description ? `${id}-description` : undefined,
    error ? `${id}-error` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    id,
    "aria-invalid": error ? (true as const) : undefined,
    "aria-describedby": describedBy || undefined,
    "aria-required": field.required ? (true as const) : undefined,
  };
}

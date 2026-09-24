import type { TFunction } from "i18next";
import type { FormDataSource, FormSchema } from "../api/types";

export type OutputField = { key: string; label: string; type: string };

type FormsT = TFunction<"forms", undefined>;

// outputTypeFor mirrors the server (apps/server/internal/forms/types.go): the typed output a form
// control exposes to views/widgets, or "" for presentation-only controls.
function outputTypeFor(control: string): string {
  switch (control) {
    case "short_text":
    case "long_text":
    case "select":
    case "multi_select":
      return "text";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "url":
      return "url";
    case "image":
      return "asset";
    default:
      return "";
  }
}

// syntheticFieldKeys are the record fields every form exposes in addition to its schema fields,
// matching outputFieldSpecs on the server. Labels live in the forms locale.
const syntheticFieldKeys = [
  { key: "state", labelKey: "outputFields.synthetic.state", type: "text" },
  {
    key: "displayTitle",
    labelKey: "outputFields.synthetic.displayTitle",
    type: "text",
  },
  {
    key: "priority",
    labelKey: "outputFields.synthetic.priority",
    type: "integer",
  },
  {
    key: "submittedAt",
    labelKey: "outputFields.synthetic.submittedAt",
    type: "datetime",
  },
  {
    key: "displayAt",
    labelKey: "outputFields.synthetic.displayAt",
    type: "datetime",
  },
  {
    key: "expiresAt",
    labelKey: "outputFields.synthetic.expiresAt",
    type: "datetime",
  },
] as const;

// availableOutputFields returns the selectable output fields for a form's published revision (falling
// back to the draft), matching what the server projects. Used to drive the Views editor's field,
// filter, and sort selectors.
export function availableOutputFields(
  form: FormDataSource,
  t: FormsT,
): OutputField[] {
  const schema: FormSchema = form.publishedRevision?.schema ??
    form.draftSchema ?? { fields: [] };
  const fields: OutputField[] = [];
  for (const field of schema.fields) {
    const type = outputTypeFor(field.control);
    if (type === "") continue;
    fields.push({ key: field.key, label: field.label || field.key, type });
  }
  return [
    ...fields,
    ...syntheticFieldKeys.map((synthetic) => ({
      key: synthetic.key,
      label: t(synthetic.labelKey),
      type: synthetic.type,
    })),
  ];
}

// operatorsForType returns the filter operators valid for a field type (field-aware operators), so
// the Views editor never offers an invalid filter/field combination.
export function operatorsForType(
  type: string,
  t: FormsT,
): { value: string; label: string }[] {
  const base = [
    { value: "equals", label: t("outputFields.operators.equals") },
    { value: "not_equals", label: t("outputFields.operators.notEquals") },
    { value: "empty", label: t("outputFields.operators.empty") },
    { value: "not_empty", label: t("outputFields.operators.notEmpty") },
  ];
  if (
    type === "number" ||
    type === "integer" ||
    type === "date" ||
    type === "datetime"
  ) {
    return [
      ...base,
      {
        value: "greater_than",
        label: t("outputFields.operators.greaterThan"),
      },
      { value: "less_than", label: t("outputFields.operators.lessThan") },
    ];
  }
  if (type === "text" || type === "url") {
    return [
      { value: "contains", label: t("outputFields.operators.contains") },
      ...base,
    ];
  }
  return base; // boolean / asset
}

// isTimeField reports whether a field can anchor the relative time-window filter.
export function isTimeField(type: string): boolean {
  return type === "date" || type === "datetime";
}

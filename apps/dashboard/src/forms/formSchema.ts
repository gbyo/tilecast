import type { TFunction } from "i18next";
import type {
  FormDataSource,
  FormField,
  FormFieldControl,
  FormSchema,
} from "../api/types";
import { uniqueKey } from "./formKeys";

export type FormsT = TFunction<"forms", undefined>;

// ControlMeta centralizes how each field control behaves so the palette, editor, renderer, and
// publish-lock logic stay in agreement. outputType mirrors the server's outputTypeFor mapping;
// presentation controls (section, help_text) produce no output field. Display text lives in the
// forms locale under controls.<control>; render sites translate labelKey/descriptionKey.
export type ControlLabelKey =
  | "controls.shortText.label"
  | "controls.longText.label"
  | "controls.number.label"
  | "controls.integer.label"
  | "controls.boolean.label"
  | "controls.select.label"
  | "controls.multiSelect.label"
  | "controls.date.label"
  | "controls.datetime.label"
  | "controls.url.label"
  | "controls.image.label"
  | "controls.section.label"
  | "controls.helpText.label";

export type ControlDescriptionKey =
  | "controls.shortText.description"
  | "controls.longText.description"
  | "controls.number.description"
  | "controls.integer.description"
  | "controls.boolean.description"
  | "controls.select.description"
  | "controls.multiSelect.description"
  | "controls.date.description"
  | "controls.datetime.description"
  | "controls.url.description"
  | "controls.image.description"
  | "controls.section.description"
  | "controls.helpText.description";

export type ControlMeta = {
  control: FormFieldControl;
  labelKey: ControlLabelKey;
  descriptionKey: ControlDescriptionKey;
  presentation: boolean;
  outputType: string | null;
  hasOptions: boolean;
  numericBounds: boolean;
  lengthBounds: boolean;
};

export const CONTROLS: ControlMeta[] = [
  {
    control: "short_text",
    labelKey: "controls.shortText.label",
    descriptionKey: "controls.shortText.description",
    presentation: false,
    outputType: "text",
    hasOptions: false,
    numericBounds: false,
    lengthBounds: true,
  },
  {
    control: "long_text",
    labelKey: "controls.longText.label",
    descriptionKey: "controls.longText.description",
    presentation: false,
    outputType: "text",
    hasOptions: false,
    numericBounds: false,
    lengthBounds: true,
  },
  {
    control: "number",
    labelKey: "controls.number.label",
    descriptionKey: "controls.number.description",
    presentation: false,
    outputType: "number",
    hasOptions: false,
    numericBounds: true,
    lengthBounds: false,
  },
  {
    control: "integer",
    labelKey: "controls.integer.label",
    descriptionKey: "controls.integer.description",
    presentation: false,
    outputType: "integer",
    hasOptions: false,
    numericBounds: true,
    lengthBounds: false,
  },
  {
    control: "boolean",
    labelKey: "controls.boolean.label",
    descriptionKey: "controls.boolean.description",
    presentation: false,
    outputType: "boolean",
    hasOptions: false,
    numericBounds: false,
    lengthBounds: false,
  },
  {
    control: "select",
    labelKey: "controls.select.label",
    descriptionKey: "controls.select.description",
    presentation: false,
    outputType: "text",
    hasOptions: true,
    numericBounds: false,
    lengthBounds: false,
  },
  {
    control: "multi_select",
    labelKey: "controls.multiSelect.label",
    descriptionKey: "controls.multiSelect.description",
    presentation: false,
    outputType: "text",
    hasOptions: true,
    numericBounds: false,
    lengthBounds: false,
  },
  {
    control: "date",
    labelKey: "controls.date.label",
    descriptionKey: "controls.date.description",
    presentation: false,
    outputType: "date",
    hasOptions: false,
    numericBounds: false,
    lengthBounds: false,
  },
  {
    control: "datetime",
    labelKey: "controls.datetime.label",
    descriptionKey: "controls.datetime.description",
    presentation: false,
    outputType: "datetime",
    hasOptions: false,
    numericBounds: false,
    lengthBounds: false,
  },
  {
    control: "url",
    labelKey: "controls.url.label",
    descriptionKey: "controls.url.description",
    presentation: false,
    outputType: "url",
    hasOptions: false,
    numericBounds: false,
    lengthBounds: false,
  },
  {
    control: "image",
    labelKey: "controls.image.label",
    descriptionKey: "controls.image.description",
    presentation: false,
    outputType: "asset",
    hasOptions: false,
    numericBounds: false,
    lengthBounds: false,
  },
  {
    control: "section",
    labelKey: "controls.section.label",
    descriptionKey: "controls.section.description",
    presentation: true,
    outputType: null,
    hasOptions: false,
    numericBounds: false,
    lengthBounds: false,
  },
  {
    control: "help_text",
    labelKey: "controls.helpText.label",
    descriptionKey: "controls.helpText.description",
    presentation: true,
    outputType: null,
    hasOptions: false,
    numericBounds: false,
    lengthBounds: false,
  },
];

const CONTROL_BY_ID = new Map(CONTROLS.map((meta) => [meta.control, meta]));

export function controlMeta(control: FormFieldControl): ControlMeta {
  return CONTROL_BY_ID.get(control) ?? CONTROLS[0]!;
}

export function outputTypeFor(control: FormFieldControl): string | null {
  return controlMeta(control).outputType;
}

export function isPresentationControl(control: FormFieldControl): boolean {
  return controlMeta(control).presentation;
}

// newField builds a sensible default field for a control, with a unique key derived from a label.
// Default labels are translated so a new field starts in the author's language; they are stored
// content the author can edit afterwards.
export function newField(
  control: FormFieldControl,
  existingKeys: Iterable<string>,
  t: FormsT,
): FormField {
  const meta = controlMeta(control);
  const label = meta.presentation
    ? control === "section"
      ? t("defaults.sectionLabel")
      : t("defaults.helpTextLabel")
    : t(meta.labelKey);
  const field: FormField = {
    key: uniqueKey(label, existingKeys),
    label,
    control,
  };
  if (meta.hasOptions) {
    field.options = [
      { value: "option_1", label: t("defaults.optionLabel", { n: 1 }) },
      { value: "option_2", label: t("defaults.optionLabel", { n: 2 }) },
    ];
  }
  return field;
}

// publishedOutputKeys returns key -> output type for every output-producing field in the current
// published revision. The builder uses it to lock keys and output-changing control swaps.
export function publishedOutputKeys(
  form: FormDataSource | undefined,
): Map<string, string> {
  const result = new Map<string, string>();
  const schema = form?.publishedRevision?.schema;
  if (!schema) {
    return result;
  }
  for (const field of schema.fields) {
    const type = outputTypeFor(field.control);
    if (type) {
      result.set(field.key, type);
    }
  }
  return result;
}

// controlsProducingOutputType lists the controls a locked field may switch between (same output
// type), so a published "short_text" can become "select" but never "number".
export function controlsWithOutputType(outputType: string): FormFieldControl[] {
  return CONTROLS.filter((meta) => meta.outputType === outputType).map(
    (meta) => meta.control,
  );
}

// schemasEquivalent reports whether two schemas are semantically identical, normalizing optional
// fields so a draft object and a server-published schema (which omits empty properties) compare
// equal when they carry the same content. Used to disable a no-op publish.
export function schemasEquivalent(a: FormSchema, b: FormSchema): boolean {
  return canonicalSchema(a) === canonicalSchema(b);
}

function canonicalSchema(schema: FormSchema): string {
  return JSON.stringify({
    title: schema.title ?? "",
    description: schema.description ?? "",
    fields: (schema.fields ?? []).map((field) => ({
      key: field.key,
      label: field.label ?? "",
      description: field.description ?? "",
      control: field.control,
      required: Boolean(field.required),
      default: field.default ?? "",
      options: (field.options ?? []).map((option) => ({
        value: option.value,
        label: option.label,
      })),
      minimum: field.minimum ?? null,
      maximum: field.maximum ?? null,
      minLength: field.minLength ?? null,
      maxLength: field.maxLength ?? null,
    })),
  });
}

export const INITIAL_FORM_SCHEMA = (t: FormsT): FormSchema => ({
  title: "",
  description: "",
  fields: [
    {
      key: "title",
      label: t("defaults.titleLabel"),
      control: "short_text",
      required: true,
    },
  ],
});

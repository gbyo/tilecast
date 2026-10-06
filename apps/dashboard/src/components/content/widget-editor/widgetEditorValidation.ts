/**
 * One validation pass over a Widget draft. It checks what the definition
 * declares (required values, bounds, lengths, formats, list limits) for
 * the controls the author can currently see. The Server stays the
 * authority; this only stops a save that would certainly fail and points
 * at the control to fix. Preview health is deliberately not an input.
 */
import {
  groupAuthoringFields,
  visibleAuthoringFields,
  type WidgetAuthoringSection,
} from "@tilecast/widget-sdk";
import type { TFunction } from "i18next";
import type { ContentDefinitionField, WidgetDefinition } from "@/api/types";
import {
  widgetDetailLimits,
  type WidgetConfiguration,
  type WidgetDraft,
} from "./widgetEditorModel";

type ContentT = TFunction<["content", "common"]>;

export type WidgetIssue = {
  /** The field path, e.g. "title" or "items.2.label". */
  readonly path: string;
  /** The inspector section holding the top-level field. */
  readonly section: WidgetAuthoringSection;
  readonly message: string;
};

export type WidgetValidation = {
  readonly name?: string;
  readonly description?: string;
  /** Field problems in inspector order. */
  readonly issues: readonly WidgetIssue[];
  readonly byPath: ReadonlyMap<string, string>;
  readonly valid: boolean;
};

const colorPattern = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;

function isEmpty(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

function validUrl(text: string) {
  try {
    const url = new URL(text);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !!url.host
    );
  } catch {
    return false;
  }
}

function fieldProblem(
  field: ContentDefinitionField,
  value: unknown,
  t: ContentT,
): string | undefined {
  if (isEmpty(value)) {
    if (!field.required) return undefined;
    return field.control === "select" ||
      field.control === "data_source" ||
      field.control === "data_source_field" ||
      field.control === "media_asset" ||
      field.control === "timezone"
      ? t("widgets.editor.validation.choose")
      : t("widgets.editor.validation.required");
  }
  switch (field.control) {
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value))
        return t("widgets.editor.validation.number");
      if (field.control === "integer" && !Number.isInteger(value))
        return t("widgets.editor.validation.integer");
      if (field.minimum !== undefined && value < field.minimum)
        return t("widgets.editor.validation.minimum", { value: field.minimum });
      if (field.maximum !== undefined && value > field.maximum)
        return t("widgets.editor.validation.maximum", { value: field.maximum });
      return undefined;
    }
    case "url":
      if (typeof value === "string" && !validUrl(value.trim()))
        return t("widgets.editor.validation.url");
      break;
    case "color":
      if (typeof value === "string" && !colorPattern.test(value.trim()))
        return t("widgets.editor.validation.color");
      return undefined;
    case "string_list": {
      const items = Array.isArray(value) ? value : [];
      if (field.maximumItems && items.length > field.maximumItems)
        return t("widgets.editor.validation.tooMany", {
          count: field.maximumItems,
        });
      if (
        field.maxLength &&
        items.some(
          (item) => typeof item === "string" && item.length > field.maxLength!,
        )
      )
        return t("widgets.editor.validation.entryTooLong", {
          count: field.maxLength,
        });
      return undefined;
    }
    case "repeating_group": {
      const items = Array.isArray(value) ? value : [];
      if (field.maximumItems && items.length > field.maximumItems)
        return t("widgets.editor.validation.tooMany", {
          count: field.maximumItems,
        });
      return undefined;
    }
  }
  if (typeof value === "string") {
    const length = value.trim().length;
    if (field.minLength && length < field.minLength)
      return t("widgets.editor.validation.tooShort", {
        count: field.minLength,
      });
    if (field.maxLength && length > field.maxLength)
      return t("widgets.editor.validation.tooLong", {
        count: field.maxLength,
      });
  }
  return undefined;
}

function collect(
  fields: readonly ContentDefinitionField[],
  values: WidgetConfiguration,
  prefix: string,
  section: WidgetAuthoringSection,
  t: ContentT,
  out: WidgetIssue[],
) {
  for (const field of fields) {
    const path = `${prefix}${field.key}`;
    const value = values[field.key];
    const problem = fieldProblem(field, value, t);
    if (problem) out.push({ path, section, message: problem });
    if (field.control === "repeating_group" && Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item && typeof item === "object" && !Array.isArray(item))
          collect(
            visibleAuthoringFields(
              field.itemFields ?? [],
              item as WidgetConfiguration,
            ),
            item as WidgetConfiguration,
            `${path}.${index}.`,
            section,
            t,
            out,
          );
      });
    }
  }
}

export function validateWidgetDraft(
  definition: WidgetDefinition,
  draft: WidgetDraft,
  t: ContentT,
): WidgetValidation {
  const name = draft.name.trim();
  const nameProblem = !name
    ? t("widgets.editor.validation.nameRequired")
    : name.length > widgetDetailLimits.name
      ? t("widgets.editor.validation.tooLong", {
          count: widgetDetailLimits.name,
        })
      : undefined;
  const descriptionProblem =
    draft.description.trim().length > widgetDetailLimits.description
      ? t("widgets.editor.validation.tooLong", {
          count: widgetDetailLimits.description,
        })
      : undefined;
  const issues: WidgetIssue[] = [];
  // Inspector order, so the first issue is the first one a person reaches.
  for (const group of groupAuthoringFields(
    visibleAuthoringFields(
      definition.configurationSchema.fields,
      draft.configuration,
    ),
  ))
    collect(group.fields, draft.configuration, "", group.section, t, issues);
  return {
    name: nameProblem,
    description: descriptionProblem,
    issues,
    byPath: new Map(issues.map((issue) => [issue.path, issue.message])),
    valid: !nameProblem && !descriptionProblem && issues.length === 0,
  };
}

/** Where to move focus to show the first problem, or null when there is none. */
export function firstProblemFocus(
  validation: WidgetValidation,
):
  | { target: "details" }
  | { target: "field"; path: string; section: WidgetAuthoringSection }
  | null {
  if (validation.name || validation.description) return { target: "details" };
  const first = validation.issues[0];
  return first
    ? { target: "field", path: first.path, section: first.section }
    : null;
}

/**
 * Author-facing text of a content definition (docs/widget-authoring.md,
 * Localized authoring text).
 *
 * A definition field carries its English words as literals and may name a
 * Studio translation key beside each one: `label` and `labelKey`,
 * `description` and `descriptionKey`, and an option's `label` and
 * `labelKey`. Tilecast's own definitions use keys in the `definitions`
 * namespace. A plugin or an external definition supplies literals only and
 * registers nothing. A key that Studio cannot resolve, whether unknown,
 * empty, or from another namespace, falls back to the literal, so a missing
 * translation never leaves a control without words.
 */
import type { ContentDefinitionField } from "@/api/types";
import { translateKnown } from "@/i18n";

export const DEFINITION_NAMESPACE = "definitions";

/** The text for a literal and its optional translation key. */
export function definitionText(literal: string, key?: string): string {
  if (!key?.startsWith(`${DEFINITION_NAMESPACE}:`)) return literal;
  const text = translateKnown(key, literal);
  return text.trim() === "" ? literal : text;
}

/** The field with every author-facing string resolved for the active language. */
export function localizeDefinitionField(
  field: ContentDefinitionField,
): ContentDefinitionField {
  const description =
    field.description === undefined
      ? undefined
      : definitionText(field.description, field.descriptionKey);
  return {
    ...field,
    label: definitionText(field.label, field.labelKey),
    ...(description === undefined ? {} : { description }),
    ...(field.options && {
      options: field.options.map((option) => ({
        ...option,
        label: definitionText(option.label, option.labelKey),
      })),
    }),
    ...(field.itemFields && {
      itemFields: field.itemFields.map(localizeDefinitionField),
    }),
  };
}

import type { ConfigField } from "@tilecast/config-schema";
import type { ContentDefinitionField } from "../../api/types";
import { translateKnown } from "@/i18n";
import { pluginNamespace } from "../translation";

/**
 * A plugin field's text in the active language. A field names keys inside
 * the plugin's own Studio namespace (studio/locales/<language>.json), beside
 * its English literals. A key Studio cannot resolve falls back to the
 * literal, so a missing translation never leaves a control without words.
 */
function text(namespace: string, literal: string, key?: string): string {
  if (!key) return literal;
  const resolved = translateKnown(`${namespace}:${key}`, literal);
  return resolved.trim() === "" ? literal : resolved;
}

export function localizePluginFields(
  pluginId: string,
  fields: readonly ConfigField[],
): ContentDefinitionField[] {
  const namespace = pluginNamespace(pluginId);
  const localize = (field: ConfigField): ContentDefinitionField => {
    const description =
      field.description === undefined
        ? undefined
        : text(namespace, field.description, field.descriptionKey);
    return {
      ...field,
      label: text(namespace, field.label, field.labelKey),
      ...(description === undefined ? {} : { description }),
      ...(field.options && {
        options: field.options.map((option) => ({
          ...option,
          label: text(namespace, option.label, option.labelKey),
        })),
      }),
      ...(field.itemFields && { itemFields: field.itemFields.map(localize) }),
    };
  };
  return fields.map(localize);
}

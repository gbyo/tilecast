import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ContentDefinitionField } from "@/api/types";
import {
  DEFINITION_NAMESPACE,
  localizeDefinitionField,
} from "./definitionText";

/** A definition's fields with their text resolved, refreshed on a language change. */
export function useLocalizedDefinitionFields(
  fields: readonly ContentDefinitionField[],
): ContentDefinitionField[] {
  const { i18n } = useTranslation(DEFINITION_NAMESPACE);
  const language = i18n.resolvedLanguage;
  // The language is a dependency because the result changes with it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => fields.map(localizeDefinitionField), [fields, language]);
}

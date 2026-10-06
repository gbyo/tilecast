/**
 * The Data Source behind a field mapping and the suggestion for a slot.
 * Shared by the mapping control and automatic mapping.
 */
import { useQuery } from "@tanstack/react-query";
import { suggestFieldMapping } from "@tilecast/widget-kit";
import { api } from "@/api/client";
import type { ContentDefinitionField, DataSourceField } from "@/api/types";
import { resolveDataSourceKey } from "@/content/DefinitionForm";
import { fieldText, type InspectorFieldProps } from "./fieldContext";

export function useSourceFields(sourceId: string) {
  return useQuery({
    queryKey: ["definition-form-data-source", sourceId],
    queryFn: () => api.getDataSource(sourceId),
    enabled: Boolean(sourceId),
    select: (source) => source.fields ?? [],
  });
}

/** The suggested source field for a slot, or "" when nothing fits. */
export function suggestedSourceField(
  field: ContentDefinitionField,
  sourceFields: readonly DataSourceField[],
): string {
  const roles = field.ui?.semanticRole ? [field.ui.semanticRole] : [];
  const legacyKeys = field.ui?.legacyKeys ?? [];
  return (
    suggestFieldMapping([...sourceFields], {
      [field.key]: {
        roles,
        legacyKeys,
        types: field.dataSourceFieldTypes ?? [],
      },
    })[field.key] ?? ""
  );
}

/** The Data Source a mapping control reads, from its siblings or the root. */
export function mappingSourceId({
  field,
  values,
  fields,
  rootValues,
  rootFields,
}: Pick<
  InspectorFieldProps,
  "field" | "values" | "fields" | "rootValues" | "rootFields"
>) {
  const key = resolveDataSourceKey(field, fields, rootFields);
  return key ? fieldText(values[key]) || fieldText(rootValues[key]) : "";
}

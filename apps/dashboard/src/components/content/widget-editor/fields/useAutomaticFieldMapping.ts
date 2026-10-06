/**
 * Automatic semantic mapping (docs/widgets-v2-authoring-and-first-wave.md
 * §4.1). When the author connects a different Data Source, every slot that
 * reads it is filled from its declared role, legacy keys, or compatible
 * types. A choice the new source still has stands; a key it lacks is stale
 * and remaps (or clears). Opening a saved Widget maps nothing, so looking
 * at a Widget never changes it.
 *
 * This runs once for the whole draft rather than inside each control, so a
 * slot in another inspector tab is mapped even while it is not mounted.
 */
import { useQueries } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef } from "react";
import { api } from "@/api/client";
import type { ContentDefinitionField, DataSourceField } from "@/api/types";
import { resolveDataSourceKey } from "@/content/dataSourceBindings";
import type { WidgetConfiguration } from "../widgetEditorModel";
import { suggestedSourceField } from "./fieldMapping";

type SourceSelection = {
  /** "dataSourceId", or "items.2.dataSourceId" inside a group. */
  readonly path: string;
  readonly key: string;
  readonly id: string;
};

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function sourceSelections(
  fields: readonly ContentDefinitionField[],
  values: WidgetConfiguration,
  prefix = "",
): SourceSelection[] {
  const out: SourceSelection[] = [];
  for (const field of fields) {
    if (field.control === "data_source")
      out.push({
        path: `${prefix}${field.key}`,
        key: field.key,
        id: text(values[field.key]),
      });
    if (field.control === "repeating_group" && Array.isArray(values[field.key]))
      (values[field.key] as WidgetConfiguration[]).forEach((item, index) => {
        if (item && typeof item === "object")
          out.push(
            ...sourceSelections(
              field.itemFields ?? [],
              item,
              `${prefix}${field.key}.${index}.`,
            ),
          );
      });
  }
  return out;
}

/** Remap the slots of one object level that read `sourceKey`. */
function remapLevel(
  fields: readonly ContentDefinitionField[],
  values: WidgetConfiguration,
  sourceKey: string,
  sourceFields: readonly DataSourceField[],
  rootFields: readonly ContentDefinitionField[],
  includeGroups: boolean,
): WidgetConfiguration {
  const known = new Set(sourceFields.map((entry) => entry.key));
  let next = values;
  for (const field of fields) {
    if (
      field.control === "data_source_field" &&
      resolveDataSourceKey(field, fields, rootFields) === sourceKey
    ) {
      const current = text(values[field.key]);
      if (current && known.has(current)) continue;
      const suggestion = suggestedSourceField(field, sourceFields);
      if (suggestion !== current) next = { ...next, [field.key]: suggestion };
    }
    // Groups without their own source read the root one.
    if (
      includeGroups &&
      field.control === "repeating_group" &&
      Array.isArray(values[field.key]) &&
      !(field.itemFields ?? []).some((item) => item.control === "data_source")
    ) {
      const items = values[field.key] as WidgetConfiguration[];
      const mapped = items.map((item) =>
        remapLevel(
          field.itemFields ?? [],
          item,
          sourceKey,
          sourceFields,
          rootFields,
          false,
        ),
      );
      if (mapped.some((item, index) => item !== items[index]))
        next = { ...next, [field.key]: mapped };
    }
  }
  return next;
}

function remap(
  configuration: WidgetConfiguration,
  selection: SourceSelection,
  rootFields: readonly ContentDefinitionField[],
  sourceFields: readonly DataSourceField[],
): WidgetConfiguration {
  const segments = selection.path.split(".");
  if (segments.length === 1)
    return remapLevel(
      rootFields,
      configuration,
      selection.key,
      sourceFields,
      rootFields,
      true,
    );
  // A source inside a group item maps that item's own slots.
  const [groupKey, indexText] = segments;
  const group = rootFields.find((field) => field.key === groupKey);
  const stored = configuration[groupKey!];
  const items: unknown[] = Array.isArray(stored) ? stored : [];
  const index = Number(indexText);
  if (!group || !items[index]) return configuration;
  const item = items[index] as WidgetConfiguration;
  const mapped = remapLevel(
    group.itemFields ?? [],
    item,
    selection.key,
    sourceFields,
    rootFields,
    false,
  );
  if (mapped === item) return configuration;
  return {
    ...configuration,
    [groupKey!]: items.map((entry, position) =>
      position === index ? mapped : entry,
    ),
  };
}

export function useAutomaticFieldMapping({
  fields,
  configuration,
  readOnly,
  updateConfiguration,
}: {
  fields: readonly ContentDefinitionField[];
  configuration: WidgetConfiguration;
  readOnly: boolean;
  updateConfiguration: (
    update: (current: WidgetConfiguration) => WidgetConfiguration,
  ) => void;
}) {
  const selections = sourceSelections(fields, configuration);
  const ids = [...new Set(selections.map((entry) => entry.id).filter(Boolean))];
  const details = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["definition-form-data-source", id],
      queryFn: () => api.getDataSource(id),
    })),
  });
  const sourceFields = new Map(
    ids.flatMap((id, index) => {
      const data = details[index]?.data;
      return data ? [[id, data.fields ?? []] as const] : [];
    }),
  );
  // What each source control held when the editor opened, or after the
  // last mapping. Only a change from this triggers mapping, so opening a
  // saved Widget never changes it. It is recorded by the first effect run,
  // after the first commit and before anyone can have edited anything.
  const seen = useRef<Map<string, string> | null>(null);

  const selectionKey = JSON.stringify(selections);
  const loadedKey = [...sourceFields.keys()].join(",");
  // An Effect Event always reads the latest fields and loaded sources
  // without making the effect below re-run for them.
  const mapChangedSelections = useEffectEvent(() => {
    const current = JSON.parse(selectionKey) as SourceSelection[];
    if (seen.current === null) {
      seen.current = new Map(current.map((entry) => [entry.path, entry.id]));
      return;
    }
    const memory = seen.current;
    // Disconnecting is remembered too, so reconnecting the same source maps.
    for (const entry of current) if (!entry.id) memory.set(entry.path, "");
    const pending = current.filter(
      (entry) =>
        entry.id &&
        memory.get(entry.path) !== entry.id &&
        sourceFields.has(entry.id),
    );
    if (pending.length === 0) return;
    for (const entry of pending) memory.set(entry.path, entry.id);
    updateConfiguration((configuration) =>
      pending.reduce(
        (next, entry) =>
          remap(next, entry, fields, sourceFields.get(entry.id) ?? []),
        configuration,
      ),
    );
  });
  useEffect(() => {
    if (!readOnly) mapChangedSelections();
  }, [selectionKey, loadedKey, readOnly]);
}

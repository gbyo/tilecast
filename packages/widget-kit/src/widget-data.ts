/**
 * Shared Widget data helpers for Widgets V2 data-display components.
 *
 * The chart, metrics, progress, spotlight, and timeline runtimes parse the
 * same author shapes (field references, optional numbers/booleans) and read
 * the same prepared documents (named datasets, field maps, single-object
 * values). They import these helpers from @tilecast/widget-kit instead of
 * carrying their own copies.
 */
import type {
  WidgetDataDocument,
  WidgetDataset,
  WidgetField,
  WidgetValue,
} from "@tilecast/widget-sdk";

export const MAX_CONFIG_FIELD_LENGTH = 120;

/** An author field reference: "" when unmapped, null when invalid. */
export function fieldRef(
  value: unknown,
  maximum: number = MAX_CONFIG_FIELD_LENGTH,
): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maximum) return null;
  return value;
}

/** An optional finite number: null when absent, undefined when invalid. */
export function optionalFinite(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

/** An optional boolean with a fallback for absent values. */
export function optionalBoolean(
  value: unknown,
  fallback: boolean,
): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === "boolean" ? value : null;
}

/** Index a dataset's field list by key. */
export function fieldsByKey(
  dataset: Pick<WidgetDataset, "fields">,
): Readonly<Record<string, WidgetField>> {
  const fields: Record<string, WidgetField> = {};
  for (const field of dataset.fields ?? []) fields[field.key] = field;
  return fields;
}

/**
 * The dataset a Widget should read. A non-empty name wins when it names a
 * records or time-series dataset; otherwise the first records dataset wins,
 * then the first time-series dataset. A records source never shadows an
 * explicit time-series choice.
 */
export function pickDataset(
  document: WidgetDataDocument,
  name: string,
): WidgetDataset | null {
  if (name !== "") {
    const named = document.datasets.find(
      (dataset) =>
        dataset.id === name &&
        (dataset.kind === "records" || dataset.kind === "time_series"),
    );
    if (named) return named;
  }
  return (
    document.datasets.find((dataset) => dataset.kind === "records") ??
    document.datasets.find((dataset) => dataset.kind === "time_series") ??
    null
  );
}

/** The first single-object value in a document, with its field map. */
export function firstObjectValues(document: WidgetDataDocument): {
  values: Readonly<Record<string, WidgetValue>>;
  fields: Readonly<Record<string, WidgetField>>;
} | null {
  for (const dataset of document.datasets) {
    if (dataset.kind !== "object") continue;
    const object = dataset.value?.object;
    if (!object) return null;
    return { values: object, fields: fieldsByKey(dataset) };
  }
  return null;
}

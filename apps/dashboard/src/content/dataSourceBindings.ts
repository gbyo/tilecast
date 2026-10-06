/**
 * How a definition's Data Source controls relate to each other and to the
 * records they read: which source a field mapping reads, which sources a
 * configuration references, which saved sources and providers a control
 * accepts, and the format guide shown beside it. Pure functions, shared by
 * the Widget editor, preview, and the Data Source forms.
 */
import type { TFunction } from "i18next";
import type {
  ContentDefinitionField,
  DataSource,
  DataSourceDefinition,
} from "../api/types";
import type { DataFormatGuide } from "./DataSourcePicker";

type Values = Record<string, unknown>;

function fieldText(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

// resolveDataSourceKey returns which `data_source` control supplies the field list for a
// `data_source_field` control. An explicit `dataSourceKey` wins; otherwise a definition with
// exactly one Data Source control is unambiguous. When a definition declares several and the
// field does not say which, there is no correct answer, so no fields are offered rather than
// silently listing another source's schema. Nested repeating-group items carry no
// `data_source` sibling, so a keyless nested field falls back to the root's single source.
export function resolveDataSourceKey(
  field: ContentDefinitionField,
  fields: readonly ContentDefinitionField[],
  rootFields?: readonly ContentDefinitionField[],
): string | undefined {
  if (field.dataSourceKey) return field.dataSourceKey;
  const sourceFields = fields.filter(
    (candidate) => candidate.control === "data_source",
  );
  if (sourceFields.length === 1) return sourceFields[0]?.key;
  if (sourceFields.length === 0 && rootFields) {
    // Collect nested sources too: a group may itself declare the source.
    const collectNested = (
      list: readonly ContentDefinitionField[],
    ): ContentDefinitionField[] => {
      const found: ContentDefinitionField[] = [];
      for (const candidate of list) {
        if (candidate.control === "data_source") found.push(candidate);
        if (candidate.itemFields?.length)
          found.push(...collectNested(candidate.itemFields));
      }
      return found;
    };
    const allRoot = collectNested(rootFields);
    if (allRoot.length === 1) return allRoot[0]?.key;
  }
  return undefined;
}

// dataSourceKeysIn lists every Data Source referenced by a configuration, so callers can
// resolve, preview, and validate all of them rather than assuming a single `dataSourceId`.
//
// Fields nest: a `repeating_group` carries `itemFields`, and a Data Source control may live inside
// one. Missing those would under-count the sources a Widget depends on, so preview and save gating
// would pass while data was still in flight.
export function dataSourceKeysIn(
  fields: readonly ContentDefinitionField[],
  value: Values,
): string[] {
  const ids: string[] = [];
  for (const field of fields) {
    if (field.control === "data_source") {
      const id = fieldText(value[field.key]);
      if (id) ids.push(id);
      continue;
    }
    if (field.control !== "repeating_group" || !field.itemFields?.length)
      continue;
    const items = Array.isArray(value[field.key])
      ? (value[field.key] as Values[])
      : [];
    for (const item of items)
      ids.push(...dataSourceKeysIn(field.itemFields, item ?? {}));
  }
  return [...new Set(ids)];
}

// acceptsDefinition applies a `data_source` control's declared acceptance rules to a provider
// definition: the dataset kind it renders and any output fields it requires.
function acceptsDefinition(
  field: ContentDefinitionField,
  definition: DataSourceDefinition,
) {
  if (
    field.acceptedDataSourceKinds?.length &&
    !field.acceptedDataSourceKinds.includes(definition.outputSchema.kind)
  )
    return false;
  return Object.entries(field.requiredFields ?? {}).every(([key, type]) =>
    definition.outputSchema.fields.some(
      (output) => output.key === key && output.type === type,
    ),
  );
}

export function compatibleSources(
  field: ContentDefinitionField,
  dataSources: readonly DataSource[],
  dataSourceDefinitions: readonly DataSourceDefinition[],
) {
  return dataSources.filter((source) => {
    const definition = dataSourceDefinitions.find(
      (candidate) => candidate.id === source.provider,
    );
    return definition ? acceptsDefinition(field, definition) : false;
  });
}

// creatableProviders narrows what the picker's Connect flow offers to providers this field would
// actually accept, so an author cannot create a Data Source the field then rejects.
export function creatableProviders(
  field: ContentDefinitionField,
  dataSourceDefinitions: readonly DataSourceDefinition[],
) {
  return dataSourceDefinitions
    .filter((definition) => acceptsDefinition(field, definition))
    .map((definition) => definition.id);
}

function exampleValue(key: string, type: string) {
  const normalized = key.toLowerCase();
  if (type === "datetime")
    return normalized.includes("end")
      ? "2026-08-24T09:51:00-04:00"
      : "2026-08-24T09:03:00-04:00";
  if (type === "date") return "2026-08-24";
  if (type === "number" || type === "currency") return 94.6;
  if (type === "integer") return 42;
  if (type === "percent") return 85;
  if (type === "boolean") return true;
  if (normalized.includes("title") || normalized.includes("name"))
    return "Period 2";
  if (normalized.includes("detail") || normalized.includes("description"))
    return "East wing";
  return "Example text";
}

function preferredExampleType(key: string, types: string[]) {
  const normalized = key.toLowerCase();
  if (
    (normalized.includes("date") ||
      normalized.includes("time") ||
      normalized.includes("start") ||
      normalized.includes("end")) &&
    types.includes("datetime")
  )
    return "datetime";
  return types[0] ?? "text";
}

type WidgetsT = TFunction<["content", "common"], undefined>;

// collectSelectableFields lists every data_source_field control that reads
// from the named source, including controls nested inside repeating groups.
// An explicit dataSourceKey wins; otherwise the level with exactly one Data
// Source control is unambiguous, mirroring resolveDataSourceKey. A keyless
// nested field with no local source falls back to the root single source.
function collectSelectableFields(
  fields: readonly ContentDefinitionField[],
  sourceKey: string,
  rootFields: readonly ContentDefinitionField[] = fields,
): ContentDefinitionField[] {
  const sourceFields = fields.filter(
    (candidate) => candidate.control === "data_source",
  );
  const rootSources: ContentDefinitionField[] = [];
  const collectSources = (list: readonly ContentDefinitionField[]): void => {
    for (const candidate of list) {
      if (candidate.control === "data_source") rootSources.push(candidate);
      if (candidate.itemFields?.length) collectSources(candidate.itemFields);
    }
  };
  collectSources(rootFields);
  const rootSingle =
    rootSources.length === 1 && rootSources[0]?.key === sourceKey;
  const selectable: ContentDefinitionField[] = [];
  for (const candidate of fields) {
    if (
      candidate.control === "data_source_field" &&
      (candidate.dataSourceKey === sourceKey ||
        (!candidate.dataSourceKey &&
          (sourceFields.length === 1 ||
            (sourceFields.length === 0 && rootSingle))))
    ) {
      selectable.push(candidate);
    }
    if (
      candidate.control === "repeating_group" &&
      candidate.itemFields?.length
    ) {
      selectable.push(
        ...collectSelectableFields(candidate.itemFields, sourceKey, rootFields),
      );
    }
  }
  return selectable;
}

export function dataFormatGuideFor(
  sourceField: ContentDefinitionField,
  fields: readonly ContentDefinitionField[],
  t?: WidgetsT,
): DataFormatGuide {
  const selectableFields = collectSelectableFields(fields, sourceField.key);
  const requirements: DataFormatGuide["fields"] = Object.entries(
    sourceField.requiredFields ?? {},
  ).map(([key, type]) => ({
    key,
    label: key.replaceAll("_", " "),
    types: [type],
    required: true,
  }));
  for (const field of selectableFields) {
    const types = field.dataSourceFieldTypes?.length
      ? field.dataSourceFieldTypes
      : ["text", "number", "date", "datetime"];
    requirements.push({
      key:
        typeof field.default === "string" && field.default
          ? field.default
          : field.key.replace(/Field$/, ""),
      label: field.label,
      types,
      required: field.required,
    });
  }
  // One entry per source key: a required field and a mapped control can describe
  // the same key under different labels, and the example below is keyed by key alone.
  const deduplicated: DataFormatGuide["fields"] = [];
  const byKey = new Map<string, DataFormatGuide["fields"][number]>();
  for (const field of requirements) {
    const merged = byKey.get(field.key);
    if (!merged) {
      const entry = { ...field, types: [...field.types] };
      byKey.set(field.key, entry);
      deduplicated.push(entry);
      continue;
    }
    for (const type of field.types)
      if (!merged.types.includes(type)) merged.types.push(type);
    merged.required = merged.required || field.required;
  }
  const kinds = sourceField.acceptedDataSourceKinds?.length
    ? sourceField.acceptedDataSourceKinds
    : ["records"];
  const shape = kinds
    .map((kind) =>
      kind === "records"
        ? (t?.("widgets.form.guide.shapeRecords") ?? "record rows")
        : kind === "object"
          ? (t?.("widgets.form.guide.shapeObject") ?? "a single object")
          : kind === "time_series"
            ? (t?.("widgets.form.guide.shapeTimeSeries") ?? "a time series")
            : kind.replaceAll("_", " "),
    )
    .join(t?.("widgets.form.guide.or") ?? " or ");
  const example = Object.fromEntries(
    deduplicated.map((field) => {
      const type = preferredExampleType(field.key, field.types);
      return [field.key, exampleValue(field.key, type)];
    }),
  );
  if (Object.keys(example).length === 0)
    example.title =
      t?.("widgets.form.guide.exampleTitle") ?? "Example information";
  return {
    shape: shape[0]!.toUpperCase() + shape.slice(1),
    summary:
      deduplicated.length > 0
        ? (t?.("widgets.form.guide.summaryMapped") ??
          "Use these field roles and types. Field names can differ because you map them below.")
        : (t?.("widgets.form.guide.summaryUnmapped") ??
          "Use one item per row; after connecting the source, choose which fields appear."),
    fields: deduplicated,
    example,
  };
}

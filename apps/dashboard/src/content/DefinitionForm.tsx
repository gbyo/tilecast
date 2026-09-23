import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../api/client";
import type {
  ContentDefinitionField,
  DataSource,
  DataSourceDefinition,
  DataSourceField,
} from "../api/types";
import { Select } from "../components/legacy-ui";
import { DataSourcePicker, type DataFormatGuide } from "./DataSourcePicker";

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
// silently listing another source's schema.
export function resolveDataSourceKey(
  field: ContentDefinitionField,
  fields: ContentDefinitionField[],
): string | undefined {
  if (field.dataSourceKey) return field.dataSourceKey;
  const sourceFields = fields.filter(
    (candidate) => candidate.control === "data_source",
  );
  return sourceFields.length === 1 ? sourceFields[0]?.key : undefined;
}

// dataSourceKeysIn lists every Data Source referenced by a configuration, so callers can
// resolve, preview, and validate all of them rather than assuming a single `dataSourceId`.
//
// Fields nest: a `repeating_group` carries `itemFields`, and a Data Source control may live inside
// one. Missing those would under-count the sources a Widget depends on, so preview and save gating
// would pass while data was still in flight.
export function dataSourceKeysIn(
  fields: ContentDefinitionField[],
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

export function DefinitionForm({
  fields,
  value,
  onChange,
  readOnly = false,
  csrf,
}: {
  fields: ContentDefinitionField[];
  value: Values;
  onChange: (value: Values) => void;
  readOnly?: boolean;
  csrf?: string;
}) {
  const needsDataSources = fields.some(
    (field) =>
      field.control === "data_source" || field.control === "data_source_field",
  );
  const dataSources = useQuery({
    queryKey: ["definition-form-data-sources"],
    queryFn: () =>
      api.listDataSources(
        new URLSearchParams({ page: "1", pageSize: "100", sort: "name" }),
      ),
    enabled: needsDataSources,
  });
  const definitions = useQuery({
    queryKey: ["content-definitions"],
    queryFn: api.contentDefinitions,
  });
  const assets = useQuery({
    queryKey: ["definition-form-media-assets"],
    queryFn: () =>
      api.assets(
        new URLSearchParams({
          page: "1",
          pageSize: "100",
          status: "ready",
          sort: "name",
        }),
      ),
    enabled: fields.some((field) => field.control === "media_asset"),
  });
  const set = (key: string, next: unknown) =>
    onChange({ ...value, [key]: next });

  return (
    <div className="form-grid">
      {fields.map((field) => (
        <DefinitionControl
          key={field.key}
          field={field}
          fields={fields}
          values={value}
          value={value[field.key]}
          setValue={(next) => set(field.key, next)}
          readOnly={readOnly}
          csrf={csrf}
          dataSources={dataSources.data?.items ?? []}
          dataSourceDefinitions={definitions.data?.dataSources ?? []}
          assets={assets.data?.items ?? []}
        />
      ))}
    </div>
  );
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

function compatibleSources(
  field: ContentDefinitionField,
  dataSources: DataSource[],
  dataSourceDefinitions: DataSourceDefinition[],
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
function creatableProviders(
  field: ContentDefinitionField,
  dataSourceDefinitions: DataSourceDefinition[],
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

export function dataFormatGuideFor(
  sourceField: ContentDefinitionField,
  fields: ContentDefinitionField[],
): DataFormatGuide {
  const sourceFields = fields.filter(
    (candidate) => candidate.control === "data_source",
  );
  const selectableFields = fields.filter(
    (candidate) =>
      candidate.control === "data_source_field" &&
      (candidate.dataSourceKey === sourceField.key ||
        (!candidate.dataSourceKey && sourceFields.length === 1)),
  );
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
        ? "record rows"
        : kind === "object"
          ? "a single object"
          : kind === "time_series"
            ? "a time series"
            : kind.replaceAll("_", " "),
    )
    .join(" or ");
  const example = Object.fromEntries(
    deduplicated.map((field) => {
      const type = preferredExampleType(field.key, field.types);
      return [field.key, exampleValue(field.key, type)];
    }),
  );
  if (Object.keys(example).length === 0) example.title = "Example information";
  return {
    shape: shape[0]!.toUpperCase() + shape.slice(1),
    summary:
      deduplicated.length > 0
        ? "Use these field roles and types. Field names can differ because you map them below."
        : "Use one item per row; after connecting the source, choose which fields appear.",
    fields: deduplicated,
    example,
  };
}

function DefinitionControl({
  field,
  fields,
  values,
  value,
  setValue,
  readOnly,
  csrf,
  dataSources,
  dataSourceDefinitions,
  assets,
}: {
  field: ContentDefinitionField;
  fields: ContentDefinitionField[];
  values: Values;
  value: unknown;
  setValue: (value: unknown) => void;
  readOnly: boolean;
  csrf?: string;
  dataSources: DataSource[];
  dataSourceDefinitions: DataSourceDefinition[];
  assets: { id: string; name: string; type: string }[];
}) {
  // A field picker resolves against the source chosen by its own `data_source` control, not a
  // hardcoded `dataSourceId`, so a definition may reference several Data Sources.
  const fieldSourceKey =
    field.control === "data_source_field"
      ? resolveDataSourceKey(field, fields)
      : undefined;
  const fieldSourceID = fieldSourceKey ? fieldText(values[fieldSourceKey]) : "";
  const fieldSource = useQuery({
    queryKey: ["definition-form-data-source", fieldSourceID],
    queryFn: () => api.getDataSource(fieldSourceID),
    enabled: Boolean(fieldSourceID),
  });
  const common = {
    disabled: readOnly,
    required: field.required,
  };
  const label = (
    <span className="field__label">
      {field.label}
      {field.required ? " *" : ""}
    </span>
  );
  if (field.control === "data_source")
    return (
      <DataSourcePicker
        label={field.label}
        description={field.description}
        value={fieldText(value)}
        sources={compatibleSources(field, dataSources, dataSourceDefinitions)}
        createProviders={creatableProviders(field, dataSourceDefinitions)}
        formatGuide={dataFormatGuideFor(field, fields)}
        csrf={csrf}
        disabled={readOnly}
        required={field.required}
        onChange={setValue}
      />
    );
  if (field.control === "boolean")
    return (
      <div className="field definition-switch-field">
        {label}
        <button
          type="button"
          role="switch"
          aria-label={field.label}
          aria-checked={!!value}
          className="setting-switch"
          disabled={readOnly}
          onClick={() => setValue(!value)}
        >
          <span aria-hidden="true" />
          <strong>{value ? "On" : "Off"}</strong>
        </button>
        {field.description && <small>{field.description}</small>}
      </div>
    );
  if (field.control === "multiline_text")
    return (
      <label className="field field--wide">
        {label}
        <textarea
          {...common}
          value={fieldText(value)}
          maxLength={field.maxLength}
          onChange={(event) => setValue(event.target.value)}
        />
        {field.description && <small>{field.description}</small>}
      </label>
    );
  if (
    field.control === "select" ||
    field.control === "data_source_field" ||
    field.control === "media_asset"
  ) {
    const options =
      field.control === "select"
        ? (field.options ?? [])
        : field.control === "data_source_field"
          ? (fieldSource.data?.fields ?? [])
              .filter(
                (sourceField: DataSourceField) =>
                  !field.dataSourceFieldTypes?.length ||
                  field.dataSourceFieldTypes.includes(sourceField.type),
              )
              .map((sourceField: DataSourceField) => ({
                value: sourceField.key,
                label: `${sourceField.label} (${sourceField.type})`,
              }))
          : assets
              .filter(
                (asset) =>
                  !field.mediaTypes?.length ||
                  field.mediaTypes.includes(asset.type),
              )
              .map((asset) => ({ value: asset.id, label: asset.name }));
    const placeholder =
      field.control === "data_source_field" && !fieldSourceID
        ? "Select a Data Source first"
        : "Select…";
    return (
      <label className="field">
        {label}
        <Select
          {...common}
          value={fieldText(value)}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="">{placeholder}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {field.description && <small>{field.description}</small>}
      </label>
    );
  }
  if (field.control === "repeating_group") {
    const items = Array.isArray(value) ? (value as Values[]) : [];
    return (
      <fieldset className="field field--wide">
        <legend>{field.label}</legend>
        {items.map((item, index) => (
          <div className="source-mapping-row" key={index}>
            <DefinitionForm
              fields={field.itemFields ?? []}
              value={item}
              readOnly={readOnly}
              csrf={csrf}
              onChange={(next) =>
                setValue(
                  items.map((current, currentIndex) =>
                    currentIndex === index ? next : current,
                  ),
                )
              }
            />
            {!readOnly && (
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${field.label} item ${index + 1}`}
                onClick={() =>
                  setValue(items.filter((_, current) => current !== index))
                }
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        ))}
        {!readOnly && items.length < (field.maximumItems ?? 0) && (
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setValue([...items, {}])}
          >
            <Plus size={15} /> Add item
          </button>
        )}
      </fieldset>
    );
  }
  const inputType =
    field.control === "number" || field.control === "integer"
      ? "number"
      : field.control === "datetime"
        ? "datetime-local"
        : field.control === "color"
          ? "color"
          : field.control === "date"
            ? "date"
            : field.control === "url"
              ? "url"
              : "text";
  return (
    <label className="field">
      {label}
      <input
        {...common}
        type={inputType}
        value={fieldText(value)}
        min={field.minimum}
        max={field.maximum}
        minLength={field.minLength}
        maxLength={field.maxLength}
        onChange={(event) =>
          setValue(
            field.control === "number" || field.control === "integer"
              ? event.target.value === ""
                ? undefined
                : Number(event.target.value)
              : field.control === "datetime" && event.target.value
                ? new Date(event.target.value).toISOString()
                : event.target.value,
          )
        }
      />
      {field.description && <small>{field.description}</small>}
    </label>
  );
}

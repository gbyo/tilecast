import { Select } from "../components/legacy-ui";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api/client";
import type {
  CalendarConfig,
  CalendarPreview,
  DataSourceDetail,
  DataSourceProvider,
  DateSelection,
  ManualColumn,
  ManualSourceConfig,
  StructuredField,
  StructuredInspection,
  StructuredValueType,
  StructuredPreview,
  StructuredSourceConfig,
  TypedRecordData,
  WeatherSourceConfig,
  TransitSourceConfig,
  CAPAlertsSourceConfig,
  AirQualitySourceConfig,
  TypedDatasetPayload,
} from "../api/types";
import { CsvSourceInput } from "./CsvSourceInput";
import { GenericDataSourceEditor } from "./GenericDefinitionEditors";

export type StructuredProvider = "rss" | "atom" | "json" | "csv";

// A mapped provider starts with an empty mapping on purpose. Guessing "title" or "/title"
// before the data has been read produces a mapping that looks configured, silently misses
// the real columns, and leaves the author to discover it in the preview. Detection fills
// these in from the connected data instead.
const emptyMapping = {
  rootList: "",
  title: "",
  subtitle: "",
  date: "",
  imageUrl: "",
  link: "",
};

const defaultStructured = (
  provider: StructuredProvider,
): StructuredSourceConfig => ({
  url: "https://",
  presentation: provider === "rss" || provider === "atom" ? "list" : "cards",
  maxItems: 20,
  fields: {
    title: true,
    subtitle: true,
    date: true,
    // Only feeds publish an author and a description; a mapped Source fills its display
    // slots from the mapping alone.
    author: provider === "rss" || provider === "atom",
    description: provider === "rss" || provider === "atom",
    image: false,
    link: false,
  },
  filterKeyword: "",
  sort: "newest",
  ...(provider === "json" ? { mapping: { ...emptyMapping } } : {}),
  ...(provider === "csv"
    ? { mapping: { ...emptyMapping }, delimiter: "" as const }
    : {}),
  filters: [],
  refreshIntervalSeconds: 900,
  stalenessLimitHours: 168,
  emptyState: "No items available",
  dateSelection: {
    enabled: false,
    dateFormat: "auto",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    mode: "today",
    excludePast: false,
    noMatchBehavior: "empty",
  },
});

const structuredFieldLabels: Record<string, string> = {
  title: "Title",
  subtitle: "Subtitle",
  date: "Date",
  author: "Author",
  description: "Description",
  image: "Image",
  link: "Link",
};

const mappingFieldLabels: Record<string, string> = {
  rootList: "Root list path",
  title: "Title",
  subtitle: "Subtitle",
  date: "Date",
  imageUrl: "Image URL",
  link: "Link",
};

const mappingPlaceholders: Record<
  StructuredProvider,
  Record<string, string>
> = {
  json: {
    rootList: "/items",
    title: "/title",
    subtitle: "/subtitle",
    date: "/date",
    imageUrl: "/image",
    link: "/link",
  },
  csv: {
    rootList: "",
    title: "title",
    subtitle: "subtitle",
    date: "date",
    imageUrl: "image_url",
    link: "link",
  },
  rss: {},
  atom: {},
};

// How long a URL or pasted payload must stay unchanged before it is read.
const detectionSettleMs = 600;

// useSettledValue returns `value` only once it has stopped changing for `delay`, so a
// control that reads an upstream source is not driven by every keystroke.
function useSettledValue<T>(value: T, delay: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

// The display slots a mapped Source can fill. Author and description exist only on feeds.
const mappedDisplayFields = [
  "title",
  "subtitle",
  "date",
  "image",
  "link",
] as const;

const mappingSlotForField: Record<string, keyof typeof emptyMapping> = {
  title: "title",
  subtitle: "subtitle",
  date: "date",
  image: "imageUrl",
  link: "link",
};

function mappingIsEmpty(mapping: StructuredSourceConfig["mapping"]) {
  if (!mapping) return true;
  return (
    !mapping.title &&
    !mapping.subtitle &&
    !mapping.date &&
    !mapping.imageUrl &&
    !mapping.link &&
    Object.keys(mapping.valueFields ?? {}).length === 0
  );
}

// A mapped Source displays exactly what it maps, so the displayed-field set is derived
// rather than being a second place to configure the same decision.
function fieldsFromMapping(
  mapping: NonNullable<StructuredSourceConfig["mapping"]>,
): StructuredSourceConfig["fields"] {
  return {
    title: Boolean(mapping.title),
    subtitle: Boolean(mapping.subtitle),
    date: Boolean(mapping.date),
    author: false,
    description: false,
    image: Boolean(mapping.imageUrl),
    link: Boolean(mapping.link),
  };
}

// StructuredDetectionNotice reports what detection found, or why it has not run. Mapping
// without it is guesswork, so its state is stated rather than left to be inferred from
// empty dropdowns.
function StructuredDetectionNotice({
  provider,
  detectable,
  inspection,
}: {
  provider: StructuredProvider;
  detectable: boolean;
  inspection: UseQueryResult<StructuredInspection>;
}) {
  const unit = provider === "csv" ? "column" : "field";
  if (!detectable)
    return (
      <p className="source-detection source-detection--pending">
        {provider === "csv"
          ? "Upload a CSV or enter a hosted CSV URL and Tilecast will read its columns."
          : "Enter the endpoint URL and Tilecast will read the fields it returns."}
      </p>
    );
  if (inspection.isPending)
    return <p className="source-detection">Reading the connected data…</p>;
  if (inspection.isError)
    return (
      <p className="source-detection source-detection--error" role="alert">
        {inspection.error instanceof Error
          ? inspection.error.message
          : "The connected data could not be read."}{" "}
        Map the fields by name below, or fix the connection and try again.
      </p>
    );
  if (!inspection.data) return null;
  const detected = inspection.data;
  return (
    <p className="source-detection source-detection--ready">
      {detected.fields.length} {unit}
      {detected.fields.length === 1 ? "" : "s"} detected in {detected.rowCount}{" "}
      row{detected.rowCount === 1 ? "" : "s"}
      {detected.delimiter
        ? ` · ${delimiterLabels[detected.delimiter] ?? "detected"}-delimited`
        : ""}
      .
    </p>
  );
}

// The Server caps a mapping at a dozen values, keeping both the form and the record it
// produces readable.
const maximumValueFields = 12;

const valueTypeOptions: { value: StructuredValueType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "datetime", label: "Date & time" },
  { value: "url", label: "URL" },
];

const delimiterLabels: Record<string, string> = {
  ",": "comma",
  ";": "semicolon",
  "\t": "tab",
  "|": "pipe",
};

// MappingSelect offers the detected fields, keeps a value the data no longer contains
// visible rather than silently dropping it, and falls back to free entry when nothing has
// been detected yet.
function MappingSelect({
  label,
  value,
  fields,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  fields: StructuredField[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const known = fields.some((field) => field.key === value);
  if (fields.length === 0)
    return (
      <label className="field">
        <span className="field__label">{label}</span>
        <input
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <Select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Not used</option>
        {fields.map((field) => (
          <option key={field.key} value={field.key}>
            {field.samples.length > 0
              ? `${field.label} — ${field.samples[0]}`
              : field.label}
          </option>
        ))}
        {value && !known && <option value={value}>{value} (not found)</option>}
      </Select>
    </label>
  );
}

export function StructuredDataSourceEditor({
  provider,
  dataSource,
  csrf,
  readOnly = false,
  onClose,
  onSaved,
  page = false,
}: {
  provider: StructuredProvider;
  dataSource?: DataSourceDetail;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (dataSource: DataSourceDetail) => void;
  page?: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(dataSource?.name ?? "");
  const [description, setDescription] = useState(dataSource?.description ?? "");
  const configured = dataSource?.configuration as
    StructuredSourceConfig | undefined;
  const defaults = defaultStructured(provider);
  const [configuration, setConfiguration] = useState<StructuredSourceConfig>({
    ...defaults,
    ...configured,
    dateSelection: {
      ...defaults.dateSelection,
      ...configured?.dateSelection,
    },
  });
  const [preview, setPreview] = useState<StructuredPreview>();
  const [previewDate, setPreviewDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const diagnostics = useQuery({
    queryKey: ["data-source-diagnostics", dataSource?.id],
    queryFn: () => api.dataSourceDiagnostics(dataSource!.id),
    enabled: Boolean(dataSource),
  });
  const save = useMutation({
    mutationFn: () => {
      const input = { provider, name, description, configuration };
      return dataSource
        ? api.updateDataSource(dataSource.id, input, csrf)
        : api.createDataSource(input, csrf);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      onSaved(saved);
    },
  });
  const previewMutation = useMutation({
    mutationFn: () =>
      api.previewDataSource(
        provider,
        configuration,
        csrf,
        configuration.dateSelection.enabled ? previewDate : undefined,
      ) as Promise<StructuredPreview>,
    onSuccess: setPreview,
  });
  const mapping = configuration.mapping;
  const mapped = provider === "json" || provider === "csv";
  const updateConfiguration = (patch: Partial<StructuredSourceConfig>) =>
    setConfiguration((current) => ({ ...current, ...patch }));
  const updateMapping = (
    key: keyof NonNullable<StructuredSourceConfig["mapping"]>,
    value: string | Record<string, string>,
  ) =>
    setConfiguration((current) => {
      const next = { ...(current.mapping ?? emptyMapping), [key]: value };
      return {
        ...current,
        mapping: next,
        // A mapped Source shows what it maps, so the two stay in agreement without a
        // second control asking the author the same question again.
        fields: mapped ? fieldsFromMapping(next) : current.fields,
      };
    });

  // Field detection reads the connected data itself. It is keyed on what identifies the
  // connection so switching file, URL, or delimiter re-detects, and an unchanged
  // connection is answered from cache rather than refetched.
  const connection = configuration.uploaded
    ? `upload:${configuration.uploadedContent?.length ?? 0}:${(configuration.uploadedContent ?? "").slice(0, 200)}`
    : `url:${configuration.url ?? ""}`;
  // A half-typed URL passes the shape test — "https://exa.o" does — so keying the query on
  // the live value would fetch an unintended host once per keystroke. Detection waits for
  // the input to settle instead.
  const settledConnection = useSettledValue(connection, detectionSettleMs);
  // The query only runs once the live connection matches the settled one, so the latest
  // configuration is by definition the one that settled.
  const latestConfiguration = useRef(configuration);
  useEffect(() => {
    latestConfiguration.current = configuration;
  }, [configuration]);
  const detectable =
    Boolean(csrf) &&
    (configuration.uploaded
      ? Boolean(configuration.uploadedContent)
      : /^https:\/\/.+\..+/.test((configuration.url ?? "").trim()));
  // A saved CSV upload keeps its bytes on the Server, so reopening that Source detects by
  // id rather than sending a configuration that no longer carries the data.
  const savedUpload = Boolean(
    dataSource && configuration.uploaded && !configuration.uploadedContent,
  );
  const inspection = useQuery({
    queryKey: [
      "data-source-inspection",
      provider,
      savedUpload ? `saved:${dataSource?.id}` : settledConnection,
      configuration.delimiter ?? "",
    ],
    queryFn: () =>
      savedUpload
        ? api.inspectSavedDataSource(dataSource!.id)
        : api.inspectDataSource(provider, latestConfiguration.current, csrf),
    // A saved upload has nothing to type, so it detects immediately.
    enabled: savedUpload || (detectable && connection === settledConnection),
    retry: false,
    staleTime: 60_000,
  });
  const detectedFields = inspection.data?.fields ?? [];
  // A mapped value is a path and a declared type, so the two maps are always written
  // together: a rename or a removal that touched only one of them would leave a type
  // stranded on a value that no longer exists, which the Server rejects on save.
  const updateValues = (
    values: Record<string, string>,
    types: Record<string, StructuredValueType>,
  ) =>
    setConfiguration((current) => {
      const next = {
        ...(current.mapping ?? emptyMapping),
        valueFields: values,
        valueFieldTypes: types,
      };
      return {
        ...current,
        mapping: next,
        fields: mapped ? fieldsFromMapping(next) : current.fields,
      };
    });
  const valueMaps = () => ({
    values: { ...(mapping?.valueFields ?? {}) },
    types: { ...(mapping?.valueFieldTypes ?? {}) },
  });
  // Detection already knows what a field holds, so pointing a value at one types it. An
  // author who has chosen a type keeps it: the data is evidence, not a correction.
  const setValueField = (label: string, path: string) => {
    const { values, types } = valueMaps();
    values[label] = path;
    const detected = detectedFields.find((field) => field.key === path);
    if (detected && !types[label]) types[label] = detected.type;
    updateValues(values, types);
  };
  const setValueFieldType = (label: string, type: StructuredValueType) => {
    const { values, types } = valueMaps();
    types[label] = type;
    updateValues(values, types);
  };
  const renameValueField = (label: string, renamed: string) => {
    const { values, types } = valueMaps();
    // Rebuilt in order so a rename leaves the row where the author is typing.
    const nextValues: Record<string, string> = {};
    const nextTypes: Record<string, StructuredValueType> = {};
    for (const [key, path] of Object.entries(values)) {
      const name = key === label ? renamed : key;
      nextValues[name] = path;
      const type = types[key];
      if (type) nextTypes[name] = type;
    }
    updateValues(nextValues, nextTypes);
  };
  // A Source saved before its times were mapped, or one whose author skipped them, cannot
  // reach the suggestion: that applies only to a mapping with nothing in it yet. Detection
  // already knows which fields are timestamps, so it offers them as one deliberate action.
  const unmappedTimestamps = detectedFields.filter(
    (field) =>
      field.type === "datetime" &&
      !Object.values(mapping?.valueFields ?? {}).includes(field.key) &&
      field.key !== mapping?.title &&
      field.key !== mapping?.subtitle,
  );
  const addTimestampValues = () => {
    const { values, types } = valueMaps();
    for (const field of unmappedTimestamps) {
      if (Object.keys(values).length >= maximumValueFields) break;
      values[field.label] = field.key;
      types[field.label] = "datetime";
    }
    updateValues(values, types);
  };
  const removeValueField = (label: string) => {
    const { values, types } = valueMaps();
    delete values[label];
    delete types[label];
    updateValues(values, types);
  };
  const suggested = inspection.data?.suggested;
  const suggestionKey = `${connection}:${JSON.stringify(suggested ?? null)}`;
  const appliedSuggestion = useRef("");
  useEffect(() => {
    // The suggestion is a starting point, never an override: it is applied only while the
    // mapping is still empty, and only once per detection result.
    if (!mapped || !suggested || appliedSuggestion.current === suggestionKey)
      return;
    appliedSuggestion.current = suggestionKey;
    setConfiguration((current) => {
      if (!mappingIsEmpty(current.mapping)) return current;
      // The mapping is empty here, so the suggested values (detected timestamps the
      // display slots cannot carry) replace nothing the author entered.
      const next = { ...(current.mapping ?? emptyMapping), ...suggested };
      return { ...current, mapping: next, fields: fieldsFromMapping(next) };
    });
  }, [mapped, suggested, suggestionKey]);

  const available = inspection.data?.available;
  const availableKey = `${connection}:${JSON.stringify(available ?? null)}`;
  const appliedAvailable = useRef("");
  useEffect(() => {
    // A feed field that this feed does not publish would render as blank space. Turning it
    // off keeps the stored configuration honest about what the Widget will actually show.
    if (mapped || !available || appliedAvailable.current === availableKey)
      return;
    appliedAvailable.current = availableKey;
    setConfiguration((current) => ({
      ...current,
      fields: {
        title: current.fields.title && available.title,
        subtitle: current.fields.subtitle && available.subtitle,
        date: current.fields.date && available.date,
        author: current.fields.author && available.author,
        description: current.fields.description && available.description,
        image: current.fields.image && available.image,
        link: current.fields.link && available.link,
      },
    }));
  }, [mapped, available, availableKey]);
  return (
    <div className="details-backdrop" role={page ? undefined : "presentation"}>
      <section
        className="source-editor"
        role={page ? undefined : "dialog"}
        aria-modal={page ? undefined : true}
        aria-labelledby="structured-source-title"
      >
        <header>
          <div>
            <h2 id="structured-source-title">
              {dataSource ? "Edit" : "Create"} {provider.toUpperCase()} Data
              Source
            </h2>
            <p>Fetched data is sanitized and cached for offline playback.</p>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="source-editor__body">
          <label className="field">
            <span className="field__label">Name</span>
            <input
              value={name}
              disabled={readOnly}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">Description</span>
            <input
              value={description}
              disabled={readOnly}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {provider === "csv" && (
            <CsvSourceInput
              configuration={configuration}
              readOnly={readOnly}
              onChange={updateConfiguration}
            />
          )}
          {provider !== "csv" && (
            <label className="field">
              <span className="field__label">
                {provider === "json" ? "API endpoint URL" : "Feed URL"}
              </span>
              <input
                type="url"
                value={configuration.url ?? ""}
                placeholder={
                  provider === "json"
                    ? "https://api.example.org/items"
                    : "https://example.org/feed.xml"
                }
                disabled={readOnly}
                onChange={(e) =>
                  setConfiguration((c) => ({
                    ...c,
                    url: e.target.value,
                    uploadedContent: undefined,
                    uploaded: false,
                  }))
                }
              />
            </label>
          )}
          <div className="form-grid form-grid--2">
            <label className="field">
              <span className="field__label">Presentation</span>
              <Select
                value={configuration.presentation}
                disabled={readOnly}
                onChange={(e) =>
                  setConfiguration((c) => ({
                    ...c,
                    presentation: e.target
                      .value as StructuredSourceConfig["presentation"],
                  }))
                }
              >
                <option value="list">List</option>
                <option value="agenda">Agenda</option>
                <option value="cards">Cards</option>
                <option value="ticker">Ticker</option>
              </Select>
            </label>
            <label className="field">
              <span className="field__label">Maximum items</span>
              <input
                type="number"
                min="1"
                max="200"
                value={configuration.maxItems}
                disabled={readOnly}
                onChange={(e) =>
                  setConfiguration((c) => ({
                    ...c,
                    maxItems: Number(e.target.value),
                  }))
                }
              />
            </label>
          </div>
          {/* Feeds publish a fixed record, so the author chooses which parts of it to
              show — but only from the parts this feed actually carries. Mapped Sources
              have no such list: what they map is what they display. */}
          {!mapped && (
            <fieldset>
              <legend>Displayed fields</legend>
              <div className="checkbox-grid">
                {(
                  Object.keys(configuration.fields) as Array<
                    keyof StructuredSourceConfig["fields"]
                  >
                )
                  .filter(
                    (field) =>
                      !inspection.data ||
                      inspection.data.available[field] ||
                      configuration.fields[field],
                  )
                  .map((field) => (
                    <label key={field}>
                      <input
                        type="checkbox"
                        checked={configuration.fields[field]}
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            fields: {
                              ...current.fields,
                              [field]: event.target.checked,
                            },
                          }))
                        }
                      />
                      <span>{structuredFieldLabels[field] ?? field}</span>
                    </label>
                  ))}
              </div>
              {inspection.data && (
                <small>
                  {inspection.data.rowCount} item
                  {inspection.data.rowCount === 1 ? "" : "s"} read from this
                  feed. Fields it does not publish are not listed.
                </small>
              )}
            </fieldset>
          )}
          <div className="form-grid form-grid--2">
            <label className="field">
              <span className="field__label">Keyword filter</span>
              <input
                value={configuration.filterKeyword ?? ""}
                disabled={readOnly}
                onChange={(e) =>
                  setConfiguration((c) => ({
                    ...c,
                    filterKeyword: e.target.value,
                  }))
                }
              />
            </label>
            <label className="field">
              <span className="field__label">Sort</span>
              <Select
                value={configuration.sort}
                disabled={readOnly}
                onChange={(e) =>
                  setConfiguration((c) => ({
                    ...c,
                    sort: e.target.value as StructuredSourceConfig["sort"],
                  }))
                }
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="title">Title</option>
                <option value="source">Original order</option>
              </Select>
            </label>
          </div>
          {(provider === "json" || provider === "csv") && mapping && (
            <>
              <fieldset>
                <legend>Field mapping</legend>
                <StructuredDetectionNotice
                  provider={provider}
                  detectable={detectable}
                  inspection={inspection}
                />
                {provider === "json" && (
                  <label className="field">
                    <span className="field__label">Root list path</span>
                    <input
                      value={mapping.rootList}
                      placeholder="/items"
                      disabled={readOnly}
                      onChange={(e) =>
                        updateMapping("rootList", e.target.value)
                      }
                    />
                  </label>
                )}
                <div className="form-grid form-grid--2">
                  {mappedDisplayFields.map((field) => {
                    const key = mappingSlotForField[field]!;
                    return (
                      <MappingSelect
                        key={key}
                        label={mappingFieldLabels[key] ?? key}
                        value={mapping[key]}
                        fields={detectedFields}
                        placeholder={mappingPlaceholders[provider][key]}
                        disabled={readOnly}
                        onChange={(value) => updateMapping(key, value)}
                      />
                    );
                  })}
                </div>
                {provider === "csv" && (
                  <label className="field">
                    <span className="field__label">Delimiter</span>
                    <Select
                      value={configuration.delimiter ?? ""}
                      disabled={readOnly}
                      onChange={(e) =>
                        setConfiguration((c) => ({
                          ...c,
                          delimiter: e.target
                            .value as StructuredSourceConfig["delimiter"],
                        }))
                      }
                    >
                      <option value="">Detect</option>
                      <option value=",">Comma</option>
                      <option value=";">Semicolon</option>
                      <option value="\t">Tab</option>
                      <option value="|">Pipe</option>
                    </Select>
                  </label>
                )}
                <div className="source-mapping-list">
                  <strong>Optional values</strong>
                  <small>
                    A Widget offers a value only where its type fits: a start
                    and end time have to be typed Date &amp; time before a
                    schedule Widget can select them.
                  </small>
                  {Object.entries(mapping.valueFields ?? {}).map(
                    ([label, path]) => (
                      <div
                        className="source-mapping-row source-mapping-row--value"
                        key={label}
                      >
                        <input
                          aria-label="Value label"
                          value={label}
                          disabled={readOnly}
                          onChange={(event) =>
                            renameValueField(label, event.target.value)
                          }
                        />
                        <input
                          aria-label="Value path or column"
                          value={path}
                          disabled={readOnly}
                          onChange={(event) =>
                            setValueField(label, event.target.value)
                          }
                        />
                        <Select
                          aria-label={`${label} type`}
                          value={mapping.valueFieldTypes?.[label] ?? "text"}
                          disabled={readOnly}
                          onChange={(event) =>
                            setValueFieldType(
                              label,
                              event.target.value as StructuredValueType,
                            )
                          }
                        >
                          {valueTypeOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </Select>
                        <button
                          className="icon-button"
                          aria-label={`Remove ${label}`}
                          disabled={readOnly}
                          onClick={() => removeValueField(label)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ),
                  )}
                  {!readOnly &&
                    unmappedTimestamps.length > 0 &&
                    Object.keys(mapping.valueFields ?? {}).length <
                      maximumValueFields && (
                      <button
                        type="button"
                        className="button button--quiet"
                        onClick={addTimestampValues}
                      >
                        <Plus size={15} /> Add {unmappedTimestamps.length}{" "}
                        detected time field
                        {unmappedTimestamps.length === 1 ? "" : "s"}
                      </button>
                    )}
                  {!readOnly &&
                    Object.keys(mapping.valueFields ?? {}).length <
                      maximumValueFields && (
                      <button
                        type="button"
                        className="button button--quiet"
                        onClick={() =>
                          setValueField(
                            `Value ${Object.keys(mapping.valueFields ?? {}).length + 1}`,
                            provider === "json" ? "/value" : "value",
                          )
                        }
                      >
                        <Plus size={15} /> Add value
                      </button>
                    )}
                </div>
              </fieldset>
              <fieldset>
                <legend>Date-aware selection</legend>
                <label className="switch-row">
                  <input
                    type="checkbox"
                    checked={configuration.dateSelection.enabled}
                    disabled={readOnly}
                    onChange={(event) =>
                      setConfiguration((current) => ({
                        ...current,
                        dateSelection: {
                          ...current.dateSelection,
                          enabled: event.target.checked,
                        },
                      }))
                    }
                  />
                  <span>
                    <strong>Select records by local date</strong>
                    <small>
                      The Player reevaluates cached records at the configured
                      local date transition.
                    </small>
                  </span>
                </label>
                {configuration.dateSelection.enabled && (
                  <>
                    <div className="form-grid form-grid--2">
                      <label className="field">
                        <span className="field__label">Date format</span>
                        <Select
                          value={configuration.dateSelection.dateFormat}
                          disabled={readOnly}
                          onChange={(event) =>
                            setConfiguration((current) => ({
                              ...current,
                              dateSelection: {
                                ...current.dateSelection,
                                dateFormat: event.target
                                  .value as StructuredSourceConfig["dateSelection"]["dateFormat"],
                              },
                            }))
                          }
                        >
                          <option value="auto">Detect</option>
                          <option value="iso_date">YYYY-MM-DD</option>
                          <option value="us_date">MM/DD/YYYY</option>
                          <option value="us_short">M/D/YYYY</option>
                          <option value="day_month_name">DD-Mon-YYYY</option>
                          <option value="rfc3339">RFC 3339</option>
                        </Select>
                      </label>
                      <label className="field">
                        <span className="field__label">Timezone</span>
                        <input
                          value={configuration.dateSelection.timezone}
                          disabled={readOnly}
                          onChange={(event) =>
                            setConfiguration((current) => ({
                              ...current,
                              dateSelection: {
                                ...current.dateSelection,
                                timezone: event.target.value,
                              },
                            }))
                          }
                        />
                      </label>
                      <label className="field">
                        <span className="field__label">Selection</span>
                        <Select
                          value={configuration.dateSelection.mode}
                          disabled={readOnly}
                          onChange={(event) =>
                            setConfiguration((current) => ({
                              ...current,
                              dateSelection: {
                                ...current.dateSelection,
                                mode: event.target
                                  .value as StructuredSourceConfig["dateSelection"]["mode"],
                              },
                            }))
                          }
                        >
                          <option value="today">Today</option>
                          <option value="tomorrow">Tomorrow</option>
                          <option value="next_available">
                            Next available date
                          </option>
                          <option value="current_week">Current week</option>
                          <option value="custom_range">
                            Custom date range
                          </option>
                        </Select>
                      </label>
                      <label className="field">
                        <span className="field__label">No match</span>
                        <Select
                          value={configuration.dateSelection.noMatchBehavior}
                          disabled={readOnly}
                          onChange={(event) =>
                            setConfiguration((current) => ({
                              ...current,
                              dateSelection: {
                                ...current.dateSelection,
                                noMatchBehavior: event.target
                                  .value as StructuredSourceConfig["dateSelection"]["noMatchBehavior"],
                              },
                            }))
                          }
                        >
                          <option value="empty">Display empty state</option>
                          <option value="fallback_text">
                            Show fallback text
                          </option>
                          <option value="next_available">
                            Show next available
                          </option>
                          <option value="hide">Hide Widget or binding</option>
                          <option value="last_known_good">
                            Use last-known-good record
                          </option>
                        </Select>
                      </label>
                    </div>
                    {configuration.dateSelection.mode === "custom_range" && (
                      <div className="form-grid form-grid--2">
                        <label className="field">
                          <span className="field__label">Start date</span>
                          <input
                            type="date"
                            value={
                              configuration.dateSelection.customStartDate ?? ""
                            }
                            disabled={readOnly}
                            onChange={(event) =>
                              setConfiguration((current) => ({
                                ...current,
                                dateSelection: {
                                  ...current.dateSelection,
                                  customStartDate: event.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                        <label className="field">
                          <span className="field__label">End date</span>
                          <input
                            type="date"
                            value={
                              configuration.dateSelection.customEndDate ?? ""
                            }
                            disabled={readOnly}
                            onChange={(event) =>
                              setConfiguration((current) => ({
                                ...current,
                                dateSelection: {
                                  ...current.dateSelection,
                                  customEndDate: event.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                      </div>
                    )}
                    {configuration.dateSelection.noMatchBehavior ===
                      "fallback_text" && (
                      <label className="field">
                        <span className="field__label">Fallback text</span>
                        <input
                          value={configuration.dateSelection.fallbackText ?? ""}
                          disabled={readOnly}
                          onChange={(event) =>
                            setConfiguration((current) => ({
                              ...current,
                              dateSelection: {
                                ...current.dateSelection,
                                fallbackText: event.target.value,
                              },
                            }))
                          }
                        />
                      </label>
                    )}
                    <label className="switch-row">
                      <input
                        type="checkbox"
                        checked={configuration.dateSelection.excludePast}
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            dateSelection: {
                              ...current.dateSelection,
                              excludePast: event.target.checked,
                            },
                          }))
                        }
                      />
                      <span>Exclude past records</span>
                    </label>
                    <label className="field">
                      <span className="field__label">Preview date</span>
                      <input
                        type="date"
                        value={previewDate}
                        onChange={(event) => setPreviewDate(event.target.value)}
                      />
                    </label>
                  </>
                )}
              </fieldset>
            </>
          )}
          <fieldset>
            <legend>Record filters</legend>
            <div className="source-mapping-list">
              {(configuration.filters ?? []).map((filter, index) => (
                <div
                  className="source-mapping-row source-mapping-row--filter"
                  key={index}
                >
                  <input
                    aria-label="Filter field"
                    value={filter.field}
                    disabled={readOnly}
                    onChange={(event) =>
                      setConfiguration((current) => ({
                        ...current,
                        filters: (current.filters ?? []).map(
                          (item, position) =>
                            position === index
                              ? { ...item, field: event.target.value }
                              : item,
                        ),
                      }))
                    }
                  />
                  <Select
                    aria-label="Filter operator"
                    value={filter.operator}
                    disabled={readOnly}
                    onChange={(event) =>
                      setConfiguration((current) => ({
                        ...current,
                        filters: (current.filters ?? []).map(
                          (item, position) =>
                            position === index
                              ? {
                                  ...item,
                                  operator: event.target.value as
                                    "equals" | "contains",
                                }
                              : item,
                        ),
                      }))
                    }
                  >
                    <option value="equals">Equals</option>
                    <option value="contains">Contains</option>
                  </Select>
                  <input
                    aria-label="Filter value"
                    value={filter.value}
                    disabled={readOnly}
                    onChange={(event) =>
                      setConfiguration((current) => ({
                        ...current,
                        filters: (current.filters ?? []).map(
                          (item, position) =>
                            position === index
                              ? { ...item, value: event.target.value }
                              : item,
                        ),
                      }))
                    }
                  />
                  <button
                    className="icon-button"
                    aria-label="Remove filter"
                    disabled={readOnly}
                    onClick={() =>
                      setConfiguration((current) => ({
                        ...current,
                        filters: (current.filters ?? []).filter(
                          (_, position) => position !== index,
                        ),
                      }))
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              {!readOnly && (configuration.filters?.length ?? 0) < 8 && (
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() =>
                    setConfiguration((current) => ({
                      ...current,
                      filters: [
                        ...(current.filters ?? []),
                        { field: "title", operator: "contains", value: "" },
                      ],
                    }))
                  }
                >
                  <Plus size={15} /> Add filter
                </button>
              )}
            </div>
          </fieldset>
          <div className="form-grid form-grid--2">
            <label className="field">
              <span className="field__label">Refresh interval</span>
              <Select
                value={configuration.refreshIntervalSeconds}
                disabled={readOnly || Boolean(configuration.uploaded)}
                onChange={(e) =>
                  setConfiguration((c) => ({
                    ...c,
                    refreshIntervalSeconds: Number(e.target.value),
                  }))
                }
              >
                <option value="300">5 minutes</option>
                <option value="900">15 minutes</option>
                <option value="3600">Hourly</option>
                <option value="21600">6 hours</option>
              </Select>
            </label>
            <label className="field">
              <span className="field__label">Empty state</span>
              <input
                value={configuration.emptyState}
                disabled={readOnly}
                onChange={(e) =>
                  setConfiguration((c) => ({
                    ...c,
                    emptyState: e.target.value,
                  }))
                }
              />
            </label>
          </div>
          {diagnostics.data && (
            <div className="source-diagnostics">
              <strong>Refresh diagnostics</strong>
              <span>
                {diagnostics.data.parseStatus} ·{" "}
                {diagnostics.data.httpResultCategory ?? "not attempted"} ·{" "}
                {diagnostics.data.availableItemCount} items
                {diagnostics.data.usingCachedData ? " · cached data" : ""}
              </span>
              <small>
                Last attempt:{" "}
                {diagnostics.data.lastAttemptedRefresh
                  ? new Date(
                      diagnostics.data.lastAttemptedRefresh,
                    ).toLocaleString()
                  : "Not yet"}
              </small>
              <small>
                Last success:{" "}
                {diagnostics.data.lastSuccessfulRefresh
                  ? new Date(
                      diagnostics.data.lastSuccessfulRefresh,
                    ).toLocaleString()
                  : "Not yet"}
              </small>
            </div>
          )}
          {preview && (
            <div className="calendar-preview">
              <strong>
                {preview.configuration.data.records.length} mapped items
              </strong>
              {preview.configuration.data.records.slice(0, 8).map((record) => (
                <article key={record.id}>
                  <strong>{record.title || "Untitled item"}</strong>
                  {record.subtitle && <span>{record.subtitle}</span>}
                  {record.date && <small>{record.date}</small>}
                </article>
              ))}
            </div>
          )}
          {(previewMutation.error || save.error) && (
            <p className="form-error">
              {(previewMutation.error ?? save.error)?.message}
            </p>
          )}
        </div>
        <footer>
          <button
            className="button button--quiet"
            disabled={previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            {previewMutation.isPending
              ? "Loading preview…"
              : "Preview mapped data"}
          </button>
          {!readOnly && (
            <button
              className="button button--primary"
              disabled={save.isPending || !name.trim()}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save Data Source"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

const defaultCalendar: CalendarConfig = {
  calendars: [{ name: "Calendar", url: "https://" }],
  displayMode: "upcoming",
  maxEvents: 10,
  fields: {
    title: true,
    startTime: true,
    endTime: false,
    date: true,
    location: true,
    descriptionExcerpt: false,
  },
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  refreshIntervalSeconds: 900,
  stalenessLimitHours: 168,
  emptyState: "No events scheduled",
};

export function CalendarDataSourceEditor({
  dataSource,
  csrf,
  readOnly = false,
  onClose,
  onSaved,
  page = false,
}: {
  dataSource?: DataSourceDetail;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (dataSource: DataSourceDetail) => void;
  page?: boolean;
}) {
  const queryClient = useQueryClient();
  const configured = dataSource?.configuration as CalendarConfig | undefined;
  const [name, setName] = useState(dataSource?.name ?? "");
  const [description, setDescription] = useState(dataSource?.description ?? "");
  const [configuration, setConfiguration] = useState<CalendarConfig>(
    configured ?? defaultCalendar,
  );
  const [preview, setPreview] = useState<CalendarPreview>();
  const diagnostics = useQuery({
    queryKey: ["data-source-diagnostics", dataSource?.id],
    queryFn: () => api.dataSourceDiagnostics(dataSource!.id),
    enabled: Boolean(dataSource),
  });
  const save = useMutation({
    mutationFn: () => {
      const input = {
        provider: "calendar" as const,
        name,
        description,
        configuration,
      };
      return dataSource
        ? api.updateDataSource(dataSource.id, input, csrf)
        : api.createDataSource(input, csrf);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      onSaved(saved);
    },
  });
  const previewMutation = useMutation({
    mutationFn: () =>
      api.previewDataSource(
        "calendar",
        configuration,
        csrf,
      ) as Promise<CalendarPreview>,
    onSuccess: setPreview,
  });
  const updateFeed = (index: number, key: "name" | "url", value: string) =>
    setConfiguration((current) => {
      const previousName = current.calendars[index]?.name;
      return {
        ...current,
        calendars: current.calendars.map((feed, position) =>
          position === index ? { ...feed, [key]: value } : feed,
        ),
        filterCalendars:
          key === "name"
            ? current.filterCalendars?.map((name) =>
                name === previousName ? value : name,
              )
            : current.filterCalendars,
      };
    });
  const diagnostic = diagnostics.data;
  return (
    <div className="details-backdrop" role={page ? undefined : "presentation"}>
      <section
        className="asset-details source-editor"
        role={page ? undefined : "dialog"}
        aria-modal={page ? undefined : true}
        aria-labelledby="calendar-source-title"
      >
        <header>
          <div>
            <h2 id="calendar-source-title">
              {dataSource
                ? "Edit Calendar Data Source"
                : "Create Calendar Data Source"}
            </h2>
            <p>
              Tilecast fetches and sanitizes public iCalendar feeds for native
              playback.
            </p>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="source-editor__columns">
          <label className="field">
            <span className="field__label">Name</span>
            <input
              disabled={readOnly}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">Description</span>
            <input
              disabled={readOnly}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </div>
        <fieldset className="source-editor__fieldset">
          <legend>Calendars</legend>
          {configuration.calendars.map((feed, index) => (
            <div className="source-editor__columns" key={index}>
              <label className="field">
                <span className="field__label">Calendar name</span>
                <input
                  disabled={readOnly}
                  value={feed.name}
                  onChange={(event) =>
                    updateFeed(index, "name", event.target.value)
                  }
                />
              </label>
              <label className="field">
                <span className="field__label">Public ICS URL</span>
                <input
                  disabled={readOnly}
                  type="url"
                  value={feed.url}
                  onChange={(event) =>
                    updateFeed(index, "url", event.target.value)
                  }
                />
              </label>
              {!readOnly && configuration.calendars.length > 1 && (
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Remove ${feed.name}`}
                  onClick={() =>
                    setConfiguration((current) => ({
                      ...current,
                      calendars: current.calendars.filter(
                        (_, position) => position !== index,
                      ),
                    }))
                  }
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          ))}
          {!readOnly && configuration.calendars.length < 8 && (
            <button
              className="button button--quiet"
              type="button"
              onClick={() =>
                setConfiguration((current) => ({
                  ...current,
                  calendars: [
                    ...current.calendars,
                    {
                      name: `Calendar ${current.calendars.length + 1}`,
                      url: "https://",
                    },
                  ],
                }))
              }
            >
              <Plus size={16} /> Add calendar
            </button>
          )}
        </fieldset>
        <div className="source-editor__columns">
          <label className="field">
            <span className="field__label">Display</span>
            <Select
              disabled={readOnly}
              value={configuration.displayMode}
              onChange={(event) =>
                setConfiguration({
                  ...configuration,
                  displayMode: event.target
                    .value as CalendarConfig["displayMode"],
                })
              }
            >
              <option value="today">Today</option>
              <option value="upcoming">Upcoming</option>
              <option value="this_week">This week</option>
              <option value="agenda">Agenda</option>
            </Select>
          </label>
          <label className="field">
            <span className="field__label">Maximum events</span>
            <input
              disabled={readOnly}
              type="number"
              min={1}
              max={100}
              value={configuration.maxEvents}
              onChange={(event) =>
                setConfiguration({
                  ...configuration,
                  maxEvents: Number(event.target.value),
                })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Timezone</span>
            <input
              disabled={readOnly}
              value={configuration.timezone}
              onChange={(event) =>
                setConfiguration({
                  ...configuration,
                  timezone: event.target.value,
                })
              }
            />
          </label>
        </div>
        <fieldset className="source-editor__fieldset">
          <legend>Event details</legend>
          {(
            Object.keys(
              configuration.fields,
            ) as (keyof CalendarConfig["fields"])[]
          ).map((field) => (
            <label key={field} className="checkbox-row">
              <input
                disabled={readOnly}
                type="checkbox"
                checked={configuration.fields[field]}
                onChange={(event) =>
                  setConfiguration({
                    ...configuration,
                    fields: {
                      ...configuration.fields,
                      [field]: event.target.checked,
                    },
                  })
                }
              />
              <span>
                {
                  {
                    title: "Title",
                    startTime: "Start time",
                    endTime: "End time",
                    date: "Date",
                    location: "Location",
                    descriptionExcerpt: "Description excerpt",
                  }[field]
                }
              </span>
            </label>
          ))}
        </fieldset>
        {configuration.calendars.length > 1 && (
          <fieldset className="source-editor__fieldset">
            <legend>Calendar filter</legend>
            <small>No selection includes every configured calendar.</small>
            {configuration.calendars.map((feed) => {
              const selected =
                configuration.filterCalendars?.includes(feed.name) ?? false;
              return (
                <label key={feed.name} className="checkbox-row">
                  <input
                    disabled={readOnly}
                    type="checkbox"
                    checked={selected}
                    onChange={(event) =>
                      setConfiguration((current) => ({
                        ...current,
                        filterCalendars: event.target.checked
                          ? [...(current.filterCalendars ?? []), feed.name]
                          : (current.filterCalendars ?? []).filter(
                              (name) => name !== feed.name,
                            ),
                      }))
                    }
                  />
                  <span>{feed.name}</span>
                </label>
              );
            })}
          </fieldset>
        )}
        <div className="source-editor__columns">
          <label className="field">
            <span className="field__label">Keyword filter</span>
            <input
              disabled={readOnly}
              value={configuration.filterKeyword ?? ""}
              onChange={(event) =>
                setConfiguration({
                  ...configuration,
                  filterKeyword: event.target.value,
                })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Refresh interval</span>
            <Select
              disabled={readOnly}
              value={configuration.refreshIntervalSeconds}
              onChange={(event) =>
                setConfiguration({
                  ...configuration,
                  refreshIntervalSeconds: Number(event.target.value),
                })
              }
            >
              <option value={300}>5 minutes</option>
              <option value={900}>15 minutes</option>
              <option value={3600}>1 hour</option>
              <option value={21600}>6 hours</option>
              <option value={86400}>1 day</option>
            </Select>
          </label>
          <label className="field">
            <span className="field__label">Empty state</span>
            <input
              disabled={readOnly}
              value={configuration.emptyState}
              onChange={(event) =>
                setConfiguration({
                  ...configuration,
                  emptyState: event.target.value,
                })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Keep cached data</span>
            <Select
              disabled={readOnly}
              value={configuration.stalenessLimitHours}
              onChange={(event) =>
                setConfiguration({
                  ...configuration,
                  stalenessLimitHours: Number(event.target.value),
                })
              }
            >
              <option value={24}>1 day</option>
              <option value={72}>3 days</option>
              <option value={168}>7 days</option>
              <option value={720}>30 days</option>
            </Select>
          </label>
        </div>
        {diagnostic && (
          <div className="source-diagnostics">
            <strong>Refresh diagnostics</strong>
            <span>
              {diagnostic.parseStatus} ·{" "}
              {diagnostic.httpResultCategory ?? "not attempted"} ·{" "}
              {diagnostic.availableEventCount} events
              {diagnostic.usingCachedData ? " · cached data" : ""}
            </span>
            <small>
              Last attempt:{" "}
              {diagnostic.lastAttemptedRefresh
                ? new Date(diagnostic.lastAttemptedRefresh).toLocaleString()
                : "Not yet"}
            </small>
            <small>
              Last success:{" "}
              {diagnostic.lastSuccessfulRefresh
                ? new Date(diagnostic.lastSuccessfulRefresh).toLocaleString()
                : "Not yet"}
            </small>
          </div>
        )}
        {preview && (
          <div className="source-preview-list">
            {preview.configuration.data.events
              .slice(0, configuration.maxEvents)
              .map((event) => (
                <article key={event.id}>
                  <strong>{event.title || "Untitled event"}</strong>
                  <span>
                    {event.allDay
                      ? new Date(event.start).toLocaleDateString()
                      : new Date(event.start).toLocaleString()}
                  </span>
                  {event.location && <small>{event.location}</small>}
                </article>
              ))}
            {!preview.configuration.data.events.length && (
              <p>{configuration.emptyState}</p>
            )}
          </div>
        )}
        {(previewMutation.error || save.error) && (
          <p className="form-error">
            {(previewMutation.error ?? save.error)?.message}
          </p>
        )}
        <footer>
          <button
            className="button button--quiet"
            type="button"
            disabled={previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            {previewMutation.isPending
              ? "Loading preview…"
              : "Preview real data"}
          </button>
          {!readOnly && (
            <button
              className="button button--primary"
              type="button"
              disabled={save.isPending || !name.trim()}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save Data Source"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

// Providers handled by a dedicated legacy editor below. Anything not listed here is a
// release-defined Source that routes to the generic, definition-driven editor.
const legacyDataSourceProviders = new Set<string>([
  "manual",
  "weather",
  "calendar",
  "transit",
  "cap_alerts",
  "air_quality",
  "rss",
  "atom",
  "json",
  "csv",
]);

export function DataSourceEditor({
  provider,
  dataSource,
  csrf,
  readOnly,
  onClose,
  onSaved,
  page,
}: {
  provider: DataSourceProvider;
  dataSource?: DataSourceDetail;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (dataSource: DataSourceDetail) => void;
  page?: boolean;
}) {
  const definitions = useQuery({
    queryKey: ["content-definitions"],
    queryFn: api.contentDefinitions,
  });
  const definition = definitions.data?.dataSources?.find(
    (candidate) => candidate.id === provider,
  );
  // Release-defined providers are anything the legacy editors below do not handle. Wait for
  // the catalog before routing them, so a new definition renders through the generic editor
  // without a hardcoded provider check here.
  if (!legacyDataSourceProviders.has(provider) && definitions.isLoading)
    return (
      <div className="table-loading">Loading Data Source definition...</div>
    );
  if (definition && !definition.legacyEditor)
    return (
      <GenericDataSourceEditor
        definition={definition}
        dataSource={dataSource}
        csrf={csrf}
        readOnly={readOnly}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
  if (provider === "manual")
    return (
      <ManualDataSourceEditor
        dataSource={dataSource}
        csrf={csrf}
        readOnly={readOnly}
        onClose={onClose}
        onSaved={onSaved}
        page={page}
      />
    );
  if (provider === "weather")
    return (
      <WeatherDataSourceEditor
        dataSource={dataSource}
        csrf={csrf}
        readOnly={readOnly}
        onClose={onClose}
        onSaved={onSaved}
        page={page}
      />
    );
  if (provider === "calendar")
    return (
      <CalendarDataSourceEditor
        dataSource={dataSource}
        csrf={csrf}
        readOnly={readOnly}
        onClose={onClose}
        onSaved={onSaved}
        page={page}
      />
    );
  if (
    provider === "transit" ||
    provider === "cap_alerts" ||
    provider === "air_quality"
  )
    return (
      <LiveDataSourceEditor
        provider={provider as LiveProvider}
        dataSource={dataSource}
        csrf={csrf}
        readOnly={readOnly}
        onClose={onClose}
        onSaved={onSaved}
        page={page}
      />
    );
  return (
    <StructuredDataSourceEditor
      provider={provider as StructuredProvider}
      dataSource={dataSource}
      csrf={csrf}
      readOnly={readOnly}
      onClose={onClose}
      onSaved={onSaved}
      page={page}
    />
  );
}

function EditorFrame({
  title,
  description,
  page,
  onClose,
  children,
  footer,
}: {
  title: string;
  description: string;
  page?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="details-backdrop" role={page ? undefined : "presentation"}>
      <section
        className="source-editor"
        role={page ? undefined : "dialog"}
        aria-modal={page ? undefined : true}
      >
        <header>
          <div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="source-editor__body">{children}</div>
        <footer>{footer}</footer>
      </section>
    </div>
  );
}

function ManualDataSourceEditor({
  dataSource,
  csrf,
  readOnly = false,
  onClose,
  onSaved,
  page,
}: {
  dataSource?: DataSourceDetail;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (dataSource: DataSourceDetail) => void;
  page?: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(dataSource?.name ?? "");
  const [description, setDescription] = useState(dataSource?.description ?? "");
  const [configuration, setConfiguration] = useState<ManualSourceConfig>(
    (dataSource?.configuration as ManualSourceConfig | undefined) ?? {
      columns: [{ key: "title", label: "Title", type: "text" }],
      rows: [{ id: crypto.randomUUID(), values: { title: "" } }],
      dateSelection: {
        enabled: false,
        dateFormat: "auto",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        mode: "today",
        excludePast: false,
        noMatchBehavior: "empty",
      },
    },
  );
  const save = useMutation({
    mutationFn: () => {
      const input = {
        provider: "manual" as const,
        name,
        description,
        configuration,
      };
      return dataSource
        ? api.updateDataSource(dataSource.id, input, csrf)
        : api.createDataSource(input, csrf);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      onSaved(saved);
    },
  });
  const updateColumn = (index: number, patch: Partial<ManualColumn>) =>
    setConfiguration((current) => ({
      ...current,
      columns: current.columns.map((column, columnIndex) =>
        columnIndex === index ? { ...column, ...patch } : column,
      ),
    }));
  return (
    <EditorFrame
      title={`${dataSource ? "Edit" : "Create"} Manual Table Data Source`}
      description="Maintain a small typed dataset directly in Tilecast Studio."
      page={page}
      onClose={onClose}
      footer={
        !readOnly && (
          <button
            className="button button--primary"
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save Data Source"}
          </button>
        )
      }
    >
      <label className="field">
        <span className="field__label">Name</span>
        <input
          value={name}
          disabled={readOnly}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="field">
        <span className="field__label">Description</span>
        <input
          value={description}
          disabled={readOnly}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <fieldset>
        <legend>Columns</legend>
        {configuration.columns.map((column, index) => (
          <div
            className="form-grid form-grid--3"
            key={`${column.key}-${index}`}
          >
            <label className="field">
              <span className="field__label">Key</span>
              <input
                value={column.key}
                disabled={readOnly}
                onChange={(event) =>
                  updateColumn(index, { key: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span className="field__label">Label</span>
              <input
                value={column.label}
                disabled={readOnly}
                onChange={(event) =>
                  updateColumn(index, { label: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span className="field__label">Type</span>
              <Select
                value={column.type}
                disabled={readOnly}
                onChange={(event) =>
                  updateColumn(index, {
                    type: event.target.value as ManualColumn["type"],
                  })
                }
              >
                {[
                  "text",
                  "number",
                  "integer",
                  "percent",
                  "currency",
                  "boolean",
                  "date",
                  "datetime",
                  "url",
                ].map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </Select>
            </label>
            {column.type === "currency" && (
              <label className="field">
                <span className="field__label">Currency</span>
                <input
                  value={column.currency ?? "USD"}
                  maxLength={3}
                  disabled={readOnly}
                  onChange={(event) =>
                    updateColumn(index, {
                      currency: event.target.value.toUpperCase(),
                    })
                  }
                />
              </label>
            )}
            {!readOnly && configuration.columns.length > 1 && (
              <button
                className="button button--danger"
                type="button"
                onClick={() =>
                  setConfiguration((current) => ({
                    ...current,
                    columns: current.columns.filter((_, i) => i !== index),
                    rows: current.rows.map((row) => {
                      const values = { ...row.values };
                      delete values[column.key];
                      return { ...row, values };
                    }),
                  }))
                }
              >
                <Trash2 size={15} /> Remove
              </button>
            )}
          </div>
        ))}
        {!readOnly && configuration.columns.length < 12 && (
          <button
            className="button"
            type="button"
            onClick={() =>
              setConfiguration((current) => ({
                ...current,
                columns: [
                  ...current.columns,
                  {
                    key: `field_${current.columns.length + 1}`,
                    label: `Field ${current.columns.length + 1}`,
                    type: "text",
                  },
                ],
              }))
            }
          >
            <Plus size={15} /> Add column
          </button>
        )}
      </fieldset>
      <fieldset>
        <legend>Rows ({configuration.rows.length}/200)</legend>
        <div className="manual-data-table">
          {configuration.rows.map((row, rowIndex) => (
            <div className="manual-data-table__row" key={row.id}>
              {configuration.columns.map((column) => (
                <label className="field" key={column.key}>
                  <span className="field__label">{column.label}</span>
                  {column.type === "boolean" ? (
                    <Select
                      value={row.values[column.key] ?? ""}
                      disabled={readOnly}
                      onChange={(event) =>
                        setConfiguration((current) => ({
                          ...current,
                          rows: current.rows.map((item, index) =>
                            index === rowIndex
                              ? {
                                  ...item,
                                  values: {
                                    ...item.values,
                                    [column.key]: event.target.value,
                                  },
                                }
                              : item,
                          ),
                        }))
                      }
                    >
                      <option value="">Empty</option>
                      <option value="true">True</option>
                      <option value="false">False</option>
                    </Select>
                  ) : (
                    <input
                      type={
                        column.type === "date"
                          ? "date"
                          : column.type === "datetime"
                            ? "text"
                            : [
                                  "number",
                                  "integer",
                                  "percent",
                                  "currency",
                                ].includes(column.type)
                              ? "number"
                              : "text"
                      }
                      value={row.values[column.key] ?? ""}
                      disabled={readOnly}
                      onChange={(event) =>
                        setConfiguration((current) => ({
                          ...current,
                          rows: current.rows.map((item, index) =>
                            index === rowIndex
                              ? {
                                  ...item,
                                  values: {
                                    ...item.values,
                                    [column.key]: event.target.value,
                                  },
                                }
                              : item,
                          ),
                        }))
                      }
                    />
                  )}
                </label>
              ))}
              {!readOnly && (
                <button
                  className="icon-button"
                  aria-label={`Remove row ${rowIndex + 1}`}
                  onClick={() =>
                    setConfiguration((current) => ({
                      ...current,
                      rows: current.rows.filter(
                        (_, index) => index !== rowIndex,
                      ),
                    }))
                  }
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          ))}
        </div>
        {!readOnly && configuration.rows.length < 200 && (
          <button
            className="button"
            type="button"
            onClick={() =>
              setConfiguration((current) => ({
                ...current,
                rows: [
                  ...current.rows,
                  { id: crypto.randomUUID(), values: {} },
                ],
              }))
            }
          >
            <Plus size={15} /> Add row
          </button>
        )}
      </fieldset>
      <fieldset>
        <legend>Date-aware selection</legend>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={configuration.dateSelection.enabled}
            disabled={readOnly}
            onChange={(event) =>
              setConfiguration((current) => ({
                ...current,
                dateSelection: {
                  ...current.dateSelection,
                  enabled: event.target.checked,
                },
              }))
            }
          />
          <span>Select rows from the Player&apos;s local date</span>
        </label>
        {configuration.dateSelection.enabled && (
          <div className="form-grid form-grid--2">
            <label className="field">
              <span className="field__label">Date field</span>
              <Select
                value={configuration.dateField ?? ""}
                disabled={readOnly}
                onChange={(event) =>
                  setConfiguration((current) => ({
                    ...current,
                    dateField: event.target.value,
                  }))
                }
              >
                <option value="">Select a date column</option>
                {configuration.columns
                  .filter((column) =>
                    ["date", "datetime"].includes(column.type),
                  )
                  .map((column) => (
                    <option key={column.key} value={column.key}>
                      {column.label}
                    </option>
                  ))}
              </Select>
            </label>
            <label className="field">
              <span className="field__label">Timezone</span>
              <input
                value={configuration.dateSelection.timezone}
                disabled={readOnly}
                onChange={(event) =>
                  setConfiguration((current) => ({
                    ...current,
                    dateSelection: {
                      ...current.dateSelection,
                      timezone: event.target.value,
                    },
                  }))
                }
              />
            </label>
            <label className="field">
              <span className="field__label">Selection</span>
              <Select
                value={configuration.dateSelection.mode}
                disabled={readOnly}
                onChange={(event) =>
                  setConfiguration((current) => ({
                    ...current,
                    dateSelection: {
                      ...current.dateSelection,
                      mode: event.target.value as DateSelection["mode"],
                    },
                  }))
                }
              >
                <option value="today">Today</option>
                <option value="tomorrow">Tomorrow</option>
                <option value="next_available">Next available date</option>
                <option value="current_week">Current week</option>
              </Select>
            </label>
          </div>
        )}
      </fieldset>
      {save.error && <p className="form-error">{save.error.message}</p>}
    </EditorFrame>
  );
}

function WeatherDataSourceEditor({
  dataSource,
  csrf,
  readOnly = false,
  onClose,
  onSaved,
  page,
}: {
  dataSource?: DataSourceDetail;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (dataSource: DataSourceDetail) => void;
  page?: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(dataSource?.name ?? "");
  const [description, setDescription] = useState(dataSource?.description ?? "");
  const [configuration, setConfiguration] = useState<WeatherSourceConfig>(
    (dataSource?.configuration as WeatherSourceConfig | undefined) ?? {
      locationLabel: "",
      latitude: 0,
      longitude: 0,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      units: "imperial",
      forecastDays: 5,
      contact: "",
      refreshIntervalSeconds: 1800,
      stalenessLimitHours: 24,
    },
  );
  const [preview, setPreview] = useState<TypedRecordData>();
  const previewMutation = useMutation({
    mutationFn: () =>
      api.previewDataSource(
        "weather",
        configuration,
        csrf,
      ) as unknown as Promise<TypedRecordData>,
    onSuccess: setPreview,
  });
  const save = useMutation({
    mutationFn: () => {
      const input = {
        provider: "weather" as const,
        name,
        description,
        configuration,
      };
      return dataSource
        ? api.updateDataSource(dataSource.id, input, csrf)
        : api.createDataSource(input, csrf);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      onSaved(saved);
    },
  });
  const set = <K extends keyof WeatherSourceConfig>(
    key: K,
    value: WeatherSourceConfig[K],
  ) => setConfiguration((current) => ({ ...current, [key]: value }));
  return (
    <EditorFrame
      title={`${dataSource ? "Edit" : "Create"} Weather Data Source`}
      description="Fetch a cached global forecast from MET Norway."
      page={page}
      onClose={onClose}
      footer={
        !readOnly && (
          <button
            className="button button--primary"
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save Data Source"}
          </button>
        )
      }
    >
      <label className="field">
        <span className="field__label">Name</span>
        <input
          value={name}
          disabled={readOnly}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="field">
        <span className="field__label">Description</span>
        <input
          value={description}
          disabled={readOnly}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <div className="form-grid form-grid--2">
        <label className="field">
          <span className="field__label">Location label</span>
          <input
            value={configuration.locationLabel}
            disabled={readOnly}
            onChange={(event) => set("locationLabel", event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Timezone</span>
          <input
            value={configuration.timezone}
            disabled={readOnly}
            onChange={(event) => set("timezone", event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Latitude</span>
          <input
            type="number"
            step="0.0001"
            value={configuration.latitude}
            disabled={readOnly}
            onChange={(event) => set("latitude", Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span className="field__label">Longitude</span>
          <input
            type="number"
            step="0.0001"
            value={configuration.longitude}
            disabled={readOnly}
            onChange={(event) => set("longitude", Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span className="field__label">Units</span>
          <Select
            value={configuration.units}
            disabled={readOnly}
            onChange={(event) =>
              set("units", event.target.value as WeatherSourceConfig["units"])
            }
          >
            <option value="imperial">Imperial</option>
            <option value="metric">Metric</option>
          </Select>
        </label>
        <label className="field">
          <span className="field__label">Forecast days</span>
          <input
            type="number"
            min={1}
            max={7}
            value={configuration.forecastDays}
            disabled={readOnly}
            onChange={(event) =>
              set("forecastDays", Number(event.target.value))
            }
          />
        </label>
      </div>
      <label className="field">
        <span className="field__label">Contact email or HTTPS URL</span>
        <input
          value={configuration.contact}
          disabled={readOnly}
          onChange={(event) => set("contact", event.target.value)}
        />
        <small>
          MET Norway requires an identifying contact in each request. It is
          stored only on the server.
        </small>
      </label>
      {!readOnly && (
        <button
          className="button"
          type="button"
          disabled={previewMutation.isPending}
          onClick={() => previewMutation.mutate()}
        >
          {previewMutation.isPending ? "Loading…" : "Preview forecast"}
        </button>
      )}
      {preview && (
        <div className="source-preview">
          {preview.records.slice(0, 4).map((record) => (
            <div key={record.id}>
              <strong>{record.values.date ?? "Current"}</strong>
              <span>
                {record.values.condition}{" "}
                {record.values.temperature
                  ? `${record.values.temperature}${record.values.temperatureUnit}`
                  : `${record.values.high}${record.values.temperatureUnit} / ${record.values.low}${record.values.temperatureUnit}`}
              </span>
            </div>
          ))}
          <small>{preview.attribution}</small>
        </div>
      )}
      {(save.error || previewMutation.error) && (
        <p className="form-error">
          {(save.error ?? previewMutation.error)?.message}
        </p>
      )}
    </EditorFrame>
  );
}

type LiveProvider = "transit" | "cap_alerts" | "air_quality";
type LiveConfiguration =
  TransitSourceConfig | CAPAlertsSourceConfig | AirQualitySourceConfig;

function defaultLiveConfiguration(provider: LiveProvider): LiveConfiguration {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (provider === "transit")
    return {
      staticUrl: "https://",
      tripUpdatesUrl: "https://",
      serviceAlertsUrl: "",
      stopIds: [],
      routeIds: [],
      timezone,
      maximumDepartures: 40,
      realtimeRefreshSeconds: 60,
      staticRefreshHours: 24,
      stalenessLimitMinutes: 30,
    };
  if (provider === "cap_alerts")
    return {
      url: "https://",
      feedMode: "auto",
      preferredLanguage: "",
      minimumSeverity: "minor",
      includeAreaKeywords: [],
      excludeAreaKeywords: [],
      maximumAlerts: 50,
      refreshIntervalSeconds: 300,
      stalenessLimitHours: 24,
    };
  return {
    locationLabel: "",
    latitude: 0,
    longitude: 0,
    timezone,
    aqiStandard: "us",
    pollutants: ["pm2_5", "pm10", "ozone", "nitrogen_dioxide"],
    forecastHours: 48,
    nonCommercialAccepted: false,
    refreshIntervalSeconds: 3600,
    stalenessLimitHours: 24,
  };
}

function LiveDataSourceEditor({
  provider,
  dataSource,
  csrf,
  readOnly = false,
  onClose,
  onSaved,
  page,
}: {
  provider: LiveProvider;
  dataSource?: DataSourceDetail;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (dataSource: DataSourceDetail) => void;
  page?: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(dataSource?.name ?? "");
  const [description, setDescription] = useState(dataSource?.description ?? "");
  const [configuration, setConfiguration] = useState<LiveConfiguration>(
    (dataSource?.configuration as LiveConfiguration | undefined) ??
      defaultLiveConfiguration(provider),
  );
  const [preview, setPreview] = useState<TypedDatasetPayload>();
  const previewMutation = useMutation({
    mutationFn: () =>
      api.previewDataSource(
        provider,
        configuration,
        csrf,
      ) as unknown as Promise<TypedDatasetPayload>,
    onSuccess: setPreview,
  });
  const save = useMutation({
    mutationFn: () => {
      const input = { provider, name, description, configuration };
      return dataSource
        ? api.updateDataSource(dataSource.id, input, csrf)
        : api.createDataSource(input, csrf);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      onSaved(saved);
    },
  });
  const patch = (values: Partial<LiveConfiguration>) =>
    setConfiguration((current) => ({ ...current, ...values }));
  return (
    <EditorFrame
      title={`${dataSource ? "Edit" : "Create"} ${
        provider === "transit"
          ? "Transit"
          : provider === "cap_alerts"
            ? "CAP Alerts"
            : "Air Quality"
      } Data Source`}
      description={
        provider === "transit"
          ? "Join a public GTFS Static archive with GTFS Realtime departures and alerts."
          : provider === "cap_alerts"
            ? "Normalize active public CAP 1.2 alerts from XML or a bounded feed index."
            : "Cache current and hourly air-quality values from the installation endpoint."
      }
      page={page}
      onClose={onClose}
      footer={
        !readOnly && (
          <button
            className="button button--primary"
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save Data Source"}
          </button>
        )
      }
    >
      <div className="form-grid form-grid--2">
        <label className="field">
          <span className="field__label">Name</span>
          <input
            value={name}
            disabled={readOnly}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Description</span>
          <input
            value={description}
            disabled={readOnly}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      </div>
      {provider === "transit" && (
        <>
          <div className="form-grid form-grid--2">
            <label className="field">
              <span className="field__label">GTFS Static ZIP URL</span>
              <input
                value={(configuration as TransitSourceConfig).staticUrl}
                disabled={readOnly}
                onChange={(event) => patch({ staticUrl: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">Trip Updates URL</span>
              <input
                value={(configuration as TransitSourceConfig).tripUpdatesUrl}
                disabled={readOnly}
                onChange={(event) =>
                  patch({ tripUpdatesUrl: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span className="field__label">
                Service Alerts URL (optional)
              </span>
              <input
                value={
                  (configuration as TransitSourceConfig).serviceAlertsUrl ?? ""
                }
                disabled={readOnly}
                onChange={(event) =>
                  patch({ serviceAlertsUrl: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span className="field__label">IANA timezone</span>
              <input
                value={(configuration as TransitSourceConfig).timezone}
                disabled={readOnly}
                onChange={(event) => patch({ timezone: event.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span className="field__label">
              Stop IDs (comma or newline separated)
            </span>
            <textarea
              value={(configuration as TransitSourceConfig).stopIds.join("\n")}
              disabled={readOnly}
              onChange={(event) =>
                patch({
                  stopIds: event.target.value
                    .split(/[\n,]/)
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Route IDs (optional)</span>
            <input
              value={
                (configuration as TransitSourceConfig).routeIds?.join(", ") ??
                ""
              }
              disabled={readOnly}
              onChange={(event) =>
                patch({
                  routeIds: event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
        </>
      )}
      {provider === "cap_alerts" && (
        <>
          <div className="form-grid form-grid--2">
            <label className="field">
              <span className="field__label">CAP or feed-index URL</span>
              <input
                value={(configuration as CAPAlertsSourceConfig).url}
                disabled={readOnly}
                onChange={(event) => patch({ url: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">Feed mode</span>
              <Select
                value={(configuration as CAPAlertsSourceConfig).feedMode}
                disabled={readOnly}
                onChange={(event) =>
                  patch({
                    feedMode: event.target
                      .value as CAPAlertsSourceConfig["feedMode"],
                  })
                }
              >
                <option value="auto">Detect automatically</option>
                <option value="cap">Direct CAP XML</option>
                <option value="index">Atom/RSS index</option>
              </Select>
            </label>
            <label className="field">
              <span className="field__label">Preferred language</span>
              <input
                placeholder="en-US"
                value={
                  (configuration as CAPAlertsSourceConfig).preferredLanguage ??
                  ""
                }
                disabled={readOnly}
                onChange={(event) =>
                  patch({ preferredLanguage: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span className="field__label">Minimum severity</span>
              <Select
                value={(configuration as CAPAlertsSourceConfig).minimumSeverity}
                disabled={readOnly}
                onChange={(event) =>
                  patch({
                    minimumSeverity: event.target
                      .value as CAPAlertsSourceConfig["minimumSeverity"],
                  })
                }
              >
                <option value="unknown">Unknown</option>
                <option value="minor">Minor</option>
                <option value="moderate">Moderate</option>
                <option value="severe">Severe</option>
                <option value="extreme">Extreme</option>
              </Select>
            </label>
          </div>
          <label className="field">
            <span className="field__label">Include area keywords</span>
            <input
              value={
                (
                  configuration as CAPAlertsSourceConfig
                ).includeAreaKeywords?.join(", ") ?? ""
              }
              disabled={readOnly}
              onChange={(event) =>
                patch({
                  includeAreaKeywords: event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Exclude area keywords</span>
            <input
              value={
                (
                  configuration as CAPAlertsSourceConfig
                ).excludeAreaKeywords?.join(", ") ?? ""
              }
              disabled={readOnly}
              onChange={(event) =>
                patch({
                  excludeAreaKeywords: event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
        </>
      )}
      {provider === "air_quality" && (
        <>
          <div className="form-grid form-grid--2">
            {(
              [
                ["locationLabel", "Location label", "text"],
                ["timezone", "IANA timezone", "text"],
                ["latitude", "Latitude", "number"],
                ["longitude", "Longitude", "number"],
              ] as const
            ).map(([key, label, type]) => (
              <label className="field" key={key}>
                <span className="field__label">{label}</span>
                <input
                  type={type}
                  step={type === "number" ? "0.0001" : undefined}
                  value={
                    (
                      configuration as unknown as Record<
                        string,
                        string | number
                      >
                    )[key]
                  }
                  disabled={readOnly}
                  onChange={(event) =>
                    patch({
                      [key]:
                        type === "number"
                          ? Number(event.target.value)
                          : event.target.value,
                    })
                  }
                />
              </label>
            ))}
            <label className="field">
              <span className="field__label">AQI standard</span>
              <Select
                value={(configuration as AirQualitySourceConfig).aqiStandard}
                disabled={readOnly}
                onChange={(event) =>
                  patch({
                    aqiStandard: event.target
                      .value as AirQualitySourceConfig["aqiStandard"],
                  })
                }
              >
                <option value="us">US AQI</option>
                <option value="european">European AQI</option>
              </Select>
            </label>
          </div>
          <fieldset>
            <legend>Measurements</legend>
            <div className="checkbox-grid">
              {[
                "pm2_5",
                "pm10",
                "ozone",
                "nitrogen_dioxide",
                "alder_pollen",
                "birch_pollen",
                "grass_pollen",
                "ragweed_pollen",
              ].map((pollutant) => (
                <label key={pollutant}>
                  <input
                    type="checkbox"
                    checked={(
                      configuration as AirQualitySourceConfig
                    ).pollutants.includes(pollutant)}
                    disabled={readOnly}
                    onChange={(event) => {
                      const values = (configuration as AirQualitySourceConfig)
                        .pollutants;
                      patch({
                        pollutants: event.target.checked
                          ? [...values, pollutant]
                          : values.filter((value) => value !== pollutant),
                      });
                    }}
                  />
                  <span>{pollutant.replaceAll("_", " ").toUpperCase()}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="switch-row">
            <input
              type="checkbox"
              checked={
                (configuration as AirQualitySourceConfig).nonCommercialAccepted
              }
              disabled={readOnly}
              onChange={(event) =>
                patch({ nonCommercialAccepted: event.target.checked })
              }
            />
            <span>
              This installation’s hosted Open-Meteo use is noncommercial
            </span>
          </label>
          <small>
            Commercial installations must configure a self-hosted air-quality
            endpoint at deployment time. API keys are not stored by Tilecast.
          </small>
        </>
      )}
      {!readOnly && (
        <button
          type="button"
          className="button"
          disabled={previewMutation.isPending}
          onClick={() => previewMutation.mutate()}
        >
          {previewMutation.isPending ? "Loading preview…" : "Preview real data"}
        </button>
      )}
      {preview && (
        <div className="source-preview">
          {preview.datasets.map((dataset) => (
            <div key={dataset.id}>
              <strong>{dataset.id}</strong>
              <span>
                {dataset.records?.length ??
                  dataset.points?.length ??
                  Object.keys(dataset.values ?? {}).length}{" "}
                values
              </span>
              {dataset.attribution && <small>{dataset.attribution}</small>}
            </div>
          ))}
        </div>
      )}
      {(save.error || previewMutation.error) && (
        <p className="form-error">
          {(save.error ?? previewMutation.error)?.message}
        </p>
      )}
      {dataSource && (
        <div className="notice">
          Suggested Widgets:{" "}
          {provider === "transit"
            ? "Schedule / Departures, Timeline, Status Board"
            : provider === "cap_alerts"
              ? "Spotlight, Status Board, Timeline"
              : "Stat Grid, Chart, Progress"}
          .
        </div>
      )}
    </EditorFrame>
  );
}

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../api/client";
import { toast } from "../../components/ui/toast";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button as RheaButton } from "../../components/ui/button";
import { Checkbox as RheaCheckbox } from "../../components/ui/checkbox";
import { Field, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch as RheaSwitch } from "../../components/ui/switch";
import type {
  DataSourceDetail,
  StructuredField,
  StructuredInspection,
  StructuredValueType,
  StructuredPreview,
  StructuredSourceConfig,
} from "../../api/types";
import { CsvSourceInput } from "../CsvSourceInput";

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
      <p className="text-sm text-muted-foreground">
        {provider === "csv"
          ? "Upload a CSV or enter a hosted CSV URL and Tilecast will read its columns."
          : "Enter the endpoint URL and Tilecast will read the fields it returns."}
      </p>
    );
  if (inspection.isPending)
    return (
      <p className="text-sm text-muted-foreground">
        Reading the connected data…
      </p>
    );
  if (inspection.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {inspection.error instanceof Error
            ? inspection.error.message
            : "The connected data could not be read."}{" "}
          Map the fields by name below, or fix the connection and try again.
        </AlertDescription>
      </Alert>
    );
  if (!inspection.data) return null;
  const detected = inspection.data;
  return (
    <p className="text-sm text-muted-foreground">
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

const presentationOptions = [
  { value: "list", label: "List" },
  { value: "agenda", label: "Agenda" },
  { value: "cards", label: "Cards" },
  { value: "ticker", label: "Ticker" },
];

const sortOptions = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "title", label: "Title" },
  { value: "source", label: "Original order" },
];

const delimiterOptions = [
  { value: "", label: "Detect" },
  { value: ",", label: "Comma" },
  { value: ";", label: "Semicolon" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe" },
];

const dateFormatOptions = [
  { value: "auto", label: "Detect" },
  { value: "iso_date", label: "YYYY-MM-DD" },
  { value: "us_date", label: "MM/DD/YYYY" },
  { value: "us_short", label: "M/D/YYYY" },
  { value: "day_month_name", label: "DD-Mon-YYYY" },
  { value: "rfc3339", label: "RFC 3339" },
];

const dateModeOptions = [
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "next_available", label: "Next available date" },
  { value: "current_week", label: "Current week" },
  { value: "custom_range", label: "Custom date range" },
];

const noMatchOptions = [
  { value: "empty", label: "Display empty state" },
  { value: "fallback_text", label: "Show fallback text" },
  { value: "next_available", label: "Show next available" },
  { value: "hide", label: "Hide Widget or binding" },
  { value: "last_known_good", label: "Use last-known-good record" },
];

const filterOperatorOptions = [
  { value: "equals", label: "Equals" },
  { value: "contains", label: "Contains" },
];

const refreshOptions = [
  { value: 300, label: "5 minutes" },
  { value: 900, label: "15 minutes" },
  { value: 3600, label: "Hourly" },
  { value: 21600, label: "6 hours" },
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
  const id = useId();
  const known = fields.some((field) => field.key === value);
  const selected = fields.find((field) => field.key === value);
  const selectedText = selected
    ? selected.samples.length > 0
      ? `${selected.label} — ${selected.samples[0]}`
      : selected.label
    : null;
  if (fields.length === 0)
    return (
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input
          id={id}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
    );
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <RheaSelect
        items={[
          { value: "", label: "Not used" },
          ...fields.map((field) => ({
            value: field.key,
            label:
              field.samples.length > 0
                ? `${field.label} — ${field.samples[0]}`
                : field.label,
          })),
          ...(value && !known
            ? [{ value, label: selectedText ?? `${value} (not found)` }]
            : []),
        ]}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next);
        }}
      >
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">Not used</SelectItem>
          {fields.map((field) => (
            <SelectItem key={field.key} value={field.key}>
              {field.samples.length > 0
                ? `${field.label} — ${field.samples[0]}`
                : field.label}
            </SelectItem>
          ))}
          {value && !known && (
            <SelectItem value={value}>{value} (not found)</SelectItem>
          )}
        </SelectContent>
      </RheaSelect>
    </Field>
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
      toast.add({
        title: dataSource ? "Data Source updated." : "Data Source created.",
        type: "success",
      });
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
    <div
      className={
        page
          ? "grid w-full min-w-0 gap-5"
          : "fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4"
      }
      role={page ? undefined : "presentation"}
    >
      <section
        className={
          page
            ? "grid w-full min-w-0 gap-5"
            : "mx-auto grid w-full max-w-3xl gap-5 rounded-xl bg-background p-5"
        }
        role={page ? undefined : "dialog"}
        aria-modal={page ? undefined : true}
        aria-labelledby="structured-source-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 id="structured-source-title" className="text-xl font-semibold">
              {dataSource ? "Edit" : "Create"} {provider.toUpperCase()} Data
              Source
            </h2>
            <p className="text-sm text-muted-foreground">
              Fetched data is sanitized and cached for offline playback.
            </p>
          </div>
          <RheaButton
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </RheaButton>
        </div>
        <div className="grid min-w-0 gap-5">
          <Field>
            <FieldLabel htmlFor="structured-name">Name</FieldLabel>
            <Input
              id="structured-name"
              value={name}
              disabled={readOnly}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="structured-description">
              Description
            </FieldLabel>
            <Input
              id="structured-description"
              value={description}
              disabled={readOnly}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          {provider === "csv" && (
            <CsvSourceInput
              configuration={configuration}
              readOnly={readOnly}
              onChange={updateConfiguration}
            />
          )}
          {provider !== "csv" && (
            <Field>
              <FieldLabel htmlFor="structured-url">
                {provider === "json" ? "API endpoint URL" : "Feed URL"}
              </FieldLabel>
              <Input
                id="structured-url"
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
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="structured-presentation">
                Presentation
              </FieldLabel>
              <RheaSelect
                value={configuration.presentation}
                disabled={readOnly}
                onValueChange={(next) =>
                  setConfiguration((c) => ({
                    ...c,
                    presentation:
                      next as StructuredSourceConfig["presentation"],
                  }))
                }
                items={presentationOptions}
              >
                <SelectTrigger
                  id="structured-presentation"
                  aria-label="Presentation"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="list">List</SelectItem>
                  <SelectItem value="agenda">Agenda</SelectItem>
                  <SelectItem value="cards">Cards</SelectItem>
                  <SelectItem value="ticker">Ticker</SelectItem>
                </SelectContent>
              </RheaSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="structured-max-items">
                Maximum items
              </FieldLabel>
              <Input
                id="structured-max-items"
                type="number"
                min={1}
                max={200}
                value={configuration.maxItems}
                disabled={readOnly}
                onChange={(e) =>
                  setConfiguration((c) => ({
                    ...c,
                    maxItems: Number(e.target.value),
                  }))
                }
              />
            </Field>
          </div>
          {/* Feeds publish a fixed record, so the author chooses which parts of it to
              show — but only from the parts this feed actually carries. Mapped Sources
              have no such list: what they map is what they display. */}
          {!mapped && (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Displayed fields</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
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
                    // The wrapping label names the checkbox; an extra aria-label
                    // would double the accessible name ("Title Title").
                    <label
                      key={field}
                      className="flex items-center gap-2 text-sm"
                    >
                      <RheaCheckbox
                        checked={configuration.fields[field]}
                        disabled={readOnly}
                        onCheckedChange={(checked) =>
                          setConfiguration((current) => ({
                            ...current,
                            fields: {
                              ...current.fields,
                              [field]: checked === true,
                            },
                          }))
                        }
                      />
                      <span>{structuredFieldLabels[field] ?? field}</span>
                    </label>
                  ))}
              </div>
              {inspection.data && (
                <p className="text-sm text-muted-foreground">
                  {inspection.data.rowCount} item
                  {inspection.data.rowCount === 1 ? "" : "s"} read from this
                  feed. Fields it does not publish are not listed.
                </p>
              )}
            </fieldset>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="structured-keyword">
                Keyword filter
              </FieldLabel>
              <Input
                id="structured-keyword"
                value={configuration.filterKeyword ?? ""}
                disabled={readOnly}
                onChange={(e) =>
                  setConfiguration((c) => ({
                    ...c,
                    filterKeyword: e.target.value,
                  }))
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="structured-sort">Sort</FieldLabel>
              <RheaSelect
                value={configuration.sort}
                disabled={readOnly}
                onValueChange={(next) =>
                  setConfiguration((c) => ({
                    ...c,
                    sort: next as StructuredSourceConfig["sort"],
                  }))
                }
                items={sortOptions}
              >
                <SelectTrigger id="structured-sort" aria-label="Sort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest</SelectItem>
                  <SelectItem value="oldest">Oldest</SelectItem>
                  <SelectItem value="title">Title</SelectItem>
                  <SelectItem value="source">Original order</SelectItem>
                </SelectContent>
              </RheaSelect>
            </Field>
          </div>
          {(provider === "json" || provider === "csv") && mapping && (
            <>
              <fieldset className="grid gap-3">
                <legend className="text-sm font-medium">Field mapping</legend>
                <StructuredDetectionNotice
                  provider={provider}
                  detectable={detectable}
                  inspection={inspection}
                />
                {provider === "json" && (
                  <Field>
                    <FieldLabel htmlFor="mapping-root-list">
                      Root list path
                    </FieldLabel>
                    <Input
                      id="mapping-root-list"
                      value={mapping.rootList}
                      placeholder="/items"
                      disabled={readOnly}
                      onChange={(e) =>
                        updateMapping("rootList", e.target.value)
                      }
                    />
                  </Field>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
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
                  <Field>
                    <FieldLabel htmlFor="csv-delimiter">Delimiter</FieldLabel>
                    <RheaSelect
                      value={configuration.delimiter ?? ""}
                      disabled={readOnly}
                      onValueChange={(next) =>
                        setConfiguration((c) => ({
                          ...c,
                          delimiter:
                            next as StructuredSourceConfig["delimiter"],
                        }))
                      }
                      items={delimiterOptions}
                    >
                      <SelectTrigger id="csv-delimiter" aria-label="Delimiter">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">Detect</SelectItem>
                        <SelectItem value=",">Comma</SelectItem>
                        <SelectItem value=";">Semicolon</SelectItem>
                        <SelectItem value="&#9;">Tab</SelectItem>
                        <SelectItem value="|">Pipe</SelectItem>
                      </SelectContent>
                    </RheaSelect>
                  </Field>
                )}
                <div className="grid gap-2">
                  <strong className="text-sm font-medium">
                    Optional values
                  </strong>
                  <small className="text-xs text-muted-foreground">
                    A Widget offers a value only where its type fits: a start
                    and end time have to be typed Date &amp; time before a
                    schedule Widget can select them.
                  </small>
                  {Object.entries(mapping.valueFields ?? {}).map(
                    ([label, path]) => (
                      <div
                        className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-center"
                        key={label}
                      >
                        <Input
                          aria-label="Value label"
                          value={label}
                          disabled={readOnly}
                          onChange={(event) =>
                            renameValueField(label, event.target.value)
                          }
                        />
                        <Input
                          aria-label="Value path or column"
                          value={path}
                          disabled={readOnly}
                          onChange={(event) =>
                            setValueField(label, event.target.value)
                          }
                        />
                        <RheaSelect
                          value={mapping.valueFieldTypes?.[label] ?? "text"}
                          disabled={readOnly}
                          onValueChange={(next) =>
                            setValueFieldType(
                              label,
                              next as StructuredValueType,
                            )
                          }
                          items={valueTypeOptions}
                        >
                          <SelectTrigger aria-label={`${label} type`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {valueTypeOptions.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </RheaSelect>
                        <RheaButton
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${label}`}
                          disabled={readOnly}
                          onClick={() => removeValueField(label)}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </RheaButton>
                      </div>
                    ),
                  )}
                  {!readOnly &&
                    unmappedTimestamps.length > 0 &&
                    Object.keys(mapping.valueFields ?? {}).length <
                      maximumValueFields && (
                      <RheaButton
                        type="button"
                        variant="ghost"
                        onClick={addTimestampValues}
                      >
                        <Plus size={15} aria-hidden="true" /> Add{" "}
                        {unmappedTimestamps.length} detected time field
                        {unmappedTimestamps.length === 1 ? "" : "s"}
                      </RheaButton>
                    )}
                  {!readOnly &&
                    Object.keys(mapping.valueFields ?? {}).length <
                      maximumValueFields && (
                      <RheaButton
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          setValueField(
                            `Value ${Object.keys(mapping.valueFields ?? {}).length + 1}`,
                            provider === "json" ? "/value" : "value",
                          )
                        }
                      >
                        <Plus size={15} aria-hidden="true" /> Add value
                      </RheaButton>
                    )}
                </div>
              </fieldset>
              <fieldset className="grid gap-3">
                <legend className="text-sm font-medium">
                  Date-aware selection
                </legend>
                <label className="flex items-start gap-2 text-sm">
                  <RheaSwitch
                    checked={configuration.dateSelection.enabled}
                    disabled={readOnly}
                    onCheckedChange={(checked) =>
                      setConfiguration((current) => ({
                        ...current,
                        dateSelection: {
                          ...current.dateSelection,
                          enabled: checked === true,
                        },
                      }))
                    }
                    aria-label="Select records by local date"
                    className="mt-0.5"
                  />
                  <span className="grid gap-0.5">
                    <strong className="font-medium">
                      Select records by local date
                    </strong>
                    <small className="text-xs text-muted-foreground">
                      The Player reevaluates cached records at the configured
                      local date transition.
                    </small>
                  </span>
                </label>
                {configuration.dateSelection.enabled && (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="date-format">
                          Date format
                        </FieldLabel>
                        <RheaSelect
                          value={configuration.dateSelection.dateFormat}
                          disabled={readOnly}
                          onValueChange={(next) =>
                            setConfiguration((current) => ({
                              ...current,
                              dateSelection: {
                                ...current.dateSelection,
                                dateFormat:
                                  next as StructuredSourceConfig["dateSelection"]["dateFormat"],
                              },
                            }))
                          }
                          items={dateFormatOptions}
                        >
                          <SelectTrigger
                            id="date-format"
                            aria-label="Date format"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">Detect</SelectItem>
                            <SelectItem value="iso_date">YYYY-MM-DD</SelectItem>
                            <SelectItem value="us_date">MM/DD/YYYY</SelectItem>
                            <SelectItem value="us_short">M/D/YYYY</SelectItem>
                            <SelectItem value="day_month_name">
                              DD-Mon-YYYY
                            </SelectItem>
                            <SelectItem value="rfc3339">RFC 3339</SelectItem>
                          </SelectContent>
                        </RheaSelect>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="date-timezone">
                          Timezone
                        </FieldLabel>
                        <Input
                          id="date-timezone"
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
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="date-mode">Selection</FieldLabel>
                        <RheaSelect
                          value={configuration.dateSelection.mode}
                          disabled={readOnly}
                          onValueChange={(next) =>
                            setConfiguration((current) => ({
                              ...current,
                              dateSelection: {
                                ...current.dateSelection,
                                mode: next as StructuredSourceConfig["dateSelection"]["mode"],
                              },
                            }))
                          }
                          items={dateModeOptions}
                        >
                          <SelectTrigger id="date-mode" aria-label="Selection">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="today">Today</SelectItem>
                            <SelectItem value="tomorrow">Tomorrow</SelectItem>
                            <SelectItem value="next_available">
                              Next available date
                            </SelectItem>
                            <SelectItem value="current_week">
                              Current week
                            </SelectItem>
                            <SelectItem value="custom_range">
                              Custom date range
                            </SelectItem>
                          </SelectContent>
                        </RheaSelect>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="date-no-match">
                          No match
                        </FieldLabel>
                        <RheaSelect
                          value={configuration.dateSelection.noMatchBehavior}
                          disabled={readOnly}
                          onValueChange={(next) =>
                            setConfiguration((current) => ({
                              ...current,
                              dateSelection: {
                                ...current.dateSelection,
                                noMatchBehavior:
                                  next as StructuredSourceConfig["dateSelection"]["noMatchBehavior"],
                              },
                            }))
                          }
                          items={noMatchOptions}
                        >
                          <SelectTrigger
                            id="date-no-match"
                            aria-label="No match"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="empty">
                              Display empty state
                            </SelectItem>
                            <SelectItem value="fallback_text">
                              Show fallback text
                            </SelectItem>
                            <SelectItem value="next_available">
                              Show next available
                            </SelectItem>
                            <SelectItem value="hide">
                              Hide Widget or binding
                            </SelectItem>
                            <SelectItem value="last_known_good">
                              Use last-known-good record
                            </SelectItem>
                          </SelectContent>
                        </RheaSelect>
                      </Field>
                    </div>
                    {configuration.dateSelection.mode === "custom_range" && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field>
                          <FieldLabel htmlFor="date-start">
                            Start date
                          </FieldLabel>
                          <Input
                            id="date-start"
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
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="date-end">End date</FieldLabel>
                          <Input
                            id="date-end"
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
                        </Field>
                      </div>
                    )}
                    {configuration.dateSelection.noMatchBehavior ===
                      "fallback_text" && (
                      <Field>
                        <FieldLabel htmlFor="date-fallback">
                          Fallback text
                        </FieldLabel>
                        <Input
                          id="date-fallback"
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
                      </Field>
                    )}
                    {/* The wrapping label names the switch; an extra aria-label
                        would double the accessible name. */}
                    <label className="flex items-center gap-2 text-sm">
                      <RheaSwitch
                        checked={configuration.dateSelection.excludePast}
                        disabled={readOnly}
                        onCheckedChange={(checked) =>
                          setConfiguration((current) => ({
                            ...current,
                            dateSelection: {
                              ...current.dateSelection,
                              excludePast: checked === true,
                            },
                          }))
                        }
                      />
                      <span>Exclude past records</span>
                    </label>
                    <Field>
                      <FieldLabel htmlFor="preview-date">
                        Preview date
                      </FieldLabel>
                      <Input
                        id="preview-date"
                        type="date"
                        value={previewDate}
                        onChange={(event) => setPreviewDate(event.target.value)}
                      />
                    </Field>
                  </>
                )}
              </fieldset>
            </>
          )}
          <fieldset className="grid gap-3">
            <legend className="text-sm font-medium">Record filters</legend>
            <div className="grid gap-2">
              {(configuration.filters ?? []).map((filter, index) => (
                <div
                  className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-center"
                  key={index}
                >
                  <Input
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
                  <RheaSelect
                    value={filter.operator}
                    disabled={readOnly}
                    onValueChange={(next) =>
                      setConfiguration((current) => ({
                        ...current,
                        filters: (current.filters ?? []).map(
                          (item, position) =>
                            position === index
                              ? {
                                  ...item,
                                  operator: next as "equals" | "contains",
                                }
                              : item,
                        ),
                      }))
                    }
                    items={filterOperatorOptions}
                  >
                    <SelectTrigger aria-label="Filter operator">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="equals">Equals</SelectItem>
                      <SelectItem value="contains">Contains</SelectItem>
                    </SelectContent>
                  </RheaSelect>
                  <Input
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
                  <RheaButton
                    type="button"
                    variant="ghost"
                    size="icon"
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
                    <Trash2 size={15} aria-hidden="true" />
                  </RheaButton>
                </div>
              ))}
              {!readOnly && (configuration.filters?.length ?? 0) < 8 && (
                <RheaButton
                  type="button"
                  variant="ghost"
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
                  <Plus size={15} aria-hidden="true" /> Add filter
                </RheaButton>
              )}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="structured-refresh">
                Refresh interval
              </FieldLabel>
              <RheaSelect
                value={configuration.refreshIntervalSeconds}
                disabled={readOnly || Boolean(configuration.uploaded)}
                onValueChange={(next) =>
                  setConfiguration((c) => ({
                    ...c,
                    refreshIntervalSeconds: Number(next),
                  }))
                }
                items={refreshOptions}
              >
                <SelectTrigger
                  id="structured-refresh"
                  aria-label="Refresh interval"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={300}>5 minutes</SelectItem>
                  <SelectItem value={900}>15 minutes</SelectItem>
                  <SelectItem value={3600}>Hourly</SelectItem>
                  <SelectItem value={21600}>6 hours</SelectItem>
                </SelectContent>
              </RheaSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="structured-empty-state">
                Empty state
              </FieldLabel>
              <Input
                id="structured-empty-state"
                value={configuration.emptyState}
                disabled={readOnly}
                onChange={(e) =>
                  setConfiguration((c) => ({
                    ...c,
                    emptyState: e.target.value,
                  }))
                }
              />
            </Field>
          </div>
          {diagnostics.data && (
            <div className="grid gap-1 rounded-xl border border-border bg-card p-3">
              <strong className="text-sm font-medium">
                Refresh diagnostics
              </strong>
              <span className="text-sm">
                {diagnostics.data.parseStatus} ·{" "}
                {diagnostics.data.httpResultCategory ?? "not attempted"} ·{" "}
                {diagnostics.data.availableItemCount} items
                {diagnostics.data.usingCachedData ? " · cached data" : ""}
              </span>
              <small className="text-xs text-muted-foreground">
                Last attempt:{" "}
                {diagnostics.data.lastAttemptedRefresh
                  ? new Date(
                      diagnostics.data.lastAttemptedRefresh,
                    ).toLocaleString()
                  : "Not yet"}
              </small>
              <small className="text-xs text-muted-foreground">
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
            <div className="grid gap-2 rounded-xl border border-border bg-card p-3">
              <strong className="text-sm font-medium">
                {preview.configuration.data.records.length} mapped items
              </strong>
              {preview.configuration.data.records.slice(0, 8).map((record) => (
                <article
                  key={record.id}
                  className="grid gap-0.5 border-b border-border pb-2 last:border-0 last:pb-0"
                >
                  <strong className="text-sm font-medium">
                    {record.title || "Untitled item"}
                  </strong>
                  {record.subtitle && (
                    <span className="text-sm text-muted-foreground">
                      {record.subtitle}
                    </span>
                  )}
                  {record.date && (
                    <small className="text-xs text-muted-foreground">
                      {record.date}
                    </small>
                  )}
                </article>
              ))}
            </div>
          )}
          {(previewMutation.error || save.error) && (
            <Alert variant="destructive">
              <AlertDescription>
                {(previewMutation.error ?? save.error)?.message}
              </AlertDescription>
            </Alert>
          )}
        </div>
        <footer className="flex flex-wrap items-center gap-2">
          <RheaButton
            type="button"
            variant="outline"
            disabled={previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            {previewMutation.isPending
              ? "Loading preview…"
              : "Preview mapped data"}
          </RheaButton>
          {!readOnly && (
            <RheaButton
              type="button"
              disabled={save.isPending || !name.trim()}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save Data Source"}
            </RheaButton>
          )}
        </footer>
      </section>
    </div>
  );
}

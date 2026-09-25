import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiErrorMessage, useFormatLocale } from "../../i18n";
import { api } from "../../api/client";
import { toast } from "../../components/ui/toast";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { DateInput } from "../../components/date-picker";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Field, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import type {
  DataSourceDetail,
  StructuredField,
  StructuredInspection,
  StructuredValueType,
  StructuredPreview,
  StructuredSourceConfig,
} from "../../api/types";
import { useOrganizationRegionalProfile } from "../../settings/regionalProfile";
import { formatRegionalDateTimeValue } from "../../settings/regionalFormatting";
import { CsvSourceInput } from "../CsvSourceInput";
import { optionLabel } from "./shared";

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
  // i18n-ignore: default stored content the author edits, rendered on screens
  emptyState: "No items available",
  dateSelection: {
    enabled: false,
    dateFormat: "auto",
    timezone: "UTC",
    mode: "today",
    excludePast: false,
    noMatchBehavior: "empty",
  },
});

const structuredFieldKeys = {
  title: "dataSources.structured.fieldTitle",
  subtitle: "dataSources.structured.fieldSubtitle",
  date: "dataSources.structured.fieldDate",
  author: "dataSources.structured.fieldAuthor",
  description: "dataSources.structured.fieldDescription",
  image: "dataSources.structured.fieldImage",
  link: "dataSources.structured.fieldLink",
} as const;

const mappingFieldKeys = {
  rootList: "dataSources.structured.mappingRootList",
  title: "dataSources.structured.fieldTitle",
  subtitle: "dataSources.structured.fieldSubtitle",
  date: "dataSources.structured.fieldDate",
  imageUrl: "dataSources.structured.mappingImageUrl",
  link: "dataSources.structured.fieldLink",
} as const;

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
  const { t } = useTranslation(["content", "common"]);
  if (!detectable)
    return (
      <p className="text-sm text-muted-foreground">
        {t(
          provider === "csv"
            ? "dataSources.structured.detectionWaitingCsv"
            : "dataSources.structured.detectionWaitingEndpoint",
        )}
      </p>
    );
  if (inspection.isPending)
    return (
      <p className="text-sm text-muted-foreground">
        {t("dataSources.structured.detectionReading")}
      </p>
    );
  if (inspection.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {inspection.error instanceof Error
            ? apiErrorMessage(inspection.error)
            : t("dataSources.structured.detectionReadError")}{" "}
          {t("dataSources.structured.detectionMapByName")}
        </AlertDescription>
      </Alert>
    );
  if (!inspection.data) return null;
  const detected = inspection.data;
  return (
    <p className="text-sm text-muted-foreground">
      {t("dataSources.structured.detectionSummary", {
        fields: t(
          provider === "csv"
            ? "dataSources.structured.detectionColumns"
            : "dataSources.structured.detectionFields",
          { count: detected.fields.length },
        ),
        rows: t("dataSources.structured.detectionRows", {
          count: detected.rowCount,
        }),
        delimiter: detected.delimiter
          ? t("dataSources.structured.detectionDelimited", {
              label:
                detected.delimiter in delimiterLabelKeys
                  ? t(
                      delimiterLabelKeys[
                        detected.delimiter as keyof typeof delimiterLabelKeys
                      ],
                    )
                  : t("dataSources.structured.detectionDetected"),
            })
          : "",
      })}
    </p>
  );
}

// The Server caps a mapping at a dozen values, keeping both the form and the record it
// produces readable.
const maximumValueFields = 12;

// URL is a technical token: every language repeats it verbatim.
const valueTypeOptions = [
  { value: "text", labelKey: "dataSources.options.text" },
  { value: "number", labelKey: "dataSources.options.number" },
  { value: "date", labelKey: "dataSources.options.date" },
  { value: "datetime", labelKey: "dataSources.options.datetime" },
  { value: "url", labelKey: "dataSources.options.url" },
] as const;

const presentationOptions = [
  { value: "list", labelKey: "dataSources.options.list" },
  { value: "agenda", labelKey: "dataSources.options.agenda" },
  { value: "cards", labelKey: "dataSources.options.cards" },
  { value: "ticker", labelKey: "dataSources.options.ticker" },
] as const;

const sortOptions = [
  { value: "newest", labelKey: "dataSources.options.newest" },
  { value: "oldest", labelKey: "dataSources.options.oldest" },
  { value: "title", labelKey: "dataSources.options.titleSort" },
  { value: "source", labelKey: "dataSources.options.originalOrder" },
] as const;

const delimiterOptions = [
  { value: "", labelKey: "dataSources.options.detect" },
  { value: ",", labelKey: "dataSources.options.comma" },
  { value: ";", labelKey: "dataSources.options.semicolon" },
  { value: "\t", labelKey: "dataSources.options.tab" },
  { value: "|", labelKey: "dataSources.options.pipe" },
] as const;

// Date format samples (YYYY-MM-DD, RFC 3339, …) are code, not prose: every
// language repeats them verbatim under these keys.
const dateFormatOptions = [
  { value: "auto", labelKey: "dataSources.options.dateAutoSafe" },
  { value: "iso_date", labelKey: "dataSources.options.dateIso" },
  { value: "us_date", labelKey: "dataSources.options.dateUs" },
  { value: "us_short", labelKey: "dataSources.options.dateUsShort" },
  { value: "day_first_date", labelKey: "dataSources.options.dateDayFirst" },
  {
    value: "day_first_short",
    labelKey: "dataSources.options.dateDayFirstShort",
  },
  { value: "day_month_name", labelKey: "dataSources.options.dateDayMonth" },
  { value: "rfc3339", labelKey: "dataSources.options.dateRfc3339" },
] as const;

const dateModeOptions = [
  { value: "today", labelKey: "dataSources.options.today" },
  { value: "tomorrow", labelKey: "dataSources.options.tomorrow" },
  { value: "next_available", labelKey: "dataSources.options.nextAvailable" },
  { value: "current_week", labelKey: "dataSources.options.currentWeek" },
  { value: "custom_range", labelKey: "dataSources.options.customRange" },
] as const;

const noMatchOptions = [
  { value: "empty", labelKey: "dataSources.structured.noMatchEmpty" },
  {
    value: "fallback_text",
    labelKey: "dataSources.structured.noMatchFallback",
  },
  {
    value: "next_available",
    labelKey: "dataSources.structured.noMatchNext",
  },
  { value: "hide", labelKey: "dataSources.structured.noMatchHide" },
  {
    value: "last_known_good",
    labelKey: "dataSources.structured.noMatchLastGood",
  },
] as const;

const filterOperatorOptions = [
  { value: "equals", labelKey: "dataSources.options.equals" },
  { value: "contains", labelKey: "dataSources.options.contains" },
] as const;

const refreshOptions = [
  { value: 300, labelKey: "dataSources.durations.minutes5" },
  { value: 900, labelKey: "dataSources.durations.minutes15" },
  { value: 3600, labelKey: "dataSources.durations.hourly" },
  { value: 21600, labelKey: "dataSources.durations.hours6" },
] as const;

// delimiterLabelKeys names the detected delimiter for the detection summary.
// The keys stay literal so t() type-checks.
const delimiterLabelKeys = {
  ",": "dataSources.structured.delimiterComma",
  ";": "dataSources.structured.delimiterSemicolon",
  "\t": "dataSources.structured.delimiterTab",
  "|": "dataSources.structured.delimiterPipe",
} as const;

// detectedFieldOptionLabel shows a detected field with its first sample value.
// Both are server-provided data, never interface copy.
function detectedFieldOptionLabel(field: StructuredField) {
  if (field.samples.length === 0) return field.label;
  return `${field.label} — ${field.samples[0]}`; // i18n-ignore: server-detected field label and sample value
}

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
  const { t } = useTranslation(["content", "common"]);
  const id = useId();
  const known = fields.some((field) => field.key === value);
  const selected = fields.find((field) => field.key === value);
  const selectedText = selected
    ? selected.samples.length > 0
      ? `${selected.label} — ${selected.samples[0]}` // i18n-ignore: server-detected field label and sample value
      : selected.label
    : null;
  const notUsed = t("dataSources.options.notUsed");
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
      <Select
        items={[
          { value: "", label: notUsed },
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
          <SelectValue>
            {value
              ? (selectedText ??
                t("dataSources.structured.valueNotFound", { value }))
              : notUsed}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">{notUsed}</SelectItem>
          {fields.map((field) => (
            <SelectItem key={field.key} value={field.key}>
              {detectedFieldOptionLabel(field)}
            </SelectItem>
          ))}
          {value && !known && (
            <SelectItem value={value}>
              {t("dataSources.structured.valueNotFound", { value })}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
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
  const { t } = useTranslation(["content", "common"]);
  const locale = useFormatLocale();
  const regional = useOrganizationRegionalProfile();
  const touchedTimezone = useRef(false);
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
  useEffect(() => {
    if (dataSource || !regional.ready || touchedTimezone.current) return;
    setConfiguration((current) => ({
      ...current,
      dateSelection: {
        ...current.dateSelection,
        timezone: regional.timezone,
      },
    }));
  }, [dataSource, regional.ready, regional.timezone]);
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
              {t(
                dataSource
                  ? "dataSources.structured.titleEdit"
                  : "dataSources.structured.titleCreate",
                // The provider code (RSS, JSON, CSV, ATOM) interpolates untranslated.
                { provider: provider.toUpperCase() },
              )}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("dataSources.structured.description")}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("common:actions.close")}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="grid min-w-0 gap-5">
          <Field>
            <FieldLabel htmlFor="structured-name">
              {t("dataSources.editor.name")}
            </FieldLabel>
            <Input
              id="structured-name"
              value={name}
              disabled={readOnly}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="structured-description">
              {t("dataSources.editor.description")}
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
                {t(
                  provider === "json"
                    ? "dataSources.structured.apiUrl"
                    : "dataSources.structured.feedUrl",
                )}
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
                {t("dataSources.structured.presentation")}
              </FieldLabel>
              <Select
                value={configuration.presentation}
                disabled={readOnly}
                onValueChange={(next) =>
                  setConfiguration((c) => ({
                    ...c,
                    presentation:
                      next as StructuredSourceConfig["presentation"],
                  }))
                }
                items={presentationOptions.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
              >
                <SelectTrigger
                  id="structured-presentation"
                  aria-label={t("dataSources.structured.presentation")}
                >
                  <SelectValue>
                    {optionLabel(
                      presentationOptions.map((option) => ({
                        value: option.value,
                        label: t(option.labelKey),
                      })),
                      configuration.presentation,
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {presentationOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="structured-max-items">
                {t("dataSources.structured.maxItems")}
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
              <legend className="text-sm font-medium">
                {t("dataSources.structured.displayedFields")}
              </legend>
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
                      <Checkbox
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
                      <span>{t(structuredFieldKeys[field])}</span>
                    </label>
                  ))}
              </div>
              {inspection.data && (
                <p className="text-sm text-muted-foreground">
                  {t("dataSources.structured.feedItemsRead", {
                    count: inspection.data.rowCount,
                  })}
                </p>
              )}
            </fieldset>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="structured-keyword">
                {t("dataSources.editor.keywordFilter")}
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
              <FieldLabel htmlFor="structured-sort">
                {t("dataSources.structured.sort")}
              </FieldLabel>
              <Select
                value={configuration.sort}
                disabled={readOnly}
                onValueChange={(next) =>
                  setConfiguration((c) => ({
                    ...c,
                    sort: next as StructuredSourceConfig["sort"],
                  }))
                }
                items={sortOptions.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
              >
                <SelectTrigger
                  id="structured-sort"
                  aria-label={t("dataSources.structured.sort")}
                >
                  <SelectValue>
                    {optionLabel(
                      sortOptions.map((option) => ({
                        value: option.value,
                        label: t(option.labelKey),
                      })),
                      configuration.sort,
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {sortOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {(provider === "json" || provider === "csv") && mapping && (
            <>
              <fieldset className="grid gap-3">
                <legend className="text-sm font-medium">
                  {t("dataSources.structured.fieldMapping")}
                </legend>
                <StructuredDetectionNotice
                  provider={provider}
                  detectable={detectable}
                  inspection={inspection}
                />
                {provider === "json" && (
                  <Field>
                    <FieldLabel htmlFor="mapping-root-list">
                      {t(mappingFieldKeys.rootList)}
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
                        label={t(mappingFieldKeys[key])}
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
                    <FieldLabel htmlFor="csv-delimiter">
                      {t("dataSources.structured.delimiter")}
                    </FieldLabel>
                    <Select
                      value={configuration.delimiter ?? ""}
                      disabled={readOnly}
                      onValueChange={(next) =>
                        setConfiguration((c) => ({
                          ...c,
                          delimiter:
                            next as StructuredSourceConfig["delimiter"],
                        }))
                      }
                      items={delimiterOptions.map((option) => ({
                        value: option.value,
                        label: t(option.labelKey),
                      }))}
                    >
                      <SelectTrigger
                        id="csv-delimiter"
                        aria-label={t("dataSources.structured.delimiter")}
                      >
                        <SelectValue>
                          {optionLabel(
                            delimiterOptions.map((option) => ({
                              value: option.value,
                              label: t(option.labelKey),
                            })),
                            configuration.delimiter ?? "",
                          )}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {delimiterOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {t(option.labelKey)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
                <div className="grid gap-2">
                  <strong className="text-sm font-medium">
                    {t("dataSources.structured.optionalValues")}
                  </strong>
                  <small className="text-xs text-muted-foreground">
                    {t("dataSources.structured.optionalValuesHint")}
                  </small>
                  {Object.entries(mapping.valueFields ?? {}).map(
                    ([label, path]) => (
                      <div
                        className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-center"
                        key={label}
                      >
                        <Input
                          aria-label={t("dataSources.structured.valueLabel")}
                          value={label}
                          disabled={readOnly}
                          onChange={(event) =>
                            renameValueField(label, event.target.value)
                          }
                        />
                        <Input
                          aria-label={t("dataSources.structured.valuePath")}
                          value={path}
                          disabled={readOnly}
                          onChange={(event) =>
                            setValueField(label, event.target.value)
                          }
                        />
                        <Select
                          value={mapping.valueFieldTypes?.[label] ?? "text"}
                          disabled={readOnly}
                          onValueChange={(next) =>
                            setValueFieldType(
                              label,
                              next as StructuredValueType,
                            )
                          }
                          items={valueTypeOptions.map((option) => ({
                            value: option.value,
                            label: t(option.labelKey),
                          }))}
                        >
                          <SelectTrigger
                            aria-label={t("dataSources.structured.valueType", {
                              label,
                            })}
                          >
                            <SelectValue>
                              {optionLabel(
                                valueTypeOptions.map((option) => ({
                                  value: option.value,
                                  label: t(option.labelKey),
                                })),
                                mapping.valueFieldTypes?.[label] ?? "text",
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {valueTypeOptions.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {t(option.labelKey)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t("dataSources.structured.removeValue", {
                            label,
                          })}
                          disabled={readOnly}
                          onClick={() => removeValueField(label)}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </Button>
                      </div>
                    ),
                  )}
                  {!readOnly &&
                    unmappedTimestamps.length > 0 &&
                    Object.keys(mapping.valueFields ?? {}).length <
                      maximumValueFields && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={addTimestampValues}
                      >
                        <Plus size={15} aria-hidden="true" />{" "}
                        {t("dataSources.structured.addTimestamps", {
                          count: unmappedTimestamps.length,
                        })}
                      </Button>
                    )}
                  {!readOnly &&
                    Object.keys(mapping.valueFields ?? {}).length <
                      maximumValueFields && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          // Generated default value label the author renames.
                          setValueField(
                            `Value ${Object.keys(mapping.valueFields ?? {}).length + 1}`,
                            provider === "json" ? "/value" : "value",
                          )
                        }
                      >
                        <Plus size={15} aria-hidden="true" />{" "}
                        {t("dataSources.structured.addValue")}
                      </Button>
                    )}
                </div>
              </fieldset>
              <fieldset className="grid gap-3">
                <legend className="text-sm font-medium">
                  {t("dataSources.structured.dateAware")}
                </legend>
                <label className="flex items-start gap-2 text-sm">
                  <Switch
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
                    aria-label={t("dataSources.structured.selectByLocalDate")}
                    className="mt-0.5"
                  />
                  <span className="grid gap-0.5">
                    <strong className="font-medium">
                      {t("dataSources.structured.selectByLocalDate")}
                    </strong>
                    <small className="text-xs text-muted-foreground">
                      {t("dataSources.structured.selectByLocalDateHint")}
                    </small>
                  </span>
                </label>
                {configuration.dateSelection.enabled && (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="date-format">
                          {t("dataSources.structured.dateFormat")}
                        </FieldLabel>
                        <Select
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
                          items={dateFormatOptions.map((option) => ({
                            value: option.value,
                            label: t(option.labelKey),
                          }))}
                        >
                          <SelectTrigger
                            id="date-format"
                            aria-label={t("dataSources.structured.dateFormat")}
                          >
                            <SelectValue>
                              {optionLabel(
                                dateFormatOptions.map((option) => ({
                                  value: option.value,
                                  label: t(option.labelKey),
                                })),
                                configuration.dateSelection.dateFormat,
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {dateFormatOptions.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {t(option.labelKey)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="date-timezone">
                          {t("dataSources.editor.timezone")}
                        </FieldLabel>
                        <Input
                          id="date-timezone"
                          value={configuration.dateSelection.timezone}
                          disabled={readOnly}
                          onChange={(event) => {
                            touchedTimezone.current = true;
                            setConfiguration((current) => ({
                              ...current,
                              dateSelection: {
                                ...current.dateSelection,
                                timezone: event.target.value,
                              },
                            }));
                          }}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="date-mode">
                          {t("dataSources.manual.selection")}
                        </FieldLabel>
                        <Select
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
                          items={dateModeOptions.map((option) => ({
                            value: option.value,
                            label: t(option.labelKey),
                          }))}
                        >
                          <SelectTrigger
                            id="date-mode"
                            aria-label={t("dataSources.manual.selection")}
                          >
                            <SelectValue>
                              {optionLabel(
                                dateModeOptions.map((option) => ({
                                  value: option.value,
                                  label: t(option.labelKey),
                                })),
                                configuration.dateSelection.mode,
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {dateModeOptions.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {t(option.labelKey)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="date-no-match">
                          {t("dataSources.structured.noMatch")}
                        </FieldLabel>
                        <Select
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
                          items={noMatchOptions.map((option) => ({
                            value: option.value,
                            label: t(option.labelKey),
                          }))}
                        >
                          <SelectTrigger
                            id="date-no-match"
                            aria-label={t("dataSources.structured.noMatch")}
                          >
                            <SelectValue>
                              {optionLabel(
                                noMatchOptions.map((option) => ({
                                  value: option.value,
                                  label: t(option.labelKey),
                                })),
                                configuration.dateSelection.noMatchBehavior,
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {noMatchOptions.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {t(option.labelKey)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>
                    {configuration.dateSelection.mode === "custom_range" && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field>
                          <FieldLabel htmlFor="date-start">
                            {t("dataSources.structured.startDate")}
                          </FieldLabel>
                          <DateInput
                            id="date-start"
                            value={
                              configuration.dateSelection.customStartDate ?? ""
                            }
                            disabled={readOnly}
                            onChange={(value) =>
                              setConfiguration((current) => ({
                                ...current,
                                dateSelection: {
                                  ...current.dateSelection,
                                  customStartDate: value,
                                },
                              }))
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="date-end">
                            {t("dataSources.structured.endDate")}
                          </FieldLabel>
                          <DateInput
                            id="date-end"
                            value={
                              configuration.dateSelection.customEndDate ?? ""
                            }
                            disabled={readOnly}
                            onChange={(value) =>
                              setConfiguration((current) => ({
                                ...current,
                                dateSelection: {
                                  ...current.dateSelection,
                                  customEndDate: value,
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
                          {t("dataSources.structured.fallbackText")}
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
                      <Switch
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
                      <span>{t("dataSources.structured.excludePast")}</span>
                    </label>
                    <Field>
                      <FieldLabel htmlFor="preview-date">
                        {t("dataSources.structured.previewDate")}
                      </FieldLabel>
                      <DateInput
                        id="preview-date"
                        value={previewDate}
                        onChange={setPreviewDate}
                      />
                    </Field>
                  </>
                )}
              </fieldset>
            </>
          )}
          <fieldset className="grid gap-3">
            <legend className="text-sm font-medium">
              {t("dataSources.structured.recordFilters")}
            </legend>
            <div className="grid gap-2">
              {(configuration.filters ?? []).map((filter, index) => (
                <div
                  className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-center"
                  key={index}
                >
                  <Input
                    aria-label={t("dataSources.structured.filterField")}
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
                    items={filterOperatorOptions.map((option) => ({
                      value: option.value,
                      label: t(option.labelKey),
                    }))}
                  >
                    <SelectTrigger
                      aria-label={t("dataSources.structured.filterOperator")}
                    >
                      <SelectValue>
                        {optionLabel(
                          filterOperatorOptions.map((option) => ({
                            value: option.value,
                            label: t(option.labelKey),
                          })),
                          filter.operator,
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {filterOperatorOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {t(option.labelKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    aria-label={t("dataSources.structured.filterValue")}
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("dataSources.structured.removeFilter")}
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
                  </Button>
                </div>
              ))}
              {!readOnly && (configuration.filters?.length ?? 0) < 8 && (
                <Button
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
                  <Plus size={15} aria-hidden="true" />{" "}
                  {t("dataSources.structured.addFilter")}
                </Button>
              )}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="structured-refresh">
                {t("dataSources.editor.refreshInterval")}
              </FieldLabel>
              <Select
                value={configuration.refreshIntervalSeconds}
                disabled={readOnly || Boolean(configuration.uploaded)}
                onValueChange={(next) =>
                  setConfiguration((c) => ({
                    ...c,
                    refreshIntervalSeconds: Number(next),
                  }))
                }
                items={refreshOptions.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
              >
                <SelectTrigger
                  id="structured-refresh"
                  aria-label={t("dataSources.editor.refreshInterval")}
                >
                  <SelectValue>
                    {optionLabel(
                      refreshOptions.map((option) => ({
                        value: option.value,
                        label: t(option.labelKey),
                      })),
                      configuration.refreshIntervalSeconds,
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {refreshOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="structured-empty-state">
                {t("dataSources.editor.emptyState")}
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
                {t("dataSources.diagnostics.title")}
              </strong>
              <span className="text-sm">
                {diagnostics.data.parseStatus} ·{" "}
                {diagnostics.data.httpResultCategory ??
                  t("dataSources.diagnostics.notAttempted")}{" "}
                ·{" "}
                {t("dataSources.diagnostics.items", {
                  count: diagnostics.data.availableItemCount,
                })}
                {diagnostics.data.usingCachedData
                  ? t("dataSources.diagnostics.cachedSuffix")
                  : ""}
              </span>
              <small className="text-xs text-muted-foreground">
                {t("dataSources.diagnostics.lastAttempt", {
                  value: diagnostics.data.lastAttemptedRefresh
                    ? new Date(
                        diagnostics.data.lastAttemptedRefresh,
                      ).toLocaleString(locale)
                    : t("dataSources.diagnostics.notYet"),
                })}
              </small>
              <small className="text-xs text-muted-foreground">
                {t("dataSources.diagnostics.lastSuccess", {
                  value: diagnostics.data.lastSuccessfulRefresh
                    ? new Date(
                        diagnostics.data.lastSuccessfulRefresh,
                      ).toLocaleString(locale)
                    : t("dataSources.diagnostics.notYet"),
                })}
              </small>
            </div>
          )}
          {preview && (
            <div className="grid gap-2 rounded-xl border border-border bg-card p-3">
              <strong className="text-sm font-medium">
                {t("dataSources.structured.mappedItems", {
                  count: preview.configuration.data.records.length,
                })}
              </strong>
              {preview.configuration.data.records.slice(0, 8).map((record) => (
                <article
                  key={record.id}
                  className="grid gap-0.5 border-b border-border pb-2 last:border-0 last:pb-0"
                >
                  <strong className="text-sm font-medium">
                    {record.title || t("dataSources.structured.untitledItem")}
                  </strong>
                  {record.subtitle && (
                    <span className="text-sm text-muted-foreground">
                      {record.subtitle}
                    </span>
                  )}
                  {record.date && (
                    <small className="text-xs text-muted-foreground">
                      {formatRegionalDateTimeValue(
                        record.date,
                        record.date.includes("T") ? "datetime" : "date",
                        {
                          ...regional,
                          timezone:
                            configuration.dateSelection.timezone ||
                            regional.timezone,
                        },
                      )}
                    </small>
                  )}
                </article>
              ))}
            </div>
          )}
          {(previewMutation.error || save.error) && (
            <Alert variant="destructive">
              <AlertDescription>
                {apiErrorMessage(previewMutation.error ?? save.error)}
              </AlertDescription>
            </Alert>
          )}
        </div>
        <footer className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            {previewMutation.isPending
              ? t("dataSources.preview.loading")
              : t("dataSources.preview.mappedData")}
          </Button>
          {!readOnly && (
            <Button
              type="button"
              disabled={save.isPending || !name.trim()}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t("common:actions.saving")
                : t("dataSources.editor.save")}
            </Button>
          )}
        </footer>
      </section>
    </div>
  );
}

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import { api } from "../../api/client";
import { apiErrorMessage, useFormatLocale } from "../../i18n";
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
import type { ContentT } from "../dataSourceProviderMeta";
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
  t: ContentT,
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
  emptyState: t("sources.structured.defaultEmptyState"),
  dateSelection: {
    enabled: false,
    dateFormat: "auto",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    mode: "today",
    excludePast: false,
    noMatchBehavior: "empty",
  },
});

type StructuredFieldLabelKey =
  | "sources.structured.fieldTitle"
  | "sources.structured.fieldSubtitle"
  | "sources.structured.fieldDate"
  | "sources.structured.fieldAuthor"
  | "sources.structured.fieldDescription"
  | "sources.structured.fieldImage"
  | "sources.structured.fieldLink";

const structuredFieldLabelKeys: Record<
  keyof StructuredSourceConfig["fields"],
  StructuredFieldLabelKey
> = {
  title: "sources.structured.fieldTitle",
  subtitle: "sources.structured.fieldSubtitle",
  date: "sources.structured.fieldDate",
  author: "sources.structured.fieldAuthor",
  description: "sources.structured.fieldDescription",
  image: "sources.structured.fieldImage",
  link: "sources.structured.fieldLink",
};

type MappingFieldLabelKey =
  | "sources.structured.mappingRootList"
  | StructuredFieldLabelKey
  | "sources.structured.fieldImageUrl";

const mappingFieldLabelKeys: Record<
  "rootList" | "title" | "subtitle" | "date" | "imageUrl" | "link",
  MappingFieldLabelKey
> = {
  rootList: "sources.structured.mappingRootList",
  title: "sources.structured.fieldTitle",
  subtitle: "sources.structured.fieldSubtitle",
  date: "sources.structured.fieldDate",
  imageUrl: "sources.structured.fieldImageUrl",
  link: "sources.structured.fieldLink",
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
  const { t } = useTranslation("content");
  if (!detectable)
    return (
      <p className="text-sm text-muted-foreground">
        {provider === "csv"
          ? t("sources.structured.detectionCsvHint")
          : t("sources.structured.detectionEndpointHint")}
      </p>
    );
  if (inspection.isPending)
    return (
      <p className="text-sm text-muted-foreground">
        {t("sources.structured.detectionPending")}
      </p>
    );
  if (inspection.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {inspection.error instanceof Error
            ? apiErrorMessage(inspection.error)
            : t("sources.structured.detectionFailed")}{" "}
          {t("sources.structured.detectionFallback")}
        </AlertDescription>
      </Alert>
    );
  if (!inspection.data) return null;
  const detected = inspection.data;
  const suffixKey = detected.delimiter
    ? (delimiterSuffixKeys[detected.delimiter] ??
      "sources.structured.delimiterSuffixUnknown")
    : undefined;
  return (
    <p className="text-sm text-muted-foreground">
      {t(
        provider === "csv"
          ? "sources.structured.detectedColumns"
          : "sources.structured.detectedFields",
        { count: detected.fields.length },
      )}{" "}
      {t("sources.structured.detectedRows", { count: detected.rowCount })}
      {suffixKey ? t(suffixKey) : ""}.
    </p>
  );
}

// The Server caps a mapping at a dozen values, keeping both the form and the record it
// produces readable.
const maximumValueFields = 12;

const valueTypeOptions = [
  { value: "text", labelKey: "sources.structured.valueText" },
  { value: "number", labelKey: "sources.structured.valueNumber" },
  { value: "date", labelKey: "sources.structured.valueDate" },
  { value: "datetime", labelKey: "sources.structured.valueDatetime" },
  { value: "url", labelKey: "sources.structured.valueUrl" },
] as const;

const presentationOptions = [
  { value: "list", labelKey: "sources.structured.presentationList" },
  { value: "agenda", labelKey: "sources.structured.presentationAgenda" },
  { value: "cards", labelKey: "sources.structured.presentationCards" },
  { value: "ticker", labelKey: "sources.structured.presentationTicker" },
] as const;

const sortOptions = [
  { value: "newest", labelKey: "sources.structured.sortNewest" },
  { value: "oldest", labelKey: "sources.structured.sortOldest" },
  { value: "title", labelKey: "sources.structured.sortTitle" },
  { value: "source", labelKey: "sources.structured.sortSource" },
] as const;

const delimiterOptions = [
  { value: "", labelKey: "sources.structured.delimiterDetect" },
  { value: ",", labelKey: "sources.structured.delimiterComma" },
  { value: ";", labelKey: "sources.structured.delimiterSemicolon" },
  { value: "\t", labelKey: "sources.structured.delimiterTab" },
  { value: "|", labelKey: "sources.structured.delimiterPipe" },
] as const;

const dateFormatOptions = [
  { value: "auto", labelKey: "sources.structured.dateFormatDetect" },
  { value: "iso_date", labelKey: "sources.structured.dateFormatIso" },
  { value: "us_date", labelKey: "sources.structured.dateFormatUs" },
  { value: "us_short", labelKey: "sources.structured.dateFormatUsShort" },
  { value: "day_month_name", labelKey: "sources.structured.dateFormatNamed" },
  { value: "rfc3339", labelKey: "sources.structured.dateFormatRfc" },
] as const;

const dateModeOptions = [
  { value: "today", labelKey: "sources.structured.modeToday" },
  { value: "tomorrow", labelKey: "sources.structured.modeTomorrow" },
  { value: "next_available", labelKey: "sources.structured.modeNextAvailable" },
  { value: "current_week", labelKey: "sources.structured.modeCurrentWeek" },
  { value: "custom_range", labelKey: "sources.structured.modeCustomRange" },
] as const;

const noMatchOptions = [
  { value: "empty", labelKey: "sources.structured.noMatchEmpty" },
  { value: "fallback_text", labelKey: "sources.structured.noMatchFallback" },
  { value: "next_available", labelKey: "sources.structured.noMatchNext" },
  { value: "hide", labelKey: "sources.structured.noMatchHide" },
  {
    value: "last_known_good",
    labelKey: "sources.structured.noMatchLastGood",
  },
] as const;

const filterOperatorOptions = [
  { value: "equals", labelKey: "sources.structured.operatorEquals" },
  { value: "contains", labelKey: "sources.structured.operatorContains" },
] as const;

const refreshOptions = [
  { value: 300, labelKey: "sources.structured.refresh5" },
  { value: 900, labelKey: "sources.structured.refresh15" },
  { value: 3600, labelKey: "sources.structured.refreshHour" },
  { value: 21600, labelKey: "sources.structured.refresh6h" },
] as const;

type DelimiterSuffixKey =
  | "sources.structured.delimiterSuffixComma"
  | "sources.structured.delimiterSuffixSemicolon"
  | "sources.structured.delimiterSuffixTab"
  | "sources.structured.delimiterSuffixPipe"
  | "sources.structured.delimiterSuffixUnknown";

const delimiterSuffixKeys: Record<string, DelimiterSuffixKey> = {
  ",": "sources.structured.delimiterSuffixComma",
  ";": "sources.structured.delimiterSuffixSemicolon",
  "\t": "sources.structured.delimiterSuffixTab",
  "|": "sources.structured.delimiterSuffixPipe",
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
  const { t } = useTranslation("content");
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
                t("sources.structured.mappingNotFound", { value }))
              : t("sources.structured.mappingNotUsed")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">
            {t("sources.structured.mappingNotUsed")}
          </SelectItem>
          {fields.map((field) => (
            <SelectItem key={field.key} value={field.key}>
              {field.samples.length > 0
                ? `${field.label} — ${field.samples[0]}`
                : field.label}
            </SelectItem>
          ))}
          {value && !known && (
            <SelectItem value={value}>
              {t("sources.structured.mappingNotFound", { value })}
            </SelectItem>
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
  const { t } = useTranslation(["content", "common"]);
  const locale = useFormatLocale();
  const localizeOptions = <V extends string | number>(
    options: readonly { value: V; labelKey: ParseKeys<"content"> }[],
  ) =>
    options.map((option) => ({
      value: option.value,
      label: t(option.labelKey),
    }));
  const sortItems = localizeOptions(sortOptions);
  const delimiterItems = localizeOptions(delimiterOptions);
  const dateFormatItems = localizeOptions(dateFormatOptions);
  const dateModeItems = localizeOptions(dateModeOptions);
  const noMatchItems = localizeOptions(noMatchOptions);
  const filterOperators = localizeOptions(filterOperatorOptions);
  const refreshItems = localizeOptions(refreshOptions);
  const valueTypes = localizeOptions(valueTypeOptions);
  const [name, setName] = useState(dataSource?.name ?? "");
  const [description, setDescription] = useState(dataSource?.description ?? "");
  const configured = dataSource?.configuration as
    StructuredSourceConfig | undefined;
  const defaults = defaultStructured(provider, t);
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
                  ? "sources.structured.editTitle"
                  : "sources.structured.createTitle",
                { provider: provider.toUpperCase() },
              )}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("sources.structured.frameDescription")}
            </p>
          </div>
          <RheaButton
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("common:actions.close")}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </RheaButton>
        </div>
        <div className="grid min-w-0 gap-5">
          <Field>
            <FieldLabel htmlFor="structured-name">
              {t("sources.shared.name")}
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
              {t("sources.shared.description")}
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
                {provider === "json"
                  ? t("sources.structured.apiUrl")
                  : t("sources.structured.feedUrl")}
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
                {t("sources.structured.presentation")}
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
              >
                <SelectTrigger
                  id="structured-presentation"
                  aria-label={t("sources.structured.presentation")}
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
                  <SelectItem value="list">
                    {t("sources.structured.presentationList")}
                  </SelectItem>
                  <SelectItem value="agenda">
                    {t("sources.structured.presentationAgenda")}
                  </SelectItem>
                  <SelectItem value="cards">
                    {t("sources.structured.presentationCards")}
                  </SelectItem>
                  <SelectItem value="ticker">
                    {t("sources.structured.presentationTicker")}
                  </SelectItem>
                </SelectContent>
              </RheaSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="structured-max-items">
                {t("sources.structured.maxItems")}
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
                {t("sources.structured.displayedFields")}
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
                      <span>{t(structuredFieldLabelKeys[field])}</span>
                    </label>
                  ))}
              </div>
              {inspection.data && (
                <p className="text-sm text-muted-foreground">
                  {t("sources.structured.feedRowCount", {
                    count: inspection.data.rowCount,
                  })}
                </p>
              )}
            </fieldset>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="structured-keyword">
                {t("sources.structured.keywordFilter")}
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
                {t("sources.structured.sort")}
              </FieldLabel>
              <RheaSelect
                value={configuration.sort}
                disabled={readOnly}
                onValueChange={(next) =>
                  setConfiguration((c) => ({
                    ...c,
                    sort: next as StructuredSourceConfig["sort"],
                  }))
                }
              >
                <SelectTrigger
                  id="structured-sort"
                  aria-label={t("sources.structured.sort")}
                >
                  <SelectValue>
                    {optionLabel(sortItems, configuration.sort)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {sortItems.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
          </div>
          {(provider === "json" || provider === "csv") && mapping && (
            <>
              <fieldset className="grid gap-3">
                <legend className="text-sm font-medium">
                  {t("sources.structured.fieldMapping")}
                </legend>
                <StructuredDetectionNotice
                  provider={provider}
                  detectable={detectable}
                  inspection={inspection}
                />
                {provider === "json" && (
                  <Field>
                    <FieldLabel htmlFor="mapping-root-list">
                      {t("sources.structured.mappingRootList")}
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
                        label={t(mappingFieldLabelKeys[key])}
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
                      {t("sources.structured.delimiter")}
                    </FieldLabel>
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
                    >
                      <SelectTrigger
                        id="csv-delimiter"
                        aria-label={t("sources.structured.delimiter")}
                      >
                        <SelectValue>
                          {optionLabel(
                            delimiterItems,
                            configuration.delimiter ?? "",
                          )}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {delimiterItems.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </RheaSelect>
                  </Field>
                )}
                <div className="grid gap-2">
                  <strong className="text-sm font-medium">
                    {t("sources.structured.optionalValues")}
                  </strong>
                  <small className="text-xs text-muted-foreground">
                    {t("sources.structured.optionalValuesHint")}
                  </small>
                  {Object.entries(mapping.valueFields ?? {}).map(
                    ([label, path]) => (
                      <div
                        className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-center"
                        key={label}
                      >
                        <Input
                          aria-label={t("sources.structured.valueLabel")}
                          value={label}
                          disabled={readOnly}
                          onChange={(event) =>
                            renameValueField(label, event.target.value)
                          }
                        />
                        <Input
                          aria-label={t("sources.structured.valuePath")}
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
                        >
                          <SelectTrigger
                            aria-label={t("sources.structured.valueTypeFor", {
                              label,
                            })}
                          >
                            <SelectValue>
                              {optionLabel(
                                valueTypes,
                                mapping.valueFieldTypes?.[label] ?? "text",
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {valueTypes.map((option) => (
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
                          aria-label={t("sources.structured.removeValue", {
                            label,
                          })}
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
                        <Plus size={15} aria-hidden="true" />{" "}
                        {t("sources.structured.addTimestamps", {
                          count: unmappedTimestamps.length,
                        })}
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
                            t("sources.structured.newValueName", {
                              index:
                                Object.keys(mapping.valueFields ?? {}).length +
                                1,
                            }),
                            provider === "json" ? "/value" : "value",
                          )
                        }
                      >
                        <Plus size={15} aria-hidden="true" />{" "}
                        {t("sources.structured.addValue")}
                      </RheaButton>
                    )}
                </div>
              </fieldset>
              <fieldset className="grid gap-3">
                <legend className="text-sm font-medium">
                  {t("sources.structured.dateSelection")}
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
                    aria-label={t("sources.structured.selectByDate")}
                    className="mt-0.5"
                  />
                  <span className="grid gap-0.5">
                    <strong className="font-medium">
                      {t("sources.structured.selectByDate")}
                    </strong>
                    <small className="text-xs text-muted-foreground">
                      {t("sources.structured.selectByDateHint")}
                    </small>
                  </span>
                </label>
                {configuration.dateSelection.enabled && (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="date-format">
                          {t("sources.structured.dateFormat")}
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
                        >
                          <SelectTrigger
                            id="date-format"
                            aria-label={t("sources.structured.dateFormat")}
                          >
                            <SelectValue>
                              {optionLabel(
                                dateFormatItems,
                                configuration.dateSelection.dateFormat,
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {dateFormatItems.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </RheaSelect>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="date-timezone">
                          {t("sources.structured.timezone")}
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
                        <FieldLabel htmlFor="date-mode">
                          {t("sources.structured.selection")}
                        </FieldLabel>
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
                        >
                          <SelectTrigger
                            id="date-mode"
                            aria-label={t("sources.structured.selection")}
                          >
                            <SelectValue>
                              {optionLabel(
                                dateModeItems,
                                configuration.dateSelection.mode,
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {dateModeItems.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </RheaSelect>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="date-no-match">
                          {t("sources.structured.noMatch")}
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
                        >
                          <SelectTrigger
                            id="date-no-match"
                            aria-label={t("sources.structured.noMatch")}
                          >
                            <SelectValue>
                              {optionLabel(
                                noMatchItems,
                                configuration.dateSelection.noMatchBehavior,
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {noMatchItems.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </RheaSelect>
                      </Field>
                    </div>
                    {configuration.dateSelection.mode === "custom_range" && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field>
                          <FieldLabel htmlFor="date-start">
                            {t("sources.structured.startDate")}
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
                          <FieldLabel htmlFor="date-end">
                            {t("sources.structured.endDate")}
                          </FieldLabel>
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
                          {t("sources.structured.fallbackText")}
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
                      <span>{t("sources.structured.excludePast")}</span>
                    </label>
                    <Field>
                      <FieldLabel htmlFor="preview-date">
                        {t("sources.structured.previewDate")}
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
            <legend className="text-sm font-medium">
              {t("sources.structured.recordFilters")}
            </legend>
            <div className="grid gap-2">
              {(configuration.filters ?? []).map((filter, index) => (
                <div
                  className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-center"
                  key={index}
                >
                  <Input
                    aria-label={t("sources.structured.filterField")}
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
                  >
                    <SelectTrigger
                      aria-label={t("sources.structured.filterOperator")}
                    >
                      <SelectValue>
                        {optionLabel(filterOperators, filter.operator)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {filterOperators.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </RheaSelect>
                  <Input
                    aria-label={t("sources.structured.filterValue")}
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
                    aria-label={t("sources.structured.removeFilter")}
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
                  <Plus size={15} aria-hidden="true" />{" "}
                  {t("sources.structured.addFilter")}
                </RheaButton>
              )}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="structured-refresh">
                {t("sources.structured.refreshInterval")}
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
              >
                <SelectTrigger
                  id="structured-refresh"
                  aria-label={t("sources.structured.refreshInterval")}
                >
                  <SelectValue>
                    {optionLabel(
                      refreshItems,
                      configuration.refreshIntervalSeconds,
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {refreshItems.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="structured-empty-state">
                {t("sources.structured.emptyStateLabel")}
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
                {t("sources.structured.diagnostics")}
              </strong>
              <span className="text-sm">
                {diagnostics.data.parseStatus} ·{" "}
                {diagnostics.data.httpResultCategory ??
                  t("sources.structured.diagUnknown")}{" "}
                ·{" "}
                {t("sources.structured.diagItems", {
                  count: diagnostics.data.availableItemCount,
                })}
                {diagnostics.data.usingCachedData
                  ? ` ${t("sources.structured.diagCached")}`
                  : ""}
              </span>
              <small className="text-xs text-muted-foreground">
                {t("sources.structured.lastAttempt")}{" "}
                {diagnostics.data.lastAttemptedRefresh
                  ? new Date(
                      diagnostics.data.lastAttemptedRefresh,
                    ).toLocaleString(locale)
                  : t("sources.structured.notYet")}
              </small>
              <small className="text-xs text-muted-foreground">
                {t("sources.structured.lastSuccess")}{" "}
                {diagnostics.data.lastSuccessfulRefresh
                  ? new Date(
                      diagnostics.data.lastSuccessfulRefresh,
                    ).toLocaleString(locale)
                  : t("sources.structured.notYet")}
              </small>
            </div>
          )}
          {preview && (
            <div className="grid gap-2 rounded-xl border border-border bg-card p-3">
              <strong className="text-sm font-medium">
                {t("sources.structured.mappedItems", {
                  count: preview.configuration.data.records.length,
                })}
              </strong>
              {preview.configuration.data.records.slice(0, 8).map((record) => (
                <article
                  key={record.id}
                  className="grid gap-0.5 border-b border-border pb-2 last:border-0 last:pb-0"
                >
                  <strong className="text-sm font-medium">
                    {record.title || t("sources.structured.untitledItem")}
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
                {apiErrorMessage(previewMutation.error ?? save.error)}
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
              ? t("sources.shared.loadingPreview")
              : t("sources.structured.previewButton")}
          </RheaButton>
          {!readOnly && (
            <RheaButton
              type="button"
              disabled={save.isPending || !name.trim()}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t("common:actions.saving")
                : t("sources.shared.saveDataSource")}
            </RheaButton>
          )}
        </footer>
      </section>
    </div>
  );
}

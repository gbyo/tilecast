// DataSourcePicker is the single control for choosing the data behind a Widget or a Layout text
// binding. It exists because authoring previously required knowing that a Data Source is a
// separate record that must be created first, on a different page, before a data-driven Widget
// could be configured at all.
//
// Three rules it enforces everywhere it is used:
//   1. Data can be connected from here. Selecting "Connect new data" opens the ordinary Data
//      Source editor in its existing modal mode and selects the result, so authoring never
//      leaves the Widget or Layout in progress.
//   2. Never render a disabled control where an empty state belongs. With no compatible source
//      the picker explains that and offers the same Connect action.
//   3. Show the data, not just its name. The selected source reports status, cached record
//      count, and sample values.
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Plus,
  X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../api/client";
import type { DataSource, DataSourceProvider } from "../api/types";
import { Badge } from "../components/ui/badge";
import { Button as RheaButton } from "../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import {
  Dialog as RheaDialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { ConnectDataFlow } from "./DataSourceCreateFlow";
import { previewRecordMaps } from "./previewRecords";
import { providerLabel, sourceIcon } from "./dataSourceProviderMeta";

// Studio shows at most this many sample values so a wide source cannot overflow the control.
const sampleFieldLimit = 4;

// Form Data Sources are authored through the Forms portal, so the Connect flow never
// offers them here.
const formExcluded: DataSourceProvider[] = ["form"];

export type DataFormatGuide = {
  shape: string;
  summary: string;
  fields: {
    key: string;
    label: string;
    types: string[];
    required?: boolean;
  }[];
  example: Record<string, string | number | boolean>;
};

function providerSignature(providers: DataSourceProvider[]) {
  return [...providers].sort().join(",");
}

type ContentT = TFunction<["content", "common"]>;

// Legacy Widget definitions predate generated data controls. Their already-closed compatible
// provider lists still give us enough information to present a useful contract, while
// definition-driven Widgets pass an exact guide derived from their field schema.
function inferredFormatGuide(
  t: ContentT,
  providers?: DataSourceProvider[],
): DataFormatGuide | undefined {
  if (!providers?.length) return undefined;
  const signature = providerSignature(providers);
  if (signature === "weather")
    return {
      shape: t("dataSources.picker.guides.weatherShape"),
      summary: t("dataSources.picker.guides.weatherSummary"),
      fields: [
        {
          key: "temperature",
          label: t("dataSources.picker.guides.temperatureLabel"),
          types: ["number", "text"],
        },
      ],
      example: {
        temperature: 72,
        condition: t("dataSources.picker.guides.weatherExampleCondition"),
      },
    };
  if (signature === "csv,json,manual,weather")
    return {
      shape: t("dataSources.picker.guides.numericShape"),
      summary: t("dataSources.picker.guides.numericSummary"),
      fields: [
        {
          key: "value",
          label: t("dataSources.picker.guides.valueLabel"),
          types: ["number", "integer"],
          required: true,
        },
      ],
      example: {
        label: t("dataSources.picker.guides.numericExampleLabel"),
        value: 94.6,
      },
    };
  if (signature === "air_quality,csv,json,manual,weather")
    return {
      shape: t("dataSources.picker.guides.seriesShape"),
      summary: t("dataSources.picker.guides.seriesSummary"),
      fields: [
        {
          key: "value",
          label: t("dataSources.picker.guides.measuredLabel"),
          types: ["number", "integer", "percent", "currency"],
          required: true,
        },
      ],
      example: {
        label: t("dataSources.picker.guides.seriesExampleLabel"),
        value: 7450,
        target: 10000,
      },
    };
  if (
    signature === "calendar,csv,json,manual,weather" ||
    signature === "calendar,cap_alerts,csv,json,manual,transit,weather"
  )
    return {
      shape: t("dataSources.picker.guides.timeOrderedShape"),
      summary: t("dataSources.picker.guides.timeOrderedSummary"),
      fields: [
        {
          key: "title",
          label: t("dataSources.picker.guides.titleLabel"),
          types: ["text"],
          required: true,
        },
        {
          key: "start",
          label: t("dataSources.picker.guides.startLabel"),
          types: ["date", "datetime"],
          required: true,
        },
      ],
      example: {
        title: t("dataSources.picker.guides.timeOrderedExampleTitle"),
        start: "2026-08-24T09:03:00-04:00",
      },
    };
  return {
    shape: t("dataSources.picker.guides.genericShape"),
    summary: t("dataSources.picker.guides.genericSummary"),
    fields: [
      {
        key: "title",
        label: t("dataSources.picker.guides.displayLabel"),
        types: ["text", "number", "date", "datetime"],
        required: true,
      },
    ],
    example: {
      title: t("dataSources.picker.guides.genericExampleTitle"),
      detail: t("dataSources.picker.guides.genericExampleDetail"),
    },
  };
}

function dataTypeLabel(type: string, t: ContentT) {
  switch (type) {
    case "datetime":
      return t("dataSources.picker.dataTypes.datetime");
    case "integer":
      return t("dataSources.picker.dataTypes.integer");
    case "text":
      return t("dataSources.picker.dataTypes.text");
    case "number":
      return t("dataSources.picker.dataTypes.number");
    case "date":
      return t("dataSources.picker.dataTypes.date");
    case "percent":
      return t("dataSources.picker.dataTypes.percent");
    case "currency":
      return t("dataSources.picker.dataTypes.currency");
    case "boolean":
      return t("dataSources.picker.dataTypes.boolean");
    case "url":
      return t("dataSources.picker.dataTypes.url");
    default:
      return type.replaceAll("_", " ");
  }
}

function DataFormatGuidePanel({ guide }: { guide: DataFormatGuide }) {
  const { t } = useTranslation(["content", "common"]);
  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 rounded-xl border border-border bg-card p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span aria-hidden="true">
          <Database size={18} />
        </span>
        <span className="grid flex-1 gap-0.5">
          <strong className="text-sm font-medium">
            {t("dataSources.picker.formatTitle")}
          </strong>
          <small className="text-xs text-muted-foreground">{guide.shape}</small>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-2 px-1 pt-2">
        <p className="text-sm text-muted-foreground">{guide.summary}</p>
        {guide.fields.length > 0 && (
          <ul className="grid gap-1.5">
            {guide.fields.map((field) => (
              <li key={`${field.key}-${field.label}`} className="grid gap-1">
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <strong className="font-medium">{field.label}</strong>
                  {field.required && (
                    <small className="text-xs text-muted-foreground">
                      {t("dataSources.picker.required")}
                    </small>
                  )}
                </span>
                <span className="flex flex-wrap gap-1">
                  {field.types.map((type) => (
                    <code
                      key={type}
                      className="rounded-md bg-muted px-1.5 py-0.5 text-xs"
                    >
                      {dataTypeLabel(type, t)}
                    </code>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
        {/* One row of real data, as key and value pairs. Pretty-printed JSON put every
            key on its own line and wrapped long values again, which turned a two-field
            example into a tall column of punctuation an author has to read past. */}
        <div className="grid gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {t("dataSources.picker.exampleRow")}
          </span>
          <dl className="grid gap-0.5 rounded-xl bg-muted p-2 text-sm">
            {Object.entries(guide.example).map(([key, entry]) => (
              <div key={key} className="flex gap-2">
                <dt className="font-medium">{key}</dt>
                <dd className="text-muted-foreground">{String(entry)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function statusDotClass(status: unknown) {
  if (status === "ready") return "bg-emerald-500";
  if (status === "error") return "bg-destructive";
  return "bg-muted-foreground";
}

export function SourceStatus({ status }: { status: unknown }) {
  const { t } = useTranslation(["content", "common"]);
  return (
    <Badge variant="outline">
      <span
        className={`size-1.5 rounded-full ${statusDotClass(status)}`}
        aria-hidden="true"
      />
      {statusLabel(status, t)}
    </Badge>
  );
}

function statusLabel(status: unknown, t: ContentT) {
  if (status === "error") return t("dataSources.status.error");
  if (typeof status !== "string" || status.length === 0)
    return t("dataSources.status.unknown");
  if (status === "ready") return t("dataSources.status.ready");
  return status.replaceAll("_", " ");
}

function recordCountLabel(recordCount: unknown, t: ContentT) {
  if (typeof recordCount !== "number") return undefined;
  return t("dataSources.picker.recordCount", { count: recordCount });
}

// useConnectDataFlow owns the two-step Connect state. Both the empty state and the picker
// itself offer the same action, and duplicating the wiring meant a change to one path
// silently diverged from the other.
function useConnectDataFlow(
  createProviders: DataSourceProvider[] | undefined,
  csrf: string | undefined,
  onCreated: (id: string) => void,
) {
  const [creating, setCreating] = useState<DataSourceProvider | "choose">();
  return {
    open: () => setCreating("choose"),
    flow: creating ? (
      <ConnectDataFlow
        provider={creating === "choose" ? undefined : creating}
        providers={createProviders}
        exclude={formExcluded}
        csrf={csrf ?? ""}
        onChooseProvider={setCreating}
        onBack={() => setCreating("choose")}
        onClose={() => setCreating(undefined)}
        onCreated={(id) => {
          setCreating(undefined);
          onCreated(id);
        }}
      />
    ) : null,
  };
}

// ConnectDataNotice is the empty state shown wherever a control needs data that does not exist
// yet. It replaces disabling the control: the reason is stated and the fix is one click away.
export function ConnectDataNotice({
  message,
  createProviders,
  csrf,
  disabled = false,
  onCreated,
}: {
  message?: string;
  createProviders?: DataSourceProvider[];
  csrf?: string;
  disabled?: boolean;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const connect = useConnectDataFlow(createProviders, csrf, onCreated);
  const canCreate = !disabled && Boolean(csrf);
  return (
    <div className="grid gap-2">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Database size={20} aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{t("dataSources.picker.noticeTitle")}</EmptyTitle>
          <EmptyDescription>
            {message ??
              (canCreate
                ? t("dataSources.picker.noticeDefault")
                : t("dataSources.picker.noticeNoAccess"))}
          </EmptyDescription>
        </EmptyHeader>
        {canCreate && (
          <EmptyContent>
            <RheaButton
              type="button"
              variant="secondary"
              size="sm"
              onClick={connect.open}
            >
              <Plus size={15} aria-hidden="true" />{" "}
              {t("dataSources.picker.connectButton")}
            </RheaButton>
          </EmptyContent>
        )}
      </Empty>
      {connect.flow}
    </div>
  );
}

export function DataSourcePicker({
  label: labelProp,
  description,
  value,
  sources,
  csrf,
  disabled = false,
  required = false,
  allowCreate = true,
  allowEmpty = true,
  emptyMessage,
  createProviders,
  formatGuide,
  onChange,
}: {
  label?: string;
  description?: string;
  value: string;
  // Sources already narrowed to those compatible with the consuming Widget or binding.
  sources: DataSource[];
  csrf?: string;
  disabled?: boolean;
  required?: boolean;
  allowCreate?: boolean;
  // Layout bindings always reference a source, so they suppress the empty option rather than
  // allowing a selection that would write an invalid binding into the draft.
  allowEmpty?: boolean;
  emptyMessage?: string;
  // Providers offered by the Connect flow. Defaults to every non-Form provider in the catalog,
  // narrowed to what the consumer accepts when it passes a list.
  createProviders?: DataSourceProvider[];
  // Definition-driven Widgets provide their exact field contract. Legacy Widgets fall back to
  // guidance inferred from their closed compatible-provider list.
  formatGuide?: DataFormatGuide;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const label = labelProp ?? t("dataSources.picker.defaultLabel");
  const connect = useConnectDataFlow(createProviders, csrf, onChange);
  const [choosing, setChoosing] = useState(false);
  const selected = sources.find((source) => source.id === value);
  // A referenced source that is not in the compatible list — deleted, or no longer accepted by
  // this field — must be shown as missing rather than silently resolving to another source.
  const missing = Boolean(value) && !selected;
  const canCreate = allowCreate && !disabled && Boolean(csrf);
  const resolvedFormatGuide =
    formatGuide ?? inferredFormatGuide(t, createProviders);

  // Sample values come from the saved-source preview, fetched only for the selected source.
  // The list response carries no records, so previewing every row would be an N+1.
  //
  // The key deliberately matches the one the Widget editors use for the same request, so opening a
  // Widget whose preview already fetched this payload reuses it instead of issuing a second call.
  const preview = useQuery({
    queryKey: ["widget-data-source-preview", value],
    queryFn: () => api.previewSavedDataSource(value),
    enabled: Boolean(value),
    retry: false,
  });
  const sampleRecord = previewRecordMaps(preview.data)[0];
  const samples = Object.entries(sampleRecord ?? {})
    .filter(([key, entry]) => key !== "id" && entry !== "")
    .slice(0, sampleFieldLimit);

  return (
    <div className="grid gap-2">
      {resolvedFormatGuide && (
        <DataFormatGuidePanel guide={resolvedFormatGuide} />
      )}
      {/* With no compatible sources the empty state is the whole control — unless something is
          still referenced, in which case the picker must stay so the missing reference is visible
          rather than replaced by a "nothing here yet" message. */}
      {sources.length === 0 && !missing ? (
        <ConnectDataNotice
          message={emptyMessage}
          createProviders={createProviders}
          csrf={allowCreate ? csrf : undefined}
          disabled={disabled}
          onCreated={onChange}
        />
      ) : (
        <>
          <div className="grid gap-1">
            <span className="text-sm font-medium">
              {label}
              {required ? " *" : ""}
            </span>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-xl border border-border bg-card p-3 text-left outline-none hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              aria-label={t("dataSources.picker.triggerLabel", {
                label,
                value:
                  selected?.name ??
                  (missing
                    ? t("dataSources.picker.unavailable")
                    : t("dataSources.picker.chooseData")),
              })}
              aria-haspopup="dialog"
              aria-expanded={choosing}
              disabled={disabled}
              onClick={() => setChoosing(true)}
            >
              <span aria-hidden="true">
                {selected ? (
                  sourceIcon(selected.provider, undefined, 20)
                ) : (
                  <Database size={20} />
                )}
              </span>
              <span className="grid flex-1 gap-0.5">
                <strong className="truncate text-sm font-medium">
                  {selected?.name ??
                    (missing
                      ? t("dataSources.picker.unavailable")
                      : t("dataSources.picker.chooseData"))}
                </strong>
                <small className="text-xs text-muted-foreground">
                  {selected
                    ? providerLabel(selected.provider, t)
                    : missing
                      ? t("dataSources.picker.replacement")
                      : t("dataSources.picker.compatibleCount", {
                          count: sources.length,
                        })}
                </small>
              </span>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
            {description && (
              <small className="text-xs text-muted-foreground">
                {description}
              </small>
            )}
          </div>
          {missing && (
            <p role="alert" className="text-sm text-destructive">
              {t("dataSources.picker.missingAlert")}
            </p>
          )}
          {selected && (
            <div className="grid gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <SourceStatus status={selected.status} />
                {recordCountLabel(selected.cachedRecordCount, t) && (
                  <span className="text-xs text-muted-foreground">
                    {recordCountLabel(selected.cachedRecordCount, t)}
                  </span>
                )}
              </div>
              {samples.length > 0 && (
                <dl className="grid gap-0.5 rounded-xl bg-muted p-2 text-sm">
                  {samples.map(([key, entry]) => (
                    <div key={key} className="flex gap-2">
                      <dt className="font-medium">{key}</dt>
                      <dd className="text-muted-foreground">{entry}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}
          <DataSourceSelectionDialog
            open={choosing}
            value={value}
            sources={sources}
            allowEmpty={allowEmpty}
            canCreate={canCreate}
            onSelect={(id) => {
              onChange(id);
              setChoosing(false);
            }}
            onConnect={() => {
              setChoosing(false);
              connect.open();
            }}
            onClose={() => setChoosing(false)}
          />
        </>
      )}
      {connect.flow}
    </div>
  );
}

function DataSourceSelectionDialog({
  open,
  value,
  sources,
  allowEmpty,
  canCreate,
  onSelect,
  onConnect,
  onClose,
}: {
  open: boolean;
  value: string;
  sources: DataSource[];
  allowEmpty: boolean;
  canCreate: boolean;
  onSelect: (id: string) => void;
  onConnect: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? sources.filter((source) =>
        t("dataSources.picker.searchHaystack", {
          name: source.name,
          provider: providerLabel(source.provider, t),
        })
          .toLowerCase()
          .includes(needle),
      )
    : sources;
  return (
    <RheaDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery("");
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("dataSources.picker.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("dataSources.picker.dialogDescription")}
          </DialogDescription>
        </DialogHeader>
        {sources.length > 1 && (
          <Input
            type="search"
            value={query}
            placeholder={t("dataSources.picker.searchPlaceholder")}
            aria-label={t("dataSources.picker.searchLabel")}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        <ul className="grid gap-1">
          {allowEmpty && (
            <li>
              <button
                type="button"
                onClick={() => onSelect("")}
                className="flex w-full items-center gap-2 rounded-xl border border-border bg-card p-3 text-left outline-none hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span aria-hidden="true">
                  <X size={18} />
                </span>
                <span className="grid flex-1 gap-0.5">
                  <strong className="text-sm font-medium">
                    {t("dataSources.picker.noData")}
                  </strong>
                  <small className="text-xs text-muted-foreground">
                    {t("dataSources.picker.noDataHint")}
                  </small>
                </span>
                <span aria-hidden="true" />
                {!value && (
                  <Check
                    size={18}
                    aria-label={t("dataSources.picker.selected")}
                  />
                )}
              </button>
            </li>
          )}
          {visible.map((source) => (
            <li key={source.id}>
              <button
                type="button"
                onClick={() => onSelect(source.id)}
                className="flex w-full items-center gap-2 rounded-xl border border-border bg-card p-3 text-left outline-none hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span aria-hidden="true">
                  {sourceIcon(source.provider, undefined, 20)}
                </span>
                <span className="grid flex-1 gap-0.5">
                  <strong className="truncate text-sm font-medium">
                    {source.name}
                  </strong>
                  <small className="text-xs text-muted-foreground">
                    {providerLabel(source.provider, t)}
                  </small>
                </span>
                <span className="grid items-end gap-1">
                  <SourceStatus status={source.status} />
                  {recordCountLabel(source.cachedRecordCount, t) && (
                    <small className="text-xs text-muted-foreground">
                      {recordCountLabel(source.cachedRecordCount, t)}
                    </small>
                  )}
                </span>
                {value === source.id && (
                  <Check
                    size={18}
                    aria-label={t("dataSources.picker.selected")}
                  />
                )}
              </button>
            </li>
          ))}
        </ul>
        {needle && visible.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t("dataSources.picker.noMatch", { query })}
          </p>
        )}
        <DialogFooter>
          {canCreate && (
            <RheaButton type="button" onClick={onConnect}>
              <Plus size={15} aria-hidden="true" />{" "}
              {t("dataSources.picker.connectButton")}
            </RheaButton>
          )}
          <RheaButton type="button" variant="secondary" onClick={onClose}>
            {t("common:actions.cancel")}
          </RheaButton>
        </DialogFooter>
      </DialogContent>
    </RheaDialog>
  );
}

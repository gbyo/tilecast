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
import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import type { DataSource, DataSourceProvider } from "../api/types";
import { Button, StatusDot } from "../components/legacy-ui";
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

// Legacy Widget definitions predate generated data controls. Their already-closed compatible
// provider lists still give us enough information to present a useful contract, while
// definition-driven Widgets pass an exact guide derived from their field schema.
function inferredFormatGuide(
  providers?: DataSourceProvider[],
): DataFormatGuide | undefined {
  if (!providers?.length) return undefined;
  const signature = providerSignature(providers);
  if (signature === "weather")
    return {
      shape: "Weather data",
      summary:
        "Use a Weather Data Source; Tilecast supplies its typed forecast fields.",
      fields: [
        {
          key: "temperature",
          label: "Temperature and conditions",
          types: ["number", "text"],
        },
      ],
      example: { temperature: 72, condition: "Partly cloudy" },
    };
  if (signature === "csv,json,manual,weather")
    return {
      shape: "Records with a numeric value",
      summary: "Each row needs the number this Widget should feature.",
      fields: [
        {
          key: "value",
          label: "Value",
          types: ["number", "integer"],
          required: true,
        },
      ],
      example: { label: "Daily attendance", value: 94.6 },
    };
  if (signature === "air_quality,csv,json,manual,weather")
    return {
      shape: "Numeric records or a time series",
      summary:
        "Provide one or more numeric fields that can be mapped in the Widget.",
      fields: [
        {
          key: "value",
          label: "Measured value",
          types: ["number", "integer", "percent", "currency"],
          required: true,
        },
      ],
      example: { label: "Fundraising", value: 7450, target: 10000 },
    };
  if (
    signature === "calendar,csv,json,manual,weather" ||
    signature === "calendar,cap_alerts,csv,json,manual,transit,weather"
  )
    return {
      shape: "Time-ordered records",
      summary:
        "Each row should have a readable title and a date or date-and-time field.",
      fields: [
        {
          key: "title",
          label: "Title",
          types: ["text"],
          required: true,
        },
        {
          key: "start",
          label: "Date or time",
          types: ["date", "datetime"],
          required: true,
        },
      ],
      example: {
        title: "Period 2",
        start: "2026-08-24T09:03:00-04:00",
      },
    };
  return {
    shape: "Record rows",
    summary:
      "Use one row per item and map the fields you want the Widget to display.",
    fields: [
      {
        key: "title",
        label: "Display field",
        types: ["text", "number", "date", "datetime"],
        required: true,
      },
    ],
    example: {
      title: "Today’s announcement",
      detail: "Library closes at 4 PM",
    },
  };
}

function dataTypeLabel(type: string) {
  if (type === "datetime") return "date & time";
  if (type === "integer") return "whole number";
  return type.replaceAll("_", " ");
}

function DataFormatGuidePanel({ guide }: { guide: DataFormatGuide }) {
  return (
    <details className="data-format-guide" open>
      <summary>
        <span className="data-format-guide__icon" aria-hidden>
          <Database size={18} />
        </span>
        <span>
          <strong>Data format</strong>
          <small>{guide.shape}</small>
        </span>
        <ChevronDown size={16} aria-hidden />
      </summary>
      <div className="data-format-guide__body">
        <p>{guide.summary}</p>
        {guide.fields.length > 0 && (
          <ul>
            {guide.fields.map((field) => (
              <li key={`${field.key}-${field.label}`}>
                <span>
                  <strong>{field.label}</strong>
                  {field.required && <small>Required</small>}
                </span>
                <span className="data-format-guide__types">
                  {field.types.map((type) => (
                    <code key={type}>{dataTypeLabel(type)}</code>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
        {/* One row of real data, as key and value pairs. Pretty-printed JSON put every
            key on its own line and wrapped long values again, which turned a two-field
            example into a tall column of punctuation an author has to read past. */}
        <div className="data-format-guide__example">
          <span>Example row</span>
          <dl>
            {Object.entries(guide.example).map(([key, entry]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{String(entry)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </details>
  );
}

function statusTone(status: unknown) {
  if (status === "ready") return "success" as const;
  if (status === "error") return "danger" as const;
  return "info" as const;
}

function statusLabel(status: unknown) {
  if (status === "error") return "Last refresh failed";
  if (typeof status !== "string" || status.length === 0)
    return "Status unavailable";
  if (status === "ready") return "Ready";
  return status.replaceAll("_", " ");
}

function recordCountLabel(recordCount: unknown) {
  if (typeof recordCount !== "number") return undefined;
  return `${recordCount} record${recordCount === 1 ? "" : "s"}`;
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
  const connect = useConnectDataFlow(createProviders, csrf, onCreated);
  const canCreate = !disabled && Boolean(csrf);
  return (
    <div className="data-source-picker__empty">
      <span className="data-source-picker__empty-icon" aria-hidden="true">
        <Database size={20} />
      </span>
      <div>
        <strong>No compatible data connected yet</strong>
        <p>
          {message ??
            (canCreate
              ? "Connect a calendar, spreadsheet, feed, or table to fill this Widget."
              : "Ask an editor to connect a compatible Data Source.")}
        </p>
      </div>
      {canCreate && (
        <Button
          type="button"
          variant="secondary"
          compact
          onClick={connect.open}
        >
          <Plus size={15} aria-hidden="true" /> Connect new data
        </Button>
      )}
      {connect.flow}
    </div>
  );
}

export function DataSourcePicker({
  label = "Data Source",
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
  const connect = useConnectDataFlow(createProviders, csrf, onChange);
  const [choosing, setChoosing] = useState(false);
  const dialogTitleId = useId();
  const selected = sources.find((source) => source.id === value);
  // A referenced source that is not in the compatible list — deleted, or no longer accepted by
  // this field — must be shown as missing rather than silently resolving to another source.
  const missing = Boolean(value) && !selected;
  const canCreate = allowCreate && !disabled && Boolean(csrf);
  const resolvedFormatGuide =
    formatGuide ?? inferredFormatGuide(createProviders);

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
    <div className="data-source-picker">
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
          <div className="field">
            <span className="field__label">
              {label}
              {required ? " *" : ""}
            </span>
            <button
              type="button"
              className="data-source-picker__trigger"
              aria-label={`${label}: ${
                selected?.name ??
                (missing ? "Unavailable Data Source" : "Choose data")
              }`}
              aria-haspopup="dialog"
              aria-expanded={choosing}
              disabled={disabled}
              onClick={() => setChoosing(true)}
            >
              <span className="data-source-picker__trigger-icon" aria-hidden>
                {selected ? (
                  sourceIcon(selected.provider, undefined, 20)
                ) : (
                  <Database size={20} />
                )}
              </span>
              <span className="data-source-picker__trigger-copy">
                <strong>
                  {selected?.name ??
                    (missing ? "Unavailable Data Source" : "Choose data")}
                </strong>
                <small>
                  {selected
                    ? providerLabel(selected.provider)
                    : missing
                      ? "Choose a replacement"
                      : `${sources.length} compatible ${
                          sources.length === 1 ? "source" : "sources"
                        }`}
                </small>
              </span>
              <ChevronRight size={18} aria-hidden />
            </button>
            {description && <small>{description}</small>}
          </div>
          {missing && (
            <p className="data-source-picker__missing" role="alert">
              The Data Source this was built with is no longer available. Choose
              another to keep this content working.
            </p>
          )}
          {selected && (
            <div className="data-source-picker__detail">
              <div className="data-source-picker__status">
                <StatusDot
                  tone={statusTone(selected.status)}
                  label={statusLabel(selected.status)}
                />
                {recordCountLabel(selected.cachedRecordCount) && (
                  <span className="data-source-picker__record-count">
                    {recordCountLabel(selected.cachedRecordCount)}
                  </span>
                )}
              </div>
              {samples.length > 0 && (
                <dl className="data-source-picker__samples">
                  {samples.map(([key, entry]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{entry}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}
          {choosing && (
            <DataSourceSelectionDialog
              titleId={dialogTitleId}
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
          )}
        </>
      )}
      {connect.flow}
    </div>
  );
}

function DataSourceSelectionDialog({
  titleId,
  value,
  sources,
  allowEmpty,
  canCreate,
  onSelect,
  onConnect,
  onClose,
}: {
  titleId: string;
  value: string;
  sources: DataSource[];
  allowEmpty: boolean;
  canCreate: boolean;
  onSelect: (id: string) => void;
  onConnect: () => void;
  onClose: () => void;
}) {
  return createPortal(
    <div
      className="details-backdrop data-source-select-backdrop"
      role="presentation"
    >
      <section
        className="asset-details source-editor data-source-select-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <div>
            <h2 id={titleId}>Choose data</h2>
            <p>Select an existing compatible source or connect a new one.</p>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </header>
        <div className="source-editor__body">
          <ul className="data-source-select__choices">
            {allowEmpty && (
              <li>
                <button type="button" onClick={() => onSelect("")}>
                  <span className="data-source-select__icon" aria-hidden>
                    <X size={18} />
                  </span>
                  <span className="data-source-select__copy">
                    <strong>No data</strong>
                    <small>Leave this Widget disconnected.</small>
                  </span>
                  <span aria-hidden />
                  {!value && <Check size={18} aria-label="Selected" />}
                </button>
              </li>
            )}
            {sources.map((source) => (
              <li key={source.id}>
                <button type="button" onClick={() => onSelect(source.id)}>
                  <span className="data-source-select__icon" aria-hidden>
                    {sourceIcon(source.provider, undefined, 20)}
                  </span>
                  <span className="data-source-select__copy">
                    <strong>{source.name}</strong>
                    <small>{providerLabel(source.provider)}</small>
                  </span>
                  <span className="data-source-select__status">
                    <StatusDot
                      tone={statusTone(source.status)}
                      label={statusLabel(source.status)}
                    />
                    {recordCountLabel(source.cachedRecordCount) && (
                      <small>
                        {recordCountLabel(source.cachedRecordCount)}
                      </small>
                    )}
                  </span>
                  {value === source.id && (
                    <Check size={18} aria-label="Selected" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <footer>
          {canCreate && (
            <Button type="button" variant="primary" onClick={onConnect}>
              <Plus size={15} aria-hidden /> Connect new data
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

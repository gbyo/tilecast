/**
 * Data-source normalization.
 *
 * Widgets and layouts consume many source shapes: v11 structured/calendar
 * prepared data, v12 typed records, and v13 DataDocument datasets. This
 * module flattens all of them into one uniform, display-ready record shape so
 * the renderers never branch on schema version. Typed formatting and offline
 * date selection are applied here (in the testable core), not in the
 * renderer.
 */

import {
  formatValue,
  type RegionalFormatting,
  type ValueFormat,
} from "./format";
import {
  selectByDate,
  type FirstDayOfWeek,
  type NoMatchBehavior,
  type SelectionMode,
} from "./selection";
import type {
  DataDocument,
  DocumentDataset,
  DocumentValue,
  ManifestDataSource,
  TypedRecordData,
} from "./content-types";

export interface NormalizedRecord {
  id: string;
  /** Extracted YYYY-MM-DD (or "") used for selection and agenda grouping. */
  date: string;
  /** Display-ready string fields, keyed by field key. */
  fields: Record<string, string>;
  /** Original scalar values used by numeric and typed formatting. */
  rawFields: Record<string, string>;
}

export interface NormalizedSource {
  provider: string;
  records: NormalizedRecord[];
  /**
   * Display-ready values of an object-kind dataset, keyed by field key. Object Data
   * Sources (a single current status, goal, or count) carry one value map rather than
   * records, and presentation bindings read them by path.
   */
  objectValues: Record<string, string>;
  rawObjectValues: Record<string, string>;
  fieldTypes: Record<string, string>;
  fieldCurrencies: Record<string, string>;
  attribution: string;
  unavailable: boolean;
  usingCachedData: boolean;
  /** Set when a date selection resolved to fallback text. */
  usedFallback: boolean;
  hidden: boolean;
}

function docValueToString(
  value: DocumentValue | undefined,
  fieldType?: string,
  currency?: string,
  regionalFormat?: RegionalFormatting,
): string {
  if (!value) {
    return "";
  }
  const format = (fieldType ?? value.kind) as ValueFormat;
  switch (value.kind) {
    case "text":
      return value.text ?? "";
    case "number":
      return formatValue(value.number ?? null, {
        format: "number",
        precision: 2,
        regionalFormat,
      });
    case "integer":
      return formatValue(value.integer ?? null, {
        format: "integer",
        regionalFormat,
      });
    case "percent":
      return formatValue(value.number ?? value.integer ?? null, {
        format: "percent",
        regionalFormat,
      });
    case "currency":
      return formatValue(value.number ?? value.integer ?? null, {
        format: "currency",
        currency,
        precision: 2,
        regionalFormat,
      });
    case "boolean":
      return value.boolean ? "Yes" : "No";
    case "date":
      return formatValue(value.date ?? "", { format: "date", regionalFormat });
    case "datetime":
      return formatValue(value.datetime ?? "", {
        format: "datetime",
        regionalFormat,
      });
    case "duration":
      return formatValue(value.durationSeconds ?? null, { format: "duration" });
    case "url":
      return value.url ?? "";
    case "asset":
      return value.assetId ?? "";
    default:
      // list/object collapse to their text if present.
      return value.text ?? formatValue(value.number ?? null, { format });
  }
}

function docValueToRaw(value: DocumentValue | undefined): string {
  if (!value) return "";
  switch (value.kind) {
    case "text":
      return value.text ?? "";
    case "number":
    case "percent":
    case "currency":
      return String(value.number ?? value.integer ?? "");
    case "integer":
      return String(value.integer ?? "");
    case "boolean":
      return value.boolean == null ? "" : String(value.boolean);
    case "date":
      return value.date ?? "";
    case "datetime":
      return value.datetime ?? "";
    case "duration":
      return String(value.durationSeconds ?? "");
    case "url":
      return value.url ?? "";
    case "asset":
      return value.assetId ?? "";
    default:
      return value.text ?? "";
  }
}

/** Pull a YYYY-MM-DD from a value that may be a date, datetime, or string. */
function extractDate(raw: string): string {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(raw);
  return m ? m[1]! : "";
}

function normalizeDocumentRecords(
  dataset: DocumentDataset,
  regionalFormat?: RegionalFormatting,
): {
  records: NormalizedRecord[];
  fieldTypes: Record<string, string>;
  fieldCurrencies: Record<string, string>;
} {
  const fieldTypes: Record<string, string> = {};
  const fieldCurrencies: Record<string, string> = {};
  for (const f of dataset.fields ?? []) {
    fieldTypes[f.key] = f.type;
    if (f.currency) fieldCurrencies[f.key] = f.currency;
  }
  const dateField = dataset.dateSelection?.field ?? "date";
  const records = (dataset.records ?? []).map((r) => {
    const fields: Record<string, string> = {};
    const rawFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(r.values)) {
      rawFields[key] = docValueToRaw(value);
      fields[key] = docValueToString(
        value,
        fieldTypes[key],
        fieldCurrencies[key],
        regionalFormat,
      );
    }
    const dateRaw = rawFields[dateField] ?? "";
    return { id: r.id, date: extractDate(dateRaw), fields, rawFields };
  });
  return { records, fieldTypes, fieldCurrencies };
}

function firstRecordsDataset(doc: DataDocument): DocumentDataset | undefined {
  return (
    doc.datasets.find((d) => d.kind === "records") ??
    doc.datasets.find((d) => (d.records?.length ?? 0) > 0)
  );
}

function firstObjectDataset(doc: DataDocument): DocumentDataset | undefined {
  return doc.datasets.find((d) => d.kind === "object");
}

function normalizeDocumentObject(
  dataset: DocumentDataset,
  regionalFormat?: RegionalFormatting,
): Record<string, string> {
  const fieldTypes: Record<string, string> = {};
  const fieldCurrencies: Record<string, string> = {};
  for (const f of dataset.fields ?? []) {
    fieldTypes[f.key] = f.type;
    if (f.currency) fieldCurrencies[f.key] = f.currency;
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(dataset.value?.object ?? {})) {
    values[key] = docValueToString(
      value,
      fieldTypes[key],
      fieldCurrencies[key],
      regionalFormat,
    );
  }
  return values;
}

function normalizeDocumentObjectRaw(
  dataset: DocumentDataset,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dataset.value?.object ?? {}).map(([key, value]) => [
      key,
      docValueToRaw(value),
    ]),
  );
}

/** Normalize any manifest data source into uniform records. */
export function normalizeSource(
  source: ManifestDataSource,
  at: Date,
  regionalFormat?: RegionalFormatting,
): NormalizedSource {
  const base: NormalizedSource = {
    provider: source.provider,
    records: [],
    objectValues: {},
    rawObjectValues: {},
    fieldTypes: {},
    fieldCurrencies: {},
    attribution: "",
    unavailable: false,
    usingCachedData: false,
    usedFallback: false,
    hidden: false,
  };

  // v13 DataDocument.
  if (source.dataDocument) {
    // An object dataset carries a single current value map. It can accompany records,
    // so it is read before the records branch returns.
    const objectDataset = firstObjectDataset(source.dataDocument);
    if (objectDataset) {
      base.objectValues = normalizeDocumentObject(
        objectDataset,
        regionalFormat,
      );
      base.rawObjectValues = normalizeDocumentObjectRaw(objectDataset);
    }
    const dataset = firstRecordsDataset(source.dataDocument);
    if (dataset) {
      const { records, fieldTypes, fieldCurrencies } = normalizeDocumentRecords(
        dataset,
        regionalFormat,
      );
      base.records = records;
      base.fieldTypes = fieldTypes;
      base.fieldCurrencies = fieldCurrencies;
      base.attribution = dataset.attribution ?? "";
      applySelection(
        base,
        dataset.dateSelection,
        dataset.timezone ?? "UTC",
        at,
        regionalFormat?.firstDayOfWeek,
      );
      return base;
    }
    if (objectDataset) {
      for (const f of objectDataset.fields ?? []) {
        base.fieldTypes[f.key] = f.type;
        if (f.currency) base.fieldCurrencies[f.key] = f.currency;
      }
      base.attribution = objectDataset.attribution ?? "";
      return base;
    }
  }

  const config = source.configuration ?? {};

  // Calendar prepared data (v11).
  if (source.provider === "calendar" && isObject(config["data"])) {
    const events = asArray(
      (config["data"] as Record<string, unknown>)["events"],
    );
    base.records = events.map((e) => {
      const ev = e as Record<string, unknown>;
      return {
        id: String(ev["id"] ?? ""),
        date: extractDate(String(ev["start"] ?? "")),
        fields: {
          title: String(ev["title"] ?? ""),
          start: String(ev["start"] ?? ""),
          end: String(ev["end"] ?? ""),
          location: String(ev["location"] ?? ""),
          description: String(ev["descriptionExcerpt"] ?? ""),
        },
        rawFields: {
          title: String(ev["title"] ?? ""),
          start: String(ev["start"] ?? ""),
          end: String(ev["end"] ?? ""),
          location: String(ev["location"] ?? ""),
          description: String(ev["descriptionExcerpt"] ?? ""),
        },
      };
    });
    return base;
  }

  // Structured prepared data (v11).
  if (isObject(config["data"])) {
    const recs = asArray(
      (config["data"] as Record<string, unknown>)["records"],
    );
    base.records = recs.map((r) => {
      const rec = r as Record<string, unknown>;
      const fields: Record<string, string> = {
        title: String(rec["title"] ?? ""),
        subtitle: String(rec["subtitle"] ?? ""),
        date: String(rec["date"] ?? ""),
        author: String(rec["author"] ?? ""),
        description: String(rec["description"] ?? ""),
        link: String(rec["link"] ?? ""),
      };
      for (const [k, v] of Object.entries(
        (rec["values"] as Record<string, unknown>) ?? {},
      )) {
        fields[k] = String(v);
      }
      return {
        id: String(rec["id"] ?? ""),
        date: extractDate(fields["date"]!),
        fields,
        rawFields: { ...fields },
      };
    });
    const sel = config["dateSelection"] as Record<string, unknown> | undefined;
    if (sel?.["enabled"]) {
      applySelection(
        base,
        {
          mode: String(sel["mode"] ?? "today"),
          field: "date",
          customStartDate: String(sel["customStartDate"] ?? ""),
          customEndDate: String(sel["customEndDate"] ?? ""),
          excludePast: sel["excludePast"] === true,
          noMatchBehavior: String(sel["noMatchBehavior"] ?? "empty"),
        },
        String(sel["timezone"] ?? "UTC"),
        at,
        regionalFormat?.firstDayOfWeek,
      );
    }
    return base;
  }

  // Typed records (v12).
  const typed = config as unknown as TypedRecordData;
  if (Array.isArray(typed.records)) {
    for (const f of typed.fields ?? []) {
      base.fieldTypes[f.key] = f.type;
      if (f.currency) base.fieldCurrencies[f.key] = f.currency;
    }
    const dateField = typed.dateField || "date";
    base.records = typed.records.map((r) => {
      const rawFields = { ...r.values };
      const fields: Record<string, string> = {};
      for (const [key, raw] of Object.entries(rawFields)) {
        fields[key] = formatValue(raw, {
          format: (base.fieldTypes[key] ?? "text") as ValueFormat,
          currency: base.fieldCurrencies[key],
          precision: base.fieldTypes[key] === "integer" ? 0 : 2,
          regionalFormat,
        });
      }
      return {
        id: r.id,
        date: extractDate(String(rawFields[dateField] ?? "")),
        fields,
        rawFields,
      };
    });
    base.attribution = typed.attribution ?? "";
    base.unavailable = typed.unavailable === true;
  }
  return base;
}

function applySelection(
  base: NormalizedSource,
  selection:
    | {
        mode: string;
        field: string;
        customStartDate?: string;
        customEndDate?: string;
        excludePast?: boolean;
        noMatchBehavior?: string;
      }
    | null
    | undefined,
  timezone: string,
  at: Date,
  firstDayOfWeek: FirstDayOfWeek = "monday",
): void {
  if (!selection) {
    return;
  }
  const result = selectByDate(base.records, {
    mode: selection.mode as SelectionMode,
    timezone,
    at,
    customStart: selection.customStartDate,
    customEnd: selection.customEndDate,
    excludePast: selection.excludePast,
    noMatchBehavior: selection.noMatchBehavior as NoMatchBehavior,
    firstDayOfWeek,
  });
  base.records = result.records;
  base.usedFallback = result.usedFallback;
  base.hidden = result.hidden;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

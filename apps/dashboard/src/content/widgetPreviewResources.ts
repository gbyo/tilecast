/**
 * Studio preview resources for V2 Widgets
 * (docs/widgets-v2-authoring-and-first-wave.md).
 *
 * One adapter built from the same conceptual resources as the Player: it
 * loads only the Data Sources declared/connected to the Widget and exposes
 * typed Data Documents/datasets plus attribution. It never exposes
 * credentials, arbitrary fetch, undeclared sources, or React internals.
 * Grants come from the component presentation (`dataSources`), so a Widget
 * cannot probe for unrelated manifest content.
 */
import { useQueries } from "@tanstack/react-query";
import {
  createWidgetResources,
  type WidgetCacheState,
  type WidgetDataDocument,
  type WidgetDateSelection,
  type WidgetDataset,
  type WidgetField,
  type WidgetMediaRef,
  type WidgetRecord,
  type WidgetResources,
  type WidgetValue,
} from "@tilecast/widget-sdk";
import { api } from "../api/client";
import type {
  CalendarPreview,
  DataSourceField,
  StructuredPreview,
  TypedDatasetPayload,
  TypedRecordData,
} from "../api/types";
import type { WidgetPreviewAssetField } from "./widgetPreviewSources";

export type SavedSourcePreview =
  StructuredPreview | CalendarPreview | TypedRecordData | TypedDatasetPayload;

const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;
const ASSET_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME =
  /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isValidDate(raw: string): boolean {
  if (!DATE.test(raw)) return false;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === raw
  );
}

function isValidDateTime(raw: string): boolean {
  const match = DATETIME.exec(raw);
  return Boolean(
    match && isValidDate(match[1]!) && Number.isFinite(Date.parse(raw)),
  );
}

function isValidUrl(raw: string): boolean {
  if (/\s/.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return Boolean(parsed.protocol && parsed.host);
  } catch {
    return false;
  }
}

function widgetCache(input: {
  cachedAt?: string | null;
  staleAt?: string | null;
  usingCachedData?: boolean;
  unavailable?: boolean;
  lastModified?: string;
  upstreamExpiry?: string | null;
}): WidgetCacheState {
  return {
    ...(input.cachedAt ? { cachedAt: input.cachedAt } : null),
    ...(input.staleAt ? { staleAt: input.staleAt } : null),
    usingCachedData: input.usingCachedData ?? false,
    unavailable: input.unavailable ?? false,
    ...(input.lastModified ? { lastModified: input.lastModified } : null),
    ...(input.upstreamExpiry ? { upstreamExpiry: input.upstreamExpiry } : null),
  };
}

function widgetDateSelection(
  field: string | undefined,
  selection: NonNullable<TypedRecordData["dateSelection"]>,
): WidgetDateSelection | undefined {
  if (!selection.enabled || !field) return undefined;
  return {
    field,
    timezone: selection.timezone,
    mode: selection.mode,
    ...(selection.customStartDate
      ? { customStartDate: selection.customStartDate }
      : null),
    ...(selection.customEndDate
      ? { customEndDate: selection.customEndDate }
      : null),
    excludePast: selection.excludePast,
    noMatchBehavior: selection.noMatchBehavior,
    ...(selection.fallbackText
      ? { fallbackText: selection.fallbackText }
      : null),
  };
}

function typedValue(fieldType: string, raw: string): WidgetValue {
  if (raw === "") return { kind: "null" };
  switch (fieldType) {
    case "integer": {
      const integer = Number(raw);
      return INTEGER.test(raw) && Number.isSafeInteger(integer)
        ? { kind: "integer", integer }
        : { kind: "text", text: raw };
    }
    case "number":
    case "percent":
    case "currency": {
      const number = Number(raw);
      if (!DECIMAL_NUMBER.test(raw) || !Number.isFinite(number))
        return { kind: "text", text: raw };
      // The currency code travels in the field metadata, never in the
      // value: formatWidgetValue renders value.text before any numeric
      // branch, so stamping it here would hide the amount.
      if (fieldType === "currency") return { kind: "currency", number };
      if (fieldType === "percent") return { kind: "percent", number };
      return { kind: "number", number };
    }
    case "boolean":
      return ["1", "t", "T", "TRUE", "True", "true"].includes(raw)
        ? { kind: "boolean", boolean: true }
        : ["0", "f", "F", "FALSE", "False", "false"].includes(raw)
          ? { kind: "boolean", boolean: false }
          : { kind: "text", text: raw };
    case "date":
      return isValidDate(raw)
        ? { kind: "date", date: raw }
        : { kind: "text", text: raw };
    case "datetime":
      return isValidDateTime(raw)
        ? { kind: "datetime", datetime: raw }
        : { kind: "text", text: raw };
    case "duration": {
      const durationSeconds = Number(raw);
      return /^[+-]?\d+$/.test(raw) &&
        Number.isSafeInteger(durationSeconds) &&
        durationSeconds >= 0
        ? { kind: "duration", durationSeconds }
        : { kind: "text", text: raw };
    }
    case "url":
      return isValidUrl(raw)
        ? { kind: "url", url: raw }
        : { kind: "text", text: raw };
    case "asset":
      return ASSET_ID.test(raw) &&
        raw.toLowerCase() !== "00000000-0000-0000-0000-000000000000"
        ? { kind: "asset", assetId: raw.toLowerCase() }
        : { kind: "text", text: raw };
    default:
      return { kind: "text", text: raw };
  }
}

function widgetFields(fields: DataSourceField[] | undefined): WidgetField[] {
  return (fields ?? []).map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    ...(field.currency ? { currency: field.currency } : null),
    ...(field.role ? { role: field.role } : null),
  }));
}

function recordValues(
  values: Record<string, string>,
  fields: DataSourceField[] | undefined,
): Record<string, WidgetValue> {
  const byKey = new Map((fields ?? []).map((field) => [field.key, field]));
  const out: Record<string, WidgetValue> = {};
  for (const [key, raw] of Object.entries(values)) {
    const field = byKey.get(key);
    out[key] = field
      ? typedValue(field.type, raw)
      : { kind: "text", text: raw };
  }
  return out;
}

function isTypedRecordData(
  preview: SavedSourcePreview,
): preview is TypedRecordData {
  return (
    typeof preview === "object" &&
    preview !== null &&
    Array.isArray((preview as TypedRecordData).records) &&
    Array.isArray((preview as TypedRecordData).fields)
  );
}

function isTypedDatasetPayload(
  preview: SavedSourcePreview,
): preview is TypedDatasetPayload {
  return (
    typeof preview === "object" &&
    preview !== null &&
    Array.isArray((preview as TypedDatasetPayload).datasets)
  );
}

function isCalendarPreview(
  preview: SavedSourcePreview,
): preview is CalendarPreview {
  return (
    typeof preview === "object" &&
    preview !== null &&
    typeof (preview as CalendarPreview).configuration === "object" &&
    Array.isArray((preview as CalendarPreview).configuration?.data?.events)
  );
}

/**
 * Project one saved-source preview into a Data Document. Unknown shapes
 * yield null so the Widget sees an empty grant rather than guessed data.
 */
export function previewToDataDocument(
  preview: SavedSourcePreview | null | undefined,
): WidgetDataDocument | null {
  if (!preview || typeof preview !== "object") return null;
  if (isTypedDatasetPayload(preview)) {
    const datasets: WidgetDataset[] = [];
    for (const dataset of preview.datasets) {
      if (
        dataset.kind !== "scalar" &&
        dataset.kind !== "records" &&
        dataset.kind !== "time_series" &&
        dataset.kind !== "list" &&
        dataset.kind !== "object"
      ) {
        return null;
      }
      datasets.push({
        id: dataset.id,
        kind: dataset.kind,
        fields: widgetFields(dataset.fields),
        records: dataset.records?.map((record) => ({
          id: record.id,
          values: recordValues(record.values, dataset.fields),
        })),
        points: dataset.points?.map((point) => ({
          at: point.at,
          values: recordValues(point.values, dataset.fields),
        })),
        value:
          dataset.values !== undefined
            ? {
                kind: "object",
                object: recordValues(dataset.values, dataset.fields),
              }
            : null,
        cache: widgetCache(dataset),
        attribution: dataset.attribution,
        timezone: dataset.timezone,
        units: dataset.units,
      });
    }
    return { schemaVersion: 1, datasets };
  }
  if (isTypedRecordData(preview)) {
    const records: WidgetRecord[] = preview.records.map((record) => ({
      id: record.id,
      values: recordValues(record.values, preview.fields),
    }));
    const dateSelection = preview.dateSelection
      ? widgetDateSelection(preview.dateField, preview.dateSelection)
      : undefined;
    return {
      schemaVersion: 1,
      datasets: [
        {
          id: "records",
          kind: "records",
          fields: widgetFields(preview.fields),
          records,
          cache: widgetCache(preview),
          attribution: preview.attribution,
          ...(dateSelection
            ? { timezone: dateSelection.timezone, dateSelection }
            : preview.dateSelection
              ? { timezone: preview.dateSelection.timezone }
              : null),
        },
      ],
    };
  }
  if (isCalendarPreview(preview)) {
    const data = preview.configuration.data;
    return {
      schemaVersion: 1,
      datasets: [
        {
          id: "events",
          kind: "records",
          fields: widgetFields([
            // i18n-ignore: Data Document field metadata, not Studio chrome.
            { key: "title", label: "Title", type: "text", role: "title" },
            // i18n-ignore: Data Document field metadata, not Studio chrome.
            { key: "start", label: "Start", type: "datetime", role: "start" },
            // i18n-ignore: Data Document field metadata, not Studio chrome.
            { key: "end", label: "End", type: "datetime", role: "end" },
            // i18n-ignore: Data Document field metadata, not Studio chrome.
            {
              key: "location",
              label: "Location",
              type: "text",
              role: "location",
            },
          ]),
          records: data.events.map((event) => ({
            id: event.id,
            values: {
              title: { kind: "text", text: event.title },
              start: { kind: "datetime", datetime: event.start },
              end: { kind: "datetime", datetime: event.end },
              ...(event.location
                ? { location: { kind: "text", text: event.location } }
                : null),
            },
          })),
          cache: widgetCache(data),
          timezone: preview.configuration.timezone,
        },
      ],
    };
  }
  const data = preview.configuration?.data;
  if (!data || !Array.isArray(data.records)) return null;
  const dateSelection = widgetDateSelection(
    "date",
    preview.configuration.dateSelection,
  );
  return {
    schemaVersion: 1,
    datasets: [
      {
        id: "records",
        kind: "records",
        records: data.records.map((record) => ({
          id: record.id,
          values: {
            title: { kind: "text", text: record.title },
            ...(record.subtitle
              ? { subtitle: { kind: "text", text: record.subtitle } }
              : null),
            ...(record.date
              ? { date: { kind: "text", text: record.date } }
              : null),
            ...(record.author
              ? { author: { kind: "text", text: record.author } }
              : null),
            ...(record.description
              ? {
                  description: { kind: "text", text: record.description },
                }
              : null),
            ...recordValues(record.values ?? {}, undefined),
          },
        })),
        cache: widgetCache(data),
        ...(dateSelection
          ? { timezone: dateSelection.timezone, dateSelection }
          : null),
      },
    ],
  };
}

const PREVIEW_MEDIA_VARIANT = "preview";
const MAX_PREVIEW_MEDIA = 16;

/**
 * Resolve the bounded media references Cards can consume from declared,
 * typed asset fields. Studio uses a preview alias because it loads thumbnails
 * from the authenticated preview endpoint instead of Player manifest variants.
 */
export function previewDataSourceMedia(
  documents: ReadonlyMap<string, WidgetDataDocument>,
  fields: readonly WidgetPreviewAssetField[],
  existing: readonly WidgetMediaRef[] = [],
): WidgetMediaRef[] {
  const media = existing.slice(0, MAX_PREVIEW_MEDIA);
  const assets = new Set(existing.map((ref) => ref.assetId));
  for (const field of fields) {
    const dataset = documents
      .get(field.dataSourceId)
      ?.datasets.find((candidate) => candidate.kind === "records");
    if (
      !dataset?.fields?.some(
        (candidate) =>
          candidate.key === field.fieldKey && candidate.type === "asset",
      )
    ) {
      continue;
    }
    const recordLimit = Number.isInteger(field.maximumItems)
      ? Math.max(0, Math.min(100, field.maximumItems))
      : 6;
    for (const record of (dataset.records ?? []).slice(0, recordLimit)) {
      const value = record.values[field.fieldKey];
      const assetId = value?.assetId?.toLowerCase();
      if (
        value?.kind !== "asset" ||
        !assetId ||
        !ASSET_ID.test(assetId) ||
        assetId === "00000000-0000-0000-0000-000000000000" ||
        assets.has(assetId)
      ) {
        continue;
      }
      if (media.length >= MAX_PREVIEW_MEDIA) return media;
      assets.add(assetId);
      media.push({ assetId, variantId: PREVIEW_MEDIA_VARIANT });
    }
  }
  return media;
}

export interface PreviewResources {
  /** Resources narrowed to the component's declared Data Sources. */
  readonly resources: WidgetResources;
  /** True while a connected source preview is still loading. */
  readonly loading: boolean;
  /**
   * Connected source IDs the presentation grants that could not be loaded.
   * A missing Data Document is ambiguous on its own: the Widget also
   * reports empty when the author connected nothing. Callers must treat a
   * non-empty failedIds as an explicit preview error (never as a valid
   * settled empty) so a failed fetch cannot be saved or captured as an
   * intentionally empty Widget.
   */
  readonly failedIds: readonly string[];
}

/**
 * Load the Widget's connected sources through the existing saved-source
 * preview query and project each into a Data Document. Queries are keyed
 * by source ID, so a changed connection naturally drops stale results
 * instead of applying them to the new source.
 */
export function useWidgetPreviewResources(
  dataSourceIds: readonly string[],
  declaredDataSources: readonly string[] = dataSourceIds,
  /** Media the preview grants; each maps to the asset's preview image. */
  declaredMedia: readonly { assetId: string; variantId: string }[] = [],
  /**
   * Layout-selected preview date (YYYY-MM-DD). Part of the query key so a
   * changed date refetches date-selected records instead of reusing the
   * live instant's documents.
   */
  previewDate?: string,
  dataSourceAssetFields: readonly WidgetPreviewAssetField[] = [],
): PreviewResources {
  const previews = useQueries({
    queries: dataSourceIds.map((id) => ({
      queryKey: ["widget-v2-source-preview", id, previewDate ?? null],
      queryFn: () => api.previewSavedDataSource(id, previewDate),
      retry: false,
    })),
  });
  const documents = new Map<string, WidgetDataDocument>();
  const failedIds: string[] = [];
  // Only failures inside the presentation's grants count: a connected source
  // the Widget cannot see is invisible to it, while a granted source that
  // cannot be loaded must surface as an error, never as an empty Widget.
  const granted = new Set(declaredDataSources);
  previews.forEach((preview, index) => {
    const id = dataSourceIds[index];
    if (!id || preview.isLoading) return;
    if (preview.isError || !preview.data) {
      if (granted.has(id)) failedIds.push(id);
      return;
    }
    const document = previewToDataDocument(preview.data);
    if (document) documents.set(id, document);
    else if (granted.has(id)) failedIds.push(id);
  });
  const grantedMedia = previewDataSourceMedia(
    documents,
    dataSourceAssetFields.filter((field) => granted.has(field.dataSourceId)),
    declaredMedia,
  );
  const media = new Map(
    grantedMedia.map((ref) => [
      `${ref.assetId}/${ref.variantId}`,
      api.assetPreviewUrl(ref.assetId),
    ]),
  );
  return {
    resources: createWidgetResources(
      { documents, media },
      { dataSources: [...declaredDataSources], media: grantedMedia },
    ),
    loading: previews.some((preview) => preview.isLoading),
    failedIds,
  };
}

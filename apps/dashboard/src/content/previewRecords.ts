// previewRecordMaps normalizes every Data Source preview payload shape
// (StructuredPreview, CalendarPreview, TypedRecordData, TypedDatasetPayload) into flat
// string record maps. Shared by the Widget presentation preview and the DataSourcePicker
// sample rows so the union handling exists in exactly one place.
export function previewRecordMaps(value: unknown): Record<string, string>[] {
  if (!value || typeof value !== "object") return [];
  const root = value as Record<string, unknown>;
  const direct = Array.isArray(root.records) ? root.records : undefined;
  const configuration =
    root.configuration && typeof root.configuration === "object"
      ? (root.configuration as Record<string, unknown>)
      : undefined;
  const data =
    configuration?.data && typeof configuration.data === "object"
      ? (configuration.data as Record<string, unknown>)
      : undefined;
  const datasets = Array.isArray(root.datasets) ? root.datasets : [];
  const datasetEntries = datasets.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const dataset = entry as Record<string, unknown>;
    if (Array.isArray(dataset.records))
      return (dataset.records as unknown[]).filter(
        (record): record is Record<string, unknown> =>
          Boolean(record) && typeof record === "object",
      );
    if (Array.isArray(dataset.points))
      return (dataset.points as unknown[]).filter(
        (record): record is Record<string, unknown> =>
          Boolean(record) && typeof record === "object",
      );
    return dataset.values && typeof dataset.values === "object"
      ? [dataset.values]
      : [];
  });
  const records =
    direct ??
    (Array.isArray(data?.records)
      ? data.records
      : Array.isArray(data?.events)
        ? data.events
        : datasetEntries);
  return records.slice(0, 12).map((item, index) => {
    if (!item || typeof item !== "object") return { id: String(index) };
    const record = item as Record<string, unknown>;
    const values =
      record.values && typeof record.values === "object"
        ? (record.values as Record<string, unknown>)
        : {};
    const flattened = { ...record, ...values };
    if (typeof record.start === "string") {
      flattened.date ??= record.start.split("T")[0];
      flattened.startTime ??= record.start;
    }
    if (typeof record.end === "string") flattened.endTime ??= record.end;
    if (typeof record.descriptionExcerpt === "string")
      flattened.description ??= record.descriptionExcerpt;
    return Object.fromEntries(
      Object.entries(flattened).map(([key, entry]) => [
        key,
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean"
          ? String(entry)
          : "",
      ]),
    );
  });
}

// A Widget may reference more than one Data Source. The compiled presentation names the dataset
// each binding reads as "<dataSourceId>:<datasetId>", so the preview resolves bindings against a
// map keyed the same way rather than against one flat record list. Without this, a two-source
// Widget rendered every binding from whichever source happened to be declared first.
export type PreviewDatasets = Record<string, Record<string, string>[]>;
export type PreviewDatasetCurrencies = Record<string, Record<string, string>>;

function fieldCurrencies(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const root = value as Record<string, unknown>;
  const fields = Array.isArray(root.fields) ? root.fields : [];
  return Object.fromEntries(
    fields.flatMap((field) => {
      if (!field || typeof field !== "object") return [];
      const item = field as Record<string, unknown>;
      return typeof item.key === "string" &&
        typeof item.currency === "string" &&
        item.currency
        ? [[item.key, item.currency]]
        : [];
    }),
  );
}

export function previewFieldCurrencies(value: unknown): Record<string, string> {
  return fieldCurrencies(value);
}

export function previewDatasetCurrencies(
  dataSourceId: string,
  value: unknown,
): PreviewDatasetCurrencies {
  if (!value || typeof value !== "object") return {};
  const root = value as Record<string, unknown>;
  const datasets = Array.isArray(root.datasets) ? root.datasets : undefined;
  if (!datasets) return { [`${dataSourceId}:records`]: fieldCurrencies(value) };
  const result: PreviewDatasetCurrencies = {};
  for (const entry of datasets) {
    if (!entry || typeof entry !== "object") continue;
    const dataset = entry as Record<string, unknown>;
    const id = typeof dataset.id === "string" ? dataset.id : "records";
    result[`${dataSourceId}:${id}`] = fieldCurrencies(dataset);
  }
  return result;
}

export function previewDatasetMaps(
  dataSourceId: string,
  value: unknown,
): PreviewDatasets {
  if (!value || typeof value !== "object") return {};
  const root = value as Record<string, unknown>;
  const datasets = Array.isArray(root.datasets) ? root.datasets : undefined;
  if (!datasets)
    // The single-dataset payload shapes have no id of their own; the server names their dataset
    // "records" when it builds the Data Document, so match that.
    return { [`${dataSourceId}:records`]: previewRecordMaps(value) };
  const result: PreviewDatasets = {};
  for (const entry of datasets) {
    if (!entry || typeof entry !== "object") continue;
    const dataset = entry as Record<string, unknown>;
    const id = typeof dataset.id === "string" ? dataset.id : "records";
    result[`${dataSourceId}:${id}`] = previewRecordMaps({
      datasets: [dataset],
    });
  }
  return result;
}

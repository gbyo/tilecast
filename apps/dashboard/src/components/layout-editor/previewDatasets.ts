import type { components } from "@tilecast/api-schema/generated/openapi";
import type { StructuredRecord } from "../../api/types";

type PreviewDataset = components["schemas"]["TypedPreviewDataset"];

function titleOf(values: Record<string, string>): string {
  return values["title"] ?? Object.values(values).find(Boolean) ?? "";
}

/**
 * A Data Source preview answers named datasets, and a dataset holds one of
 * three shapes: a record collection, an object of values, or time-series
 * points. Layout bindings and Widgets read rows, so each shape becomes rows:
 * a record is a row, an object of values is one row, and a point is a row
 * whose `at` field carries its time.
 */
export function previewRecordsFromDatasets(
  datasets: readonly PreviewDataset[],
): StructuredRecord[] {
  return datasets.flatMap((dataset) => {
    const rows: StructuredRecord[] = [];
    for (const record of dataset.records ?? []) {
      rows.push({
        id: record.id,
        title: titleOf(record.values),
        values: record.values,
      });
    }
    if (dataset.values && Object.keys(dataset.values).length > 0) {
      rows.push({
        id: dataset.id,
        title: titleOf(dataset.values),
        values: dataset.values,
      });
    }
    for (const point of dataset.points ?? []) {
      const values = { at: point.at, ...point.values };
      rows.push({
        id: `${dataset.id}:${point.at}`,
        title: titleOf(point.values),
        date: point.at,
        values,
      });
    }
    return rows;
  });
}

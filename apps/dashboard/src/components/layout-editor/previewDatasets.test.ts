import { describe, expect, it } from "vitest";
import { previewRecordsFromDatasets } from "./previewDatasets";

const base = { usingCachedData: false, unavailable: false };

describe("previewRecordsFromDatasets", () => {
  it("turns a record dataset into one row per record", () => {
    const rows = previewRecordsFromDatasets([
      {
        ...base,
        id: "menu",
        kind: "records",
        records: [
          { id: "r1", values: { title: "Soup", price: "4" } },
          { id: "r2", values: { price: "6" } },
        ],
      },
    ]);
    expect(rows).toEqual([
      { id: "r1", title: "Soup", values: { title: "Soup", price: "4" } },
      { id: "r2", title: "6", values: { price: "6" } },
    ]);
  });

  it("turns an object of values into a single row", () => {
    const rows = previewRecordsFromDatasets([
      {
        ...base,
        id: "weather",
        kind: "object",
        values: { temperature: "18", summary: "Cloudy" },
      },
    ]);
    expect(rows).toEqual([
      {
        id: "weather",
        title: "18",
        values: { temperature: "18", summary: "Cloudy" },
      },
    ]);
  });

  it("turns time-series points into rows that carry their time", () => {
    const rows = previewRecordsFromDatasets([
      {
        ...base,
        id: "forecast",
        kind: "series",
        points: [
          { at: "2026-07-01T09:00:00Z", values: { high: "21" } },
          { at: "2026-07-01T10:00:00Z", values: { high: "23" } },
        ],
      },
    ]);
    expect(rows).toEqual([
      {
        id: "forecast:2026-07-01T09:00:00Z",
        title: "21",
        date: "2026-07-01T09:00:00Z",
        values: { at: "2026-07-01T09:00:00Z", high: "21" },
      },
      {
        id: "forecast:2026-07-01T10:00:00Z",
        title: "23",
        date: "2026-07-01T10:00:00Z",
        values: { at: "2026-07-01T10:00:00Z", high: "23" },
      },
    ]);
  });

  it("keeps every dataset's rows in order and skips empty shapes", () => {
    const rows = previewRecordsFromDatasets([
      { ...base, id: "empty", kind: "object", values: {} },
      {
        ...base,
        id: "a",
        kind: "records",
        records: [{ id: "r1", values: { title: "One" } }],
      },
      { ...base, id: "b", kind: "object", values: { title: "Two" } },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["r1", "b"]);
  });
});

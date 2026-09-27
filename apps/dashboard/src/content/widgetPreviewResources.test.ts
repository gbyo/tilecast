import { describe, expect, it } from "vitest";
import { createWidgetResources } from "@tilecast/widget-sdk";
import { previewToDataDocument } from "./widgetPreviewResources";
import type {
  CalendarPreview,
  StructuredPreview,
  TypedDatasetPayload,
  TypedRecordData,
} from "../api/types";

function typedRecords(): TypedRecordData {
  return {
    fields: [
      { key: "home", label: "Home", type: "text" },
      { key: "goals", label: "Goals", type: "integer" },
      { key: "rating", label: "Rating", type: "number" },
      { key: "live", label: "Live", type: "boolean" },
      { key: "playedAt", label: "Played", type: "datetime" },
      { key: "price", label: "Price", type: "currency", currency: "USD" },
    ],
    records: [
      {
        id: "r1",
        values: {
          home: "Riverside",
          goals: "3",
          rating: "8.5",
          live: "true",
          playedAt: "2026-09-28T14:00:00Z",
          price: "12.5",
        },
      },
      {
        id: "r2",
        values: { home: "Hilltop", goals: "many", live: "yes" },
      },
    ],
    cachedAt: "2026-09-28T15:00:00Z",
    usingCachedData: false,
    attribution: "League feed",
    unavailable: false,
  };
}

describe("previewToDataDocument", () => {
  it("projects typed records with typed values and attribution", () => {
    const document = previewToDataDocument(typedRecords());
    expect(document?.schemaVersion).toBe(1);
    expect(document?.datasets).toHaveLength(1);
    const dataset = document?.datasets[0];
    expect(dataset?.kind).toBe("records");
    expect(dataset?.attribution).toBe("League feed");
    const first = dataset?.records?.[0]?.values;
    expect(first?.["goals"]).toEqual({ kind: "integer", integer: 3 });
    expect(first?.["rating"]).toEqual({ kind: "number", number: 8.5 });
    expect(first?.["live"]).toEqual({ kind: "boolean", boolean: true });
    expect(first?.["playedAt"]).toEqual({
      kind: "datetime",
      datetime: "2026-09-28T14:00:00Z",
    });
    // The currency code travels in the field metadata (asserted below),
    // never in the value: formatWidgetValue renders value.text before any
    // numeric branch, so stamping it here would hide the amount.
    expect(first?.["price"]).toEqual({ kind: "currency", number: 12.5 });
    expect(dataset?.fields?.find((field) => field.key === "price")).toEqual({
      key: "price",
      label: "Price",
      type: "currency",
      currency: "USD",
    });
    // Unparseable values degrade to text instead of failing the preview.
    const second = dataset?.records?.[1]?.values;
    expect(second?.["goals"]).toEqual({ kind: "text", text: "many" });
    expect(second?.["live"]).toEqual({ kind: "text", text: "yes" });
    expect(document?.cache?.usingCachedData).toBe(false);
  });

  it("projects typed dataset payloads with datasets and attribution", () => {
    const payload: TypedDatasetPayload = {
      datasets: [
        {
          id: "matches",
          kind: "records",
          fields: [{ key: "home", label: "Home", type: "text" }],
          records: [{ id: "r1", values: { home: "Riverside" } }],
          attribution: "League feed",
        },
      ],
    };
    const document = previewToDataDocument(payload);
    expect(document?.datasets).toHaveLength(1);
    expect(document?.datasets[0]?.records?.[0]?.values["home"]).toEqual({
      kind: "text",
      text: "Riverside",
    });
  });

  it("projects calendar previews into event records", () => {
    const preview = {
      configuration: {
        data: {
          events: [
            {
              id: "e1",
              calendar: "Home",
              title: "Final",
              start: "2026-09-28T14:00:00Z",
              end: "2026-09-28T16:00:00Z",
              allDay: false,
              location: "Stadium",
            },
          ],
          cachedAt: "2026-09-28T15:00:00Z",
          staleAt: "2026-09-28T16:00:00Z",
          usingCachedData: false,
        },
      },
    } as unknown as CalendarPreview;
    const document = previewToDataDocument(preview);
    const values = document?.datasets[0]?.records?.[0]?.values;
    expect(values?.["title"]).toEqual({ kind: "text", text: "Final" });
    expect(values?.["start"]).toEqual({
      kind: "datetime",
      datetime: "2026-09-28T14:00:00Z",
    });
    expect(values?.["location"]).toEqual({
      kind: "text",
      text: "Stadium",
    });
  });

  it("projects structured previews into text records", () => {
    const preview = {
      configuration: {
        data: {
          records: [
            {
              id: "n1",
              title: "Win",
              subtitle: "League",
              values: { league: "Premier" },
            },
          ],
          cachedAt: "2026-09-28T15:00:00Z",
          staleAt: "2026-09-28T16:00:00Z",
          usingCachedData: false,
        },
      },
    } as unknown as StructuredPreview;
    const document = previewToDataDocument(preview);
    const values = document?.datasets[0]?.records?.[0]?.values;
    expect(values?.["title"]).toEqual({ kind: "text", text: "Win" });
    expect(values?.["subtitle"]).toEqual({ kind: "text", text: "League" });
    expect(values?.["league"]).toEqual({ kind: "text", text: "Premier" });
  });

  it("returns null for unknown shapes instead of guessing", () => {
    expect(previewToDataDocument(null)).toBeNull();
    expect(previewToDataDocument(undefined)).toBeNull();
    expect(previewToDataDocument({ kind: "mystery" } as never)).toBeNull();
  });

  it("narrows grants to the component's declared sources", () => {
    const document = previewToDataDocument(typedRecords());
    const resources = createWidgetResources(
      { documents: new Map([["connected", document!]]) },
      { dataSources: ["connected"] },
    );
    expect(resources.dataset("connected", "records")?.kind).toBe("records");
    expect(resources.dataset("other", "records")).toBeNull();
    const narrowed = createWidgetResources(
      { documents: new Map([["connected", document!]]) },
      { dataSources: ["other"] },
    );
    // The document exists but the grant does not cover it.
    expect(narrowed.dataset("connected", "records")).toBeNull();
    expect(narrowed.dataDocument("connected")).toBeNull();
  });
});

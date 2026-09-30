import { describe, expect, it } from "vitest";
import { createWidgetResources } from "@tilecast/widget-sdk";
import {
  previewDataSourceMedia,
  previewToDataDocument,
} from "./widgetPreviewResources";
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
          usingCachedData: false,
          unavailable: false,
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

describe("previewDataSourceMedia", () => {
  it("grants only typed assets in the selected field and record bound", () => {
    const document = {
      schemaVersion: 1,
      datasets: [
        {
          id: "records",
          kind: "records",
          fields: [
            { key: "cover", label: "Cover", type: "asset" },
            { key: "other", label: "Other", type: "asset" },
          ],
          records: [
            {
              id: "one",
              values: {
                cover: {
                  kind: "asset",
                  assetId: "11111111-1111-4111-8111-111111111111",
                },
                other: {
                  kind: "asset",
                  assetId: "22222222-2222-4222-8222-222222222222",
                },
              },
            },
            {
              id: "two",
              values: {
                cover: {
                  kind: "asset",
                  assetId: "33333333-3333-4333-8333-333333333333",
                },
              },
            },
          ],
        },
      ],
    };
    expect(
      previewDataSourceMedia(new Map([["source-a", document]]), [
        { dataSourceId: "source-a", fieldKey: "cover", maximumItems: 1 },
      ]),
    ).toEqual([
      {
        assetId: "11111111-1111-4111-8111-111111111111",
        variantId: "preview",
      },
    ]);
  });

  it("does not grant assets from an untyped field", () => {
    const records = Array.from({ length: 20 }, (_, index) => {
      const block = String(index + 1).padStart(8, "0");
      return {
        id: `row-${index}`,
        values: {
          image: {
            kind: "asset",
            assetId: `${block}-1111-4111-8111-111111111111`,
          },
        },
      };
    });
    const document = {
      schemaVersion: 1,
      datasets: [
        {
          id: "records",
          kind: "records",
          fields: [{ key: "image", label: "Image", type: "text" }],
          records,
        },
      ],
    };
    expect(
      previewDataSourceMedia(new Map([["source-a", document]]), [
        { dataSourceId: "source-a", fieldKey: "image", maximumItems: 100 },
      ]),
    ).toEqual([]);
  });

  it("stops after the component media grant limit", () => {
    const records = Array.from({ length: 20 }, (_, index) => {
      const block = String(index + 1).padStart(8, "0");
      return {
        id: `row-${index}`,
        values: {
          image: {
            kind: "asset",
            assetId: `${block}-1111-4111-8111-111111111111`,
          },
        },
      };
    });
    const document = {
      schemaVersion: 1,
      datasets: [
        {
          id: "records",
          kind: "records",
          fields: [{ key: "image", label: "Image", type: "asset" }],
          records,
        },
      ],
    };
    expect(
      previewDataSourceMedia(new Map([["source-a", document]]), [
        { dataSourceId: "source-a", fieldKey: "image", maximumItems: 100 },
      ]),
    ).toHaveLength(16);
  });
});

import { describe, expect, it } from "vitest";
import { createWidgetResources } from "@tilecast/widget-sdk";
import {
  previewDataSourceMedia,
  previewToDataDocument,
} from "./widgetPreviewResources";
import valueFixtures from "../../../../packages/manifest-schema/data-document-value-fixtures.json";
import type {
  CalendarPreview,
  StructuredPreview,
  TypedDatasetPayload,
  TypedRecordData,
} from "../api/types";

function typedRecords(): TypedRecordData {
  return {
    fields: [
      { key: "home", label: "Home", type: "text", role: "headline" },
      { key: "goals", label: "Goals", type: "integer" },
      { key: "rating", label: "Rating", type: "number" },
      { key: "live", label: "Live", type: "boolean" },
      { key: "playedAt", label: "Played", type: "datetime" },
      { key: "price", label: "Price", type: "currency", currency: "USD" },
      { key: "winRate", label: "Win rate", type: "percent" },
      { key: "playedOn", label: "Played on", type: "date" },
      { key: "elapsed", label: "Elapsed", type: "duration" },
      { key: "link", label: "Link", type: "url" },
      { key: "cover", label: "Cover", type: "asset" },
      { key: "blank", label: "Blank", type: "asset" },
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
          winRate: "0.75",
          playedOn: "2026-09-28",
          elapsed: "5400",
          link: "https://example.org/image.png",
          cover: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
          blank: "",
        },
      },
      {
        id: "r2",
        values: {
          home: "Hilltop",
          goals: "9007199254740992",
          live: "yes",
          rating: "NaN",
          price: "not-money",
          winRate: "Infinity",
          playedAt: "not-a-timestamp",
          playedOn: "2026-02-30",
          elapsed: "1h30m",
          link: "/relative/path",
          cover: "not-a-uuid",
        },
      },
    ],
    cachedAt: "2026-09-28T15:00:00Z",
    usingCachedData: false,
    attribution: "League feed",
    unavailable: false,
  };
}

describe("previewToDataDocument", () => {
  it.each(valueFixtures)(
    "agrees with the shared $kind fixture for '$raw'",
    ({ kind, raw, expected }) => {
      const preview: TypedRecordData = {
        fields: [{ key: "value", label: "Value", type: kind }],
        records: [{ id: "record", values: { value: raw } }],
        usingCachedData: false,
        unavailable: false,
      };
      expect(
        previewToDataDocument(preview)?.datasets[0]?.records?.[0]?.values.value,
      ).toEqual(expected);
    },
  );
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
    expect(first?.["winRate"]).toEqual({ kind: "percent", number: 0.75 });
    expect(first?.["playedOn"]).toEqual({ kind: "date", date: "2026-09-28" });
    expect(first?.["elapsed"]).toEqual({
      kind: "duration",
      durationSeconds: 5400,
    });
    expect(first?.["cover"]).toEqual({
      kind: "asset",
      assetId: "abcdefab-cdef-4abc-8def-abcdefabcdef",
    });
    expect(first?.["link"]).toEqual({
      kind: "url",
      url: "https://example.org/image.png",
    });
    expect(first?.["blank"]).toEqual({ kind: "null" });
    expect(dataset?.fields?.find((field) => field.key === "price")).toEqual({
      key: "price",
      label: "Price",
      type: "currency",
      currency: "USD",
    });
    expect(dataset?.fields?.find((field) => field.key === "home")).toEqual({
      key: "home",
      label: "Home",
      type: "text",
      role: "headline",
    });
    // Unparseable values degrade to text instead of failing the preview.
    const second = dataset?.records?.[1]?.values;
    expect(second?.["goals"]).toEqual({
      kind: "text",
      text: "9007199254740992",
    });
    expect(second?.["live"]).toEqual({ kind: "text", text: "yes" });
    expect(second?.["rating"]).toEqual({ kind: "text", text: "NaN" });
    expect(second?.["price"]).toEqual({ kind: "text", text: "not-money" });
    expect(second?.["winRate"]).toEqual({ kind: "text", text: "Infinity" });
    expect(second?.["playedAt"]).toEqual({
      kind: "text",
      text: "not-a-timestamp",
    });
    expect(second?.["playedOn"]).toEqual({ kind: "text", text: "2026-02-30" });
    expect(second?.["link"]).toEqual({ kind: "text", text: "/relative/path" });
    expect(second?.["elapsed"]).toEqual({ kind: "text", text: "1h30m" });
    expect(second?.["cover"]).toEqual({ kind: "text", text: "not-a-uuid" });
    expect(document?.cache?.usingCachedData).toBe(false);
  });

  it("projects time-series points, metadata, and object datasets", () => {
    const payload: TypedDatasetPayload = {
      datasets: [
        {
          id: "hourly",
          kind: "time_series",
          fields: [{ key: "pm25", label: "PM2.5", type: "number" }],
          points: [{ at: "2026-09-28T14:00:00Z", values: { pm25: "12.5" } }],
          timezone: "America/New_York",
          units: { pm25: "µg/m³" },
          usingCachedData: false,
          unavailable: false,
        },
        {
          id: "matches",
          kind: "records",
          fields: [{ key: "home", label: "Home", type: "text" }],
          records: [{ id: "r1", values: { home: "Riverside" } }],
          attribution: "League feed",
          usingCachedData: false,
          unavailable: false,
        },
        {
          id: "current",
          kind: "object",
          fields: [{ key: "status", label: "Status", type: "text" }],
          values: { status: "Open" },
          attribution: "Library feed",
          usingCachedData: false,
          unavailable: false,
        },
      ],
    };
    const document = previewToDataDocument(payload);
    expect(document?.datasets).toHaveLength(3);
    expect(document?.datasets[0]).toMatchObject({
      id: "hourly",
      kind: "time_series",
      timezone: "America/New_York",
      units: { pm25: "µg/m³" },
      points: [
        {
          at: "2026-09-28T14:00:00Z",
          values: { pm25: { kind: "number", number: 12.5 } },
        },
      ],
    });
    expect(document?.datasets[1]?.records?.[0]?.values["home"]).toEqual({
      kind: "text",
      text: "Riverside",
    });
    expect(document?.datasets[2]).toMatchObject({
      id: "current",
      kind: "object",
      attribution: "Library feed",
      value: {
        kind: "object",
        object: { status: { kind: "text", text: "Open" } },
      },
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

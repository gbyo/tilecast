// @vitest-environment jsdom
// A Widget may reference more than one Data Source. The compiled presentation names the dataset
// each binding reads as "<dataSourceId>:<datasetId>"; the preview previously ignored those names
// and rendered every binding from one flat record list, so a two-source Widget showed the first
// source's data everywhere.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WidgetPresentation } from "../api/types";
import { DeclarativePresentationPreview } from "./SourceEditors";
import { previewDatasetMaps } from "./previewRecords";
import { previewDatasetCurrencies } from "./previewRecords";

afterEach(cleanup);

const lunch = {
  fields: [{ key: "title", label: "Title", type: "text" }],
  records: [{ id: "1", values: { title: "Chicken sandwich" } }],
  usingCachedData: false,
  unavailable: false,
};
const weather = {
  fields: [{ key: "summary", label: "Summary", type: "text" }],
  records: [{ id: "1", values: { summary: "Partly cloudy" } }],
  usingCachedData: false,
  unavailable: false,
};

function presentation(root: WidgetPresentation["native"]): WidgetPresentation {
  return {
    schemaVersion: 1,
    kind: "native",
    requiredCapabilities: {},
    native: root,
  };
}

describe("previewDatasetMaps", () => {
  it("keys a single-dataset payload the way the server names it", () => {
    expect(Object.keys(previewDatasetMaps("src-1", lunch))).toEqual([
      "src-1:records",
    ]);
  });

  it("keys each dataset of a multi-dataset payload", () => {
    const keys = Object.keys(
      previewDatasetMaps("src-1", {
        datasets: [
          { id: "records", kind: "records", records: lunch.records },
          { id: "current", kind: "object", values: { summary: "Sunny" } },
        ],
      }),
    );
    expect(keys).toEqual(["src-1:records", "src-1:current"]);
  });

  it("returns nothing for a payload that has not loaded", () => {
    expect(previewDatasetMaps("src-1", undefined)).toEqual({});
  });

  it("keeps explicit currency metadata beside preview records", () => {
    expect(
      previewDatasetCurrencies("menu", {
        fields: [
          { key: "price", label: "Price", type: "currency", currency: "EUR" },
        ],
        records: [{ id: "1", values: { price: "4.5" } }],
      }),
    ).toEqual({ "menu:records": { price: "EUR" } });
  });
});

describe("DeclarativePresentationPreview dataset resolution", () => {
  const twoBindings = presentation({
    root: {
      type: "column",
      children: [
        {
          type: "text",
          binding: {
            source: "dataset",
            dataset: "lunch-source:records",
            path: "title",
          },
        },
        {
          type: "text",
          binding: {
            source: "dataset",
            dataset: "weather-source:records",
            path: "summary",
          },
        },
      ],
    },
  });

  it("reads each binding from the source it names", () => {
    render(
      <DeclarativePresentationPreview
        presentation={twoBindings}
        source={lunch}
        datasets={{
          ...previewDatasetMaps("lunch-source", lunch),
          ...previewDatasetMaps("weather-source", weather),
        }}
      />,
    );

    expect(screen.getByText("Chicken sandwich")).toBeTruthy();
    expect(screen.getByText("Partly cloudy")).toBeTruthy();
  });

  // The sharpest case: two sources exposing the same field name. Before the fix both bindings
  // read record[0] of one payload, so both rendered the same value.
  it("keeps sources apart when they share a field name", () => {
    const north = {
      fields: [{ key: "status", label: "Status", type: "text" }],
      records: [{ id: "1", values: { status: "Open" } }],
      usingCachedData: false,
      unavailable: false,
    };
    const south = {
      fields: [{ key: "status", label: "Status", type: "text" }],
      records: [{ id: "1", values: { status: "Closed" } }],
      usingCachedData: false,
      unavailable: false,
    };
    render(
      <DeclarativePresentationPreview
        presentation={presentation({
          root: {
            type: "column",
            children: [
              {
                type: "text",
                binding: {
                  source: "dataset",
                  dataset: "north:records",
                  path: "status",
                },
              },
              {
                type: "text",
                binding: {
                  source: "dataset",
                  dataset: "south:records",
                  path: "status",
                },
              },
            ],
          },
        })}
        source={north}
        datasets={{
          ...previewDatasetMaps("north", north),
          ...previewDatasetMaps("south", south),
        }}
      />,
    );

    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("Closed")).toBeTruthy();
  });

  // Single-source Widgets, and presentations compiled before datasets were keyed, must be
  // unaffected: an unknown dataset name falls back to the primary payload.
  it("falls back to the primary payload for an unknown dataset name", () => {
    render(
      <DeclarativePresentationPreview
        presentation={presentation({
          root: {
            type: "text",
            binding: {
              source: "dataset",
              dataset: "not-a-known-key:records",
              path: "title",
            },
          },
        })}
        source={lunch}
        datasets={previewDatasetMaps("lunch-source", lunch)}
      />,
    );

    expect(screen.getByText("Chicken sandwich")).toBeTruthy();
  });

  it("works with no dataset map at all", () => {
    render(
      <DeclarativePresentationPreview
        presentation={presentation({
          root: {
            type: "text",
            binding: { source: "dataset", path: "title" },
          },
        })}
        source={lunch}
      />,
    );

    expect(screen.getByText("Chicken sandwich")).toBeTruthy();
  });

  it("repeats over the dataset the repeat node names", () => {
    const manyLunch = {
      fields: lunch.fields,
      records: [
        { id: "1", values: { title: "Monday" } },
        { id: "2", values: { title: "Tuesday" } },
      ],
      usingCachedData: false,
      unavailable: false,
    };
    render(
      <DeclarativePresentationPreview
        presentation={presentation({
          root: {
            type: "repeat",
            repeat: { dataset: "menu-source:records", limit: 10 },
            children: [
              { type: "text", binding: { source: "repeat", path: "title" } },
            ],
          },
        })}
        source={weather}
        datasets={previewDatasetMaps("menu-source", manyLunch)}
      />,
    );

    expect(screen.getByText("Monday")).toBeTruthy();
    expect(screen.getByText("Tuesday")).toBeTruthy();
  });

  it("renders currency bindings using their ISO code and organization locale", () => {
    const currency = presentation({
      root: {
        type: "text",
        binding: {
          source: "dataset",
          dataset: "menu:records",
          path: "price",
          format: "currency",
          precision: 2,
        },
      },
    });
    render(
      <DeclarativePresentationPreview
        presentation={currency}
        source={{}}
        datasets={{ "menu:records": [{ price: "1234.5" }] }}
        datasetCurrencies={{ "menu:records": { price: "EUR" } }}
        regional={{ locale: "de-DE", timezone: "Europe/Berlin" }}
      />,
    );
    expect(screen.getByText("1.234,50 €")).toBeVisible();
  });
});

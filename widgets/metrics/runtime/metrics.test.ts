import { afterEach, describe, expect, it } from "vitest";
import { fixtureResources, mountForTest } from "@tilecast/widget-sdk/testing";
import type { WidgetDataDocument } from "@tilecast/widget-sdk";
import widget from "./index.ts";
import {
  parseMetricsConfig,
  resolveMetricsData,
  type MetricItem,
  type MetricsConfig,
} from "./metrics.ts";

type MetricsElement = HTMLElement & { updateComplete: Promise<unknown> };

const SOURCE = "11111111-1111-4111-8111-111111111111";

const item: MetricItem = {
  valueField: "attendance",
  label: "Attendance",
  labelField: "",
  detailField: "note",
  format: "percent",
  precision: 1,
  prefix: "",
  suffix: "",
};

const base: MetricsConfig = {
  dataSourceId: SOURCE,
  metrics: [item],
  emptyText: "",
  background: null,
  foreground: null,
};

function documentWith(
  datasets: WidgetDataDocument["datasets"],
): Record<string, WidgetDataDocument> {
  return {
    [SOURCE]: {
      schemaVersion: 1,
      datasets: [...datasets],
    },
  };
}

const fields = [
  { key: "attendance", label: "Attendance", type: "number" },
  { key: "students", label: "Students", type: "integer" },
  { key: "note", label: "Note", type: "text" },
];

function recordsDocument(
  records: WidgetDataDocument["datasets"][number]["records"],
): Record<string, WidgetDataDocument> {
  return documentWith([{ id: "records", kind: "records", fields, records }]);
}

const values = {
  attendance: { kind: "number", number: 96.4 },
  students: { kind: "number", integer: 1284 },
  note: { kind: "text", text: "Up 1.2 points" },
};

async function render(
  config: Partial<MetricsConfig>,
  documents?: Record<string, WidgetDataDocument>,
) {
  const test = mountForTest(widget, {
    config: { ...base, ...config },
    resources: fixtureResources({ documents }),
  });
  const element = test.element as MetricsElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  const all = (selector: string) =>
    [...root.querySelectorAll(selector)].map(
      (node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "",
    );
  return { test, element, root, text, all };
}

afterEach(() => document.body.replaceChildren());

describe("Metrics configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseMetricsConfig({ ...base })).toEqual({ ok: true, config: base });
  });

  it("treats missing presentation as blank and themed", () => {
    expect(parseMetricsConfig({ dataSourceId: SOURCE })).toMatchObject({
      ok: true,
      config: {
        metrics: [],
        emptyText: "",
        background: null,
        foreground: null,
      },
    });
  });

  it("skips items without a value field", () => {
    for (const item of [
      { valueField: "", label: "", labelField: "" },
      { label: "No field" },
    ]) {
      expect(
        parseMetricsConfig({ dataSourceId: SOURCE, metrics: [item] }),
      ).toMatchObject({ ok: true, config: { metrics: [] } });
    }
  });

  it.each([
    [null],
    [[]],
    [{ dataSourceId: 42 }],
    [{ dataSourceId: SOURCE, metrics: {} }],
    [
      {
        dataSourceId: SOURCE,
        metrics: [{ ...item, format: "scientific" }],
      },
    ],
    [
      {
        dataSourceId: SOURCE,
        metrics: [{ ...item, precision: 7 }],
      },
    ],
    [
      {
        dataSourceId: SOURCE,
        metrics: new Array(13).fill({ ...item }),
      },
    ],
  ])("rejects %j", (value) => {
    expect(parseMetricsConfig(value).ok).toBe(false);
  });

  it("accepts up to twelve metrics so saved Stat Grids keep rendering", () => {
    const metrics = new Array(12).fill({ ...item });
    expect(parseMetricsConfig({ dataSourceId: SOURCE, metrics })).toMatchObject(
      { ok: true, config: { metrics } },
    );
  });
});

describe("Metrics data resolution", () => {
  it("reads the first record and drops no finite value", () => {
    const resolved = resolveMetricsData(
      base,
      fixtureResources({
        documents: recordsDocument([
          { id: "r1", values },
          {
            id: "r2",
            values: {
              attendance: { kind: "number", number: 10 },
              note: { kind: "text", text: "Second" },
            },
          },
        ]),
      }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { single: true, metrics: [{ raw: 96.4 }] },
    });
  });

  it("reads a single-object source without aggregating", () => {
    const resolved = resolveMetricsData(
      base,
      fixtureResources({
        documents: documentWith([
          {
            id: "object",
            kind: "object",
            fields,
            value: { kind: "object", object: values },
          },
        ]),
      }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { metrics: [{ raw: 96.4 }] },
    });
  });

  it("drops non-finite and missing values, then empties", () => {
    const documents = recordsDocument([
      {
        id: "r1",
        values: {
          attendance: { kind: "number", number: Number.NaN },
          note: { kind: "text", text: "Bad" },
        },
      },
    ]);
    const resolved = resolveMetricsData(
      { ...base, metrics: [item, { ...item, valueField: "absent" }] },
      fixtureResources({ documents }),
    );
    expect(resolved).toMatchObject({ state: "empty" });
  });

  it("keeps usable metrics when one value is unusable", () => {
    const resolved = resolveMetricsData(
      {
        ...base,
        metrics: [item, { ...item, valueField: "absent", label: "Gone" }],
      },
      fixtureResources({ documents: recordsDocument([{ id: "r1", values }]) }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { single: true, metrics: [{ raw: 96.4 }] },
    });
  });

  it.each([
    ["no source", { ...base, dataSourceId: "" }, undefined, "no_source"],
    ["no metrics", { ...base, metrics: [] }, undefined, "no_metrics"],
    [
      "unknown source",
      base,
      recordsDocument([{ id: "r1", values }]),
      "no_source",
    ],
    ["no records", base, recordsDocument([]), "no_records"],
  ])("%s empties with %s", (_label, config, documents, reason) => {
    const resources = fixtureResources(
      documents === undefined
        ? {}
        : _label === "unknown source"
          ? { documents: { other: documents[SOURCE]! } }
          : { documents },
    );
    expect(resolveMetricsData(config, resources)).toMatchObject({
      state: "empty",
      reason,
    });
  });

  it("fails a source with no usable dataset", () => {
    const resolved = resolveMetricsData(
      base,
      fixtureResources({
        documents: documentWith([
          { id: "series", kind: "time_series", fields, points: [] },
        ]),
      }),
    );
    expect(resolved).toMatchObject({
      state: "error",
      code: "incompatible_source",
    });
  });
});

describe("Metrics rendering", () => {
  it("shows the label, formatted value, and detail", async () => {
    const { text } = await render({}, recordsDocument([{ id: "r1", values }]));
    expect(text(".metric-label")).toBe("Attendance");
    expect(text(".metric-value")).toBe("96.4%");
    expect(text(".metric-detail")).toBe("Up 1.2 points");
  });

  it("prefers a mapped label and falls back to the field", async () => {
    const { all } = await render(
      {
        metrics: [
          { ...item, label: "", labelField: "note" },
          {
            ...item,
            valueField: "students",
            label: "",
            format: "integer",
            precision: 0,
          },
        ],
      },
      recordsDocument([{ id: "r1", values }]),
    );
    expect(all(".metric-label")).toEqual(["Up 1.2 points", "Students"]);
    expect(all(".metric-value")).toEqual(["96.4%", "1,284"]);
  });

  it("applies prefix, suffix, and currency metadata", async () => {
    const { text } = await render(
      {
        metrics: [
          {
            ...item,
            valueField: "budget",
            label: "Budget",
            format: "currency",
            precision: 0,
            prefix: "~",
            suffix: "!",
            detailField: "",
          },
        ],
      },
      documentWith([
        {
          id: "records",
          kind: "records",
          fields: [
            {
              key: "budget",
              label: "Budget",
              type: "currency",
              currency: "USD",
            },
          ],
          records: [
            { id: "r1", values: { budget: { kind: "number", number: 1200 } } },
          ],
        },
      ]),
    );
    expect(text(".metric-value")).toBe("~$1,200!");
  });

  it("shows the empty message when configured", async () => {
    const { text } = await render(
      { emptyText: "Nothing yet" },
      recordsDocument([]),
    );
    expect(text(".tc-empty-title")).toBe("Nothing yet");
  });
});

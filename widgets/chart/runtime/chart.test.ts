import { afterEach, describe, expect, it } from "vitest";
import { fixtureResources, mountForTest } from "@tilecast/widget-sdk/testing";
import type { WidgetDataDocument } from "@tilecast/widget-sdk";
import widget from "./index.ts";
import {
  baselineY,
  computeDomain,
  niceTicks,
  scaleY,
  seriesPaths,
  barRects,
} from "./chart-model.ts";
import {
  formatChartLabel,
  parseChartConfig,
  resolveChartData,
  resolveChartStyle,
  type ChartConfig,
} from "./chart.ts";

type ChartElement = HTMLElement & { updateComplete: Promise<unknown> };

const SOURCE = "11111111-1111-4111-8111-111111111111";

const base: ChartConfig = {
  dataSourceId: SOURCE,
  dataset: "",
  series: [{ field: "sales", label: "Sales", color: null }],
  categoryField: "month",
  timeField: "",
  style: "bar",
  showLegend: true,
  showAxes: true,
  minimum: null,
  maximum: null,
  emptyText: "",
  background: null,
  foreground: null,
};

const fields = [
  { key: "month", label: "Month", type: "text" },
  { key: "sales", label: "Sales", type: "integer" },
  { key: "returns", label: "Returns", type: "integer" },
];

function recordsDocument(
  records: WidgetDataDocument["datasets"][number]["records"],
): Record<string, WidgetDataDocument> {
  return {
    [SOURCE]: {
      schemaVersion: 1,
      datasets: [{ id: "records", kind: "records", fields, records }],
    },
  };
}

const records = [
  {
    id: "r1",
    values: {
      month: { kind: "text", text: "Jan" },
      sales: { kind: "number", integer: 40 },
      returns: { kind: "number", integer: 4 },
    },
  },
  {
    id: "r2",
    values: {
      month: { kind: "text", text: "Feb" },
      sales: { kind: "number", integer: 65 },
      returns: { kind: "number", integer: 7 },
    },
  },
  {
    id: "r3",
    values: {
      month: { kind: "text", text: "Mar" },
      sales: { kind: "number", integer: 52 },
      returns: { kind: "number", integer: 2 },
    },
  },
];

async function render(
  config: Partial<ChartConfig>,
  documents?: Record<string, WidgetDataDocument>,
) {
  const test = mountForTest(widget, {
    config: { ...base, ...config },
    resources: fixtureResources({ documents }),
  });
  const element = test.element as ChartElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  return { test, element, root };
}

afterEach(() => document.body.replaceChildren());

describe("Chart domain correctness", () => {
  it.each([
    ["positive-only", [3, 9, 5], null, null, [3, 9]],
    ["negative-only", [-9, -3], null, null, [-9, -3]],
    ["mixed", [-4, 8], null, null, [-4, 8]],
    ["zero", [0, 0, 0], null, null, [-1, 1]],
    ["explicit minimum only", [3, 9], 0, null, [0, 9]],
    ["explicit maximum only", [3, 9], null, 20, [3, 20]],
    ["explicit min and max", [3, 9], 0, 20, [0, 20]],
    ["invalid min above max", [3, 9], 20, 0, [3, 9]],
    ["invalid min equal max", [3, 9], 5, 5, [3, 9]],
    ["no data", [], null, null, [0, 1]],
  ])("%s", (_label, values, minimum, maximum, [min, max]) => {
    expect(computeDomain(values, minimum, maximum)).toEqual({ min, max });
  });

  it("expands an all-equal domain symmetrically", () => {
    expect(computeDomain([7, 7], null, null)).toEqual({ min: 0, max: 14 });
    expect(computeDomain([-4, -4], null, null)).toEqual({ min: -8, max: 0 });
  });

  it("baselines bars at zero inside the domain and at the edge outside", () => {
    expect(baselineY({ min: -4, max: 8 })).toBe(scaleY(0, { min: -4, max: 8 }));
    expect(baselineY({ min: 50, max: 90 })).toBe(
      scaleY(50, { min: 50, max: 90 }),
    );
  });

  it("leaves gaps at missing and non-finite values", () => {
    const paths = seriesPaths([1, null, 3, Number.NaN, 5], { min: 0, max: 6 }, false);
    // Three isolated points draw nothing as lines; areas fill slivers.
    expect(paths).toEqual([]);
    const areas = seriesPaths([1, null, 3], { min: 0, max: 6 }, true);
    expect(areas).toHaveLength(2);
  });

  it("never emits NaN geometry", () => {
    const domain = computeDomain([5], null, null);
    expect(seriesPaths([5], domain, false)).toEqual([]);
    const rects = barRects(0, 1, [5], domain);
    for (const rect of rects) {
      expect(rect).not.toBeNull();
      for (const edge of Object.values(rect!)) {
        expect(Number.isFinite(edge)).toBe(true);
      }
    }
  });

  it("bounds ticks to a readable few", () => {
    const ticks = niceTicks({ min: 0, max: 96.4 });
    expect(ticks.length).toBeLessThanOrEqual(6);
    expect(ticks.every((tick) => tick >= 0 && tick <= 96.4)).toBe(true);
  });
});

describe("Chart configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseChartConfig({ ...base })).toEqual({ ok: true, config: base });
  });

  it("treats missing presentation as lines with legend and axes", () => {
    expect(
      parseChartConfig({
        dataSourceId: SOURCE,
        series: [{ field: "sales" }],
      }),
    ).toMatchObject({
      ok: true,
      config: {
        style: "line",
        showLegend: true,
        showAxes: true,
        minimum: null,
        maximum: null,
      },
    });
  });

  it.each([["bar", "bar"], ["line", "line"], ["area", "area"]] as const)(
    "uses a valid new style %s over any legacy type",
    (style, want) => {
      expect(resolveChartStyle(style, "donut")).toBe(want);
    },
  );

  it.each([
    ["donut", "bar"],
    ["line", "line"],
    ["bar", "bar"],
  ])("maps legacy chartType %s to %s", (chartType, want) => {
    expect(resolveChartStyle("bogus", chartType)).toBe(want);
    expect(resolveChartStyle(undefined, chartType)).toBe(want);
  });

  it.each([
    [null],
    [{ dataSourceId: 42 }],
    [{ dataSourceId: SOURCE, series: {} }],
    [{ dataSourceId: SOURCE, series: new Array(5).fill({ field: "sales" }) }],
    [{ dataSourceId: SOURCE, series: [{ field: 42 }] }],
    [{ dataSourceId: SOURCE, minimum: "low" }],
    [{ dataSourceId: SOURCE, showLegend: "yes" }],
  ])("rejects %j", (value) => {
    expect(parseChartConfig(value).ok).toBe(false);
  });

  it("keeps an unmapped series for single-value time-series points", () => {
    expect(
      parseChartConfig({ dataSourceId: SOURCE, series: [{ field: "" }] }),
    ).toMatchObject({ ok: true, config: { series: [{ field: "" }] } });
  });
});

describe("Chart data resolution", () => {
  it("plots records with category labels", () => {
    const resolved = resolveChartData(
      base,
      fixtureResources({ documents: recordsDocument(records) }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: {
        style: "bar",
        series: [{ label: "Sales", points: [40, 65, 52] }],
        domain: { min: 40, max: 65 },
      },
    });
  });

  it("reads a time-series single value into the first series", () => {
    const resolved = resolveChartData(
      { ...base, categoryField: "", style: "line" },
      fixtureResources({
        documents: {
          [SOURCE]: {
            schemaVersion: 1,
            datasets: [
              {
                id: "series",
                kind: "time_series",
                points: [
                  { at: "2026-09-26T09:00:00Z", value: { kind: "number", number: 3 } },
                  { at: "2026-09-27T09:00:00Z", value: { kind: "number", number: 5 } },
                ],
              },
            ],
          },
        },
      }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { style: "line", series: [{ points: [3, 5] }] },
    });
  });

  it("keeps gaps for missing values instead of failing", () => {
    const resolved = resolveChartData(
      base,
      fixtureResources({
        documents: recordsDocument([
          records[0]!,
          { id: "r2", values: { month: { kind: "text", text: "Feb" } } },
        ]),
      }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { series: [{ points: [40, null] }] },
    });
  });

  it.each([
    ["no source", { ...base, dataSourceId: "" }, "no_source"],
    ["no series", { ...base, series: [] }, "no_series"],
    ["no records", base, "no_records"],
  ])("%s empties", (_label, config, reason) => {
    const documents =
      _label === "no records" ? recordsDocument([]) : undefined;
    expect(
      resolveChartData(config, fixtureResources({ documents })),
    ).toMatchObject({ state: "empty", reason });
  });

  it("unmapped series empty on records", () => {
    expect(
      resolveChartData(
        { ...base, series: [{ field: "", label: "", color: null }] },
        fixtureResources({ documents: recordsDocument(records) }),
      ),
    ).toMatchObject({ state: "empty", reason: "no_series" });
  });

  it("fails a source with no usable dataset", () => {
    expect(
      resolveChartData(
        base,
        fixtureResources({
          documents: {
            [SOURCE]: {
              schemaVersion: 1,
              datasets: [
                {
                  id: "object",
                  kind: "object",
                  value: { kind: "object", object: {} },
                },
              ],
            },
          },
        }),
      ),
    ).toMatchObject({ state: "error", code: "incompatible_source" });
  });
});

describe("Chart label formatting", () => {
  it("formats record values and numbers the rest", () => {
    expect(
      formatChartLabel({ kind: "text", text: "Jan" }, undefined, "en-US", 0),
    ).toBe("Jan");
    expect(formatChartLabel(null, undefined, "en-US", 2)).toBe("3");
  });
});

describe("Chart rendering", () => {
  it("draws bars with a legend and axes", async () => {
    const { root } = await render(
      {
        series: [
          { field: "sales", label: "Sales", color: null },
          { field: "returns", label: "Returns", color: null },
        ],
      },
      recordsDocument(records),
    );
    expect(root.querySelectorAll("rect").length).toBe(6);
    expect(root.querySelector(".chart-legend")?.textContent).toContain("Sales");
    expect(root.querySelector(".chart-legend")?.textContent).toContain("Returns");
    expect(root.querySelectorAll(".chart-tick").length).toBeGreaterThan(0);
    expect(
      root.querySelector("svg.chart-svg")?.getAttribute("aria-label"),
    ).toContain("bar chart");
  });

  it("draws lines and areas as paths", async () => {
    const line = await render(
      { style: "line" },
      recordsDocument(records),
    );
    const linePaths = line.root.querySelectorAll("path");
    expect(linePaths.length).toBe(1);
    expect(linePaths[0]!.getAttribute("d")).toMatch(/^M/);
    expect(linePaths[0]!.getAttribute("d")).not.toContain("NaN");
    line.test.dispose();
    document.body.replaceChildren();
    const area = await render(
      { style: "area" },
      recordsDocument(records),
    );
    expect(area.root.querySelectorAll("path").length).toBe(2);
  });

  it("renders a legacy donut as bars", async () => {
    const { root } = await render(
      { style: undefined, chartType: "donut" } as never,
      recordsDocument(records),
    );
    expect(root.querySelectorAll("rect").length).toBe(3);
    expect(
      root.querySelector("svg.chart-svg")?.getAttribute("aria-label"),
    ).toContain("bar chart");
  });

  it("shows the empty message when configured", async () => {
    const { root } = await render({ emptyText: "No sales yet" }, recordsDocument([]));
    expect(root.querySelector(".tc-empty-title")?.textContent).toBe(
      "No sales yet",
    );
  });
});

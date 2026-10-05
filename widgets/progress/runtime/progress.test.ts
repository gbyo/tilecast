import { afterEach, describe, expect, it } from "vitest";
import { fixtureResources, mountForTest } from "@tilecast/widget-sdk/testing";
import type { WidgetDataDocument } from "@tilecast/widget-sdk";
import widget from "./index.ts";
import {
  parseProgressConfig,
  resolveProgressData,
  type ProgressConfig,
} from "./progress.ts";

type ProgressElement = HTMLElement & { updateComplete: Promise<unknown> };

const SOURCE = "11111111-1111-4111-8111-111111111111";

const base: ProgressConfig = {
  dataSourceId: SOURCE,
  valueField: "raised",
  targetField: "goal",
  staticTarget: null,
  label: "Campaign",
  labelField: "",
  format: "currency",
  precision: 0,
  showPercent: true,
  completionText: "Goal reached. Thank you!",
  style: "bar",
  emptyText: "",
  background: null,
  foreground: null,
};

const fields = [
  { key: "raised", label: "Raised", type: "currency", currency: "USD" },
  { key: "goal", label: "Goal", type: "currency", currency: "USD" },
];

function recordsDocument(
  records: WidgetDataDocument["datasets"][number]["records"],
): Record<string, WidgetDataDocument> {
  return {
    [SOURCE]: {
      schemaVersion: 1,
      datasets: [
        {
          id: "records",
          kind: "records",
          cache: { usingCachedData: false, unavailable: false },
          fields,
          records,
        },
      ],
    },
  };
}

const values = {
  raised: { kind: "number", number: 48250 },
  goal: { kind: "number", number: 100000 },
};

async function render(
  config: Partial<ProgressConfig>,
  documents?: Record<string, WidgetDataDocument>,
) {
  const test = mountForTest(widget, {
    config: { ...base, ...config },
    resources: fixtureResources({ documents }),
  });
  const element = test.element as ProgressElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  const style = (selector: string, property: string) =>
    (
      root.querySelector(selector) as HTMLElement | null
    )?.style.getPropertyValue(property) ?? null;
  return { test, element, root, text, style };
}

afterEach(() => document.body.replaceChildren());

describe("Progress configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseProgressConfig({ ...base })).toEqual({
      ok: true,
      config: base,
    });
  });

  it("treats missing presentation as a bar with percent", () => {
    expect(
      parseProgressConfig({ dataSourceId: SOURCE, valueField: "raised" }),
    ).toMatchObject({
      ok: true,
      config: {
        targetField: "",
        staticTarget: null,
        format: "number",
        precision: 1,
        showPercent: true,
        style: "bar",
        background: null,
        foreground: null,
      },
    });
  });

  it.each([
    [null],
    [{ dataSourceId: 42 }],
    [{ dataSourceId: SOURCE, staticTarget: "lots" }],
    [{ dataSourceId: SOURCE, format: "scientific" }],
    [{ dataSourceId: SOURCE, precision: -1 }],
    [{ dataSourceId: SOURCE, style: "dial" }],
    [{ dataSourceId: SOURCE, showPercent: "yes" }],
  ])("rejects %j", (value) => {
    expect(parseProgressConfig(value).ok).toBe(false);
  });
});

describe("Progress data resolution", () => {
  it("resolves below target with a field goal", () => {
    const resolved = resolveProgressData(
      base,
      fixtureResources({ documents: recordsDocument([{ id: "r1", values }]) }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { current: 48250, percent: 48.25, complete: false, style: "bar" },
    });
  });

  it("prefers a valid target field over the fixed target", () => {
    const resolved = resolveProgressData(
      { ...base, staticTarget: 10 },
      fixtureResources({ documents: recordsDocument([{ id: "r1", values }]) }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { percent: 48.25 },
    });
  });

  it("uses the fixed target when no field is set", () => {
    const resolved = resolveProgressData(
      { ...base, targetField: "", staticTarget: 50000 },
      fixtureResources({ documents: recordsDocument([{ id: "r1", values }]) }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { percent: 96.5 },
    });
  });

  it("fails when a configured target field is missing instead of using the fixed target", () => {
    const resolved = resolveProgressData(
      { ...base, targetField: "goal", staticTarget: 50000 },
      fixtureResources({
        documents: recordsDocument([
          { id: "r1", values: { raised: { kind: "number", number: 10 } } },
        ]),
      }),
    );
    expect(resolved).toMatchObject({ state: "error", code: "invalid_target" });
  });

  it("reports over one hundred percent honestly", () => {
    const resolved = resolveProgressData(
      { ...base, targetField: "", staticTarget: 100 },
      fixtureResources({
        documents: recordsDocument([
          {
            id: "r1",
            values: { raised: { kind: "number", number: 118 } },
          },
        ]),
      }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { percent: 118, complete: true },
    });
  });

  it("allows a current value below zero", () => {
    const resolved = resolveProgressData(
      { ...base, targetField: "", staticTarget: 100 },
      fixtureResources({
        documents: recordsDocument([
          {
            id: "r1",
            values: { raised: { kind: "number", number: -5 } },
          },
        ]),
      }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { current: -5, percent: -5, complete: false },
    });
  });

  it("reads a single-object source", () => {
    const resolved = resolveProgressData(
      base,
      fixtureResources({
        documents: {
          [SOURCE]: {
            schemaVersion: 1,
            datasets: [
              {
                id: "object",
                kind: "object",
                cache: { usingCachedData: false, unavailable: false },
                fields,
                value: { kind: "object", object: values },
              },
            ],
          },
        },
      }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { percent: 48.25 },
    });
  });

  it.each([
    ["no source", { ...base, dataSourceId: "" }, "no_source"],
    ["no value", base, "no_value"],
  ])("%s empties", (_label, config, reason) => {
    const documents =
      _label === "no value"
        ? recordsDocument([{ id: "r1", values: { goal: values.goal } }])
        : undefined;
    expect(
      resolveProgressData(config, fixtureResources({ documents })),
    ).toMatchObject({ state: "empty", reason });
  });

  it.each([
    ["missing target", { ...base, targetField: "", staticTarget: null }],
    ["zero fixed target", { ...base, targetField: "", staticTarget: 0 }],
    ["negative fixed target", { ...base, targetField: "", staticTarget: -4 }],
    [
      "missing field target",
      { ...base, targetField: "absent", staticTarget: null },
    ],
  ])("%s fails", (_label, config) => {
    expect(
      resolveProgressData(
        config,
        fixtureResources({
          documents: recordsDocument([{ id: "r1", values }]),
        }),
      ),
    ).toMatchObject({ state: "error", code: "invalid_target" });
  });

  it("fails a source with no usable dataset", () => {
    expect(
      resolveProgressData(
        { ...base, targetField: "", staticTarget: 100 },
        fixtureResources({
          documents: {
            [SOURCE]: {
              schemaVersion: 1,
              datasets: [
                {
                  id: "series",
                  kind: "time_series",
                  cache: { usingCachedData: false, unavailable: false },
                  points: [],
                },
              ],
            },
          },
        }),
      ),
    ).toMatchObject({ state: "error", code: "incompatible_source" });
  });
});

describe("Progress rendering", () => {
  it("shows the label, value, and percentage with a bar", async () => {
    const { text, style } = await render(
      {},
      recordsDocument([{ id: "r1", values }]),
    );
    expect(text(".progress-label")).toBe("Campaign");
    expect(text(".progress-main")).toBe("$48,250");
    expect(text(".progress-sub")).toBe("48%");
    expect(style(".bar-fill", "width")).toBe("48.25%");
  });

  it("clamps the fill while displaying over one hundred percent", async () => {
    const { text, style } = await render(
      { targetField: "", staticTarget: 100, format: "number", precision: 0 },
      recordsDocument([
        { id: "r1", values: { raised: { kind: "number", number: 118 } } },
      ]),
    );
    expect(text(".progress-main")).toBe("118");
    expect(text(".progress-sub")).toContain("118%");
    expect(style(".bar-fill", "width")).toBe("100%");
  });

  it("shows completion text exactly at target", async () => {
    const { text } = await render(
      { targetField: "", staticTarget: 48250 },
      recordsDocument([{ id: "r1", values }]),
    );
    expect(text(".progress-main")).toBe("$48,250");
    expect(text(".progress-wrap")).toContain("Goal reached. Thank you!");
  });

  it("renders ring and thermometer shapes", async () => {
    const ring = await render(
      { style: "ring" },
      recordsDocument([{ id: "r1", values }]),
    );
    expect(ring.root.querySelector("svg.ring-svg")).not.toBeNull();
    expect(ring.text(".ring-center")).toBe("$48,250");
    ring.test.dispose();
    document.body.replaceChildren();
    const thermo = await render(
      { style: "thermometer" },
      recordsDocument([{ id: "r1", values }]),
    );
    expect(thermo.root.querySelector(".thermo-fill")).not.toBeNull();
    expect(thermo.style(".thermo-fill", "height")).toBe("48.25%");
  });

  it("hides the percentage when disabled", async () => {
    const { text } = await render(
      { showPercent: false },
      recordsDocument([{ id: "r1", values }]),
    );
    expect(text(".progress-main")).toBe("$48,250");
    expect(text(".progress-wrap")).not.toContain("%");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { fixtureResources, mountForTest } from "@tilecast/widget-sdk/testing";
import type { WidgetDataDocument } from "@tilecast/widget-sdk";
import widget from "./index.ts";
import {
  parseTimelineConfig,
  resolveTimelineData,
  type TimelineConfig,
} from "./timeline.ts";

type TimelineElement = HTMLElement & { updateComplete: Promise<unknown> };

const SOURCE = "11111111-1111-4111-8111-111111111111";

const base: TimelineConfig = {
  dataSourceId: SOURCE,
  dateField: "date",
  titleField: "title",
  bodyField: "body",
  statusField: "status",
  orientation: "vertical",
  maximumItems: 8,
  emptyText: "",
  background: null,
  foreground: null,
};

const fields = [
  { key: "date", label: "Date", type: "date" },
  { key: "title", label: "Title", type: "text" },
  { key: "body", label: "Body", type: "text" },
  { key: "status", label: "Status", type: "text" },
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

const values = {
  date: { kind: "date", date: "2026-09-28" },
  title: { kind: "text", text: "Founded" },
  body: { kind: "text", text: "Doors opened with forty students." },
  status: { kind: "text", text: "Done" },
};

async function render(
  config: Partial<TimelineConfig>,
  documents?: Record<string, WidgetDataDocument>,
) {
  const test = mountForTest(widget, {
    config: { ...base, ...config },
    resources: fixtureResources({ documents }),
  });
  const element = test.element as TimelineElement;
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

describe("Timeline configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseTimelineConfig({ ...base })).toEqual({
      ok: true,
      config: base,
    });
  });

  it("treats missing presentation as a vertical list of eight", () => {
    expect(
      parseTimelineConfig({
        dataSourceId: SOURCE,
        dateField: "date",
        titleField: "title",
      }),
    ).toMatchObject({
      ok: true,
      config: {
        bodyField: "",
        statusField: "",
        orientation: "vertical",
        maximumItems: 8,
        background: null,
        foreground: null,
      },
    });
  });

  it.each([
    [null],
    [{ dataSourceId: 42 }],
    [{ dataSourceId: SOURCE, orientation: "diagonal" }],
    [{ dataSourceId: SOURCE, maximumItems: 0 }],
    [{ dataSourceId: SOURCE, maximumItems: 21 }],
    [{ dataSourceId: SOURCE, maximumItems: 2.5 }],
  ])("rejects %j", (value) => {
    expect(parseTimelineConfig(value).ok).toBe(false);
  });
});

describe("Timeline data resolution", () => {
  it("keeps source order and bounds the count without sorting", () => {
    const second = {
      date: { kind: "date", date: "2026-09-01" },
      title: { kind: "text", text: "Earlier" },
      body: { kind: "text", text: "An earlier date sorts first elsewhere." },
      status: { kind: "text", text: "Done" },
    };
    const resolved = resolveTimelineData(
      { ...base, maximumItems: 1 },
      fixtureResources({
        documents: recordsDocument([
          { id: "r1", values },
          { id: "r2", values: second },
        ]),
      }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: {
        orientation: "vertical",
        milestones: [{ title: { text: "Founded" } }],
      },
    });
  });

  it("keeps the past: no current or upcoming filtering", () => {
    const resolved = resolveTimelineData(
      base,
      fixtureResources({
        documents: recordsDocument([
          { id: "r1", values },
          {
            id: "r2",
            values: { ...values, title: { kind: "text", text: "Second" } },
          },
        ]),
      }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { milestones: [{}, {}] },
    });
  });

  it.each([
    ["no source", { ...base, dataSourceId: "" }, "no_source"],
    ["no records", base, "no_records"],
  ])("%s empties", (_label, config, reason) => {
    const documents = _label === "no records" ? recordsDocument([]) : undefined;
    expect(
      resolveTimelineData(config, fixtureResources({ documents })),
    ).toMatchObject({ state: "empty", reason });
  });

  it("fails a source with no records dataset", () => {
    expect(
      resolveTimelineData(
        base,
        fixtureResources({
          documents: {
            [SOURCE]: {
              schemaVersion: 1,
              datasets: [{ id: "series", kind: "time_series", points: [] }],
            },
          },
        }),
      ),
    ).toMatchObject({ state: "error", code: "incompatible_source" });
  });
});

describe("Timeline rendering", () => {
  it("shows date, title, body, and status", async () => {
    const { text } = await render({}, recordsDocument([{ id: "r1", values }]));
    expect(text(".milestone-date")).toBe("Sep 28, 2026");
    expect(text(".milestone-title")).toBe("Founded");
    expect(text(".milestone-body")).toBe("Doors opened with forty students.");
    expect(text(".milestone-status")).toContain("Done");
  });

  it("flows horizontally when configured", async () => {
    const { root } = await render(
      { orientation: "horizontal" },
      recordsDocument([{ id: "r1", values }]),
    );
    expect(
      root.querySelector(".timeline")?.hasAttribute("data-horizontal"),
    ).toBe(true);
  });

  it("omits missing optional slots", async () => {
    const { root, text } = await render(
      { bodyField: "", statusField: "" },
      recordsDocument([{ id: "r1", values }]),
    );
    expect(text(".milestone-title")).toBe("Founded");
    expect(root.querySelector(".milestone-body")).toBeNull();
    expect(root.querySelector(".tc-badge")).toBeNull();
  });

  it("shows the empty message when configured", async () => {
    const { text } = await render(
      { emptyText: "No milestones yet" },
      recordsDocument([]),
    );
    expect(text(".tc-empty-title")).toBe("No milestones yet");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { fixtureResources, mountForTest } from "@tilecast/widget-sdk/testing";
import type { WidgetDataDocument } from "@tilecast/widget-sdk";
import widget from "./index.ts";
import { parseListConfig, resolveListData, type ListConfig } from "./list.ts";

type ListElement = HTMLElement & { updateComplete: Promise<unknown> };

const SOURCE = "11111111-1111-4111-8111-111111111111";

const base: ListConfig = {
  dataSourceId: SOURCE,
  primaryField: "title",
  secondaryField: "detail",
  leadingField: "",
  trailingField: "budget",
  heading: "Projects",
  maximumItems: 8,
  emptyText: "",
  density: "comfortable",
  showDividers: true,
  background: null,
  foreground: null,
};

function documentWith(
  records: WidgetDataDocument["datasets"][number]["records"],
): Record<string, WidgetDataDocument> {
  return {
    [SOURCE]: {
      schemaVersion: 1,
      datasets: [
        {
          id: "records",
          kind: "records",
          fields: [
            { key: "title", label: "Title", type: "text" },
            { key: "detail", label: "Detail", type: "text" },
            {
              key: "budget",
              label: "Budget",
              type: "currency",
              currency: "USD",
            },
          ],
          records,
        },
      ],
    },
  };
}

const records = [
  {
    id: "r1",
    values: {
      title: { kind: "text", text: "Lobby screen refresh" },
      detail: { kind: "text", text: "Content team" },
      budget: { kind: "number", number: 1200 },
    },
  },
  {
    id: "r2",
    values: {
      title: { kind: "text", text: "Library kiosk" },
      detail: { kind: "text", text: "Facilities" },
      budget: { kind: "number", number: 850 },
    },
  },
] as const;

async function render(
  config: Partial<ListConfig>,
  documents?: Record<string, WidgetDataDocument>,
) {
  const test = mountForTest(widget, {
    config: { ...base, ...config },
    resources: fixtureResources({ documents }),
  });
  const element = test.element as ListElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  return { test, element, root, text };
}

afterEach(() => document.body.replaceChildren());

describe("List configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseListConfig({ ...base })).toEqual({ ok: true, config: base });
  });

  it("treats missing slots and colors as blank and themed", () => {
    expect(parseListConfig({ dataSourceId: SOURCE })).toMatchObject({
      ok: true,
      config: {
        primaryField: "",
        maximumItems: 8,
        density: "comfortable",
        showDividers: true,
        background: null,
        foreground: null,
      },
    });
  });

  it.each([
    [null],
    [[]],
    [{ dataSourceId: 42 }],
    [{ dataSourceId: SOURCE, maximumItems: 0 }],
    [{ dataSourceId: SOURCE, maximumItems: 101 }],
    [{ dataSourceId: SOURCE, maximumItems: 2.5 }],
    [{ dataSourceId: SOURCE, density: "airy" }],
    [{ dataSourceId: SOURCE, showDividers: "yes" }],
    [{ dataSourceId: SOURCE, primaryField: "x".repeat(121) }],
  ])("rejects %j", (value) => {
    expect(parseListConfig(value).ok).toBe(false);
  });
});

describe("List data resolution", () => {
  it("resolves mapped rows within the item bound", () => {
    const resolved = resolveListData(
      { ...base, maximumItems: 1 },
      fixtureResources({ documents: documentWith([...records]) }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { total: 2, rows: [{ id: "r1" }] },
    });
    if (resolved.state === "ready") expect(resolved.data.rows).toHaveLength(1);
  });

  it("reports an empty source, missing document and empty records as empty", () => {
    const resources = fixtureResources({
      documents: documentWith([...records]),
    });
    expect(
      resolveListData({ ...base, dataSourceId: "" }, resources),
    ).toMatchObject({ state: "empty" });
    expect(resolveListData(base, fixtureResources())).toMatchObject({
      state: "empty",
    });
    expect(
      resolveListData(base, fixtureResources({ documents: documentWith([]) })),
    ).toMatchObject({ state: "empty" });
  });

  it("reports a source without a records dataset as an error", () => {
    const documents: Record<string, WidgetDataDocument> = {
      [SOURCE]: {
        schemaVersion: 1,
        datasets: [
          {
            id: "total",
            kind: "scalar",
            scalar: { kind: "number", number: 2 },
          },
        ],
      },
    };
    expect(
      resolveListData(base, fixtureResources({ documents })),
    ).toMatchObject({ state: "error", code: "incompatible_source" });
  });
});

describe("List element", () => {
  it("renders mapped rows with typed values and reports ready", async () => {
    const { text, root, test } = await render({}, documentWith([...records]));
    expect(text(".heading")).toBe("Projects");
    const rows = [...root.querySelectorAll(".row")];
    expect(rows).toHaveLength(2);
    expect(text(".row .primary")).toBe("Lobby screen refresh");
    expect(text(".row .secondary")).toBe("Content team");
    expect(text(".row .trailing")).toBe("$1,200.00");
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("renders its empty message when the source has no records", async () => {
    const { text, test } = await render(
      { emptyText: "Nothing scheduled." },
      documentWith([]),
    );
    expect(text(".tc-empty-title")).toBe("Nothing scheduled.");
    expect(test.states).toEqual([{ state: "empty", reason: "no_records" }]);
    test.dispose();
  });
});

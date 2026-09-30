import { afterEach, describe, expect, it } from "vitest";
import { fixtureResources, mountForTest } from "@tilecast/widget-sdk/testing";
import type { WidgetDataDocument } from "@tilecast/widget-sdk";
import widget from "./index.ts";
import {
  parseTableConfig,
  resolveTableData,
  type TableColumn,
  type TableConfig,
} from "./table.ts";

type TableElement = HTMLElement & { updateComplete: Promise<unknown> };

const SOURCE = "11111111-1111-4111-8111-111111111111";

const columns: TableColumn[] = [
  { field: "title", label: "Project", align: "auto" },
  { field: "budget", label: "Budget", align: "auto" },
];

const base: TableConfig = {
  dataSourceId: SOURCE,
  columns,
  heading: "Budgets",
  maximumRows: 10,
  emptyText: "",
  showHeader: true,
  density: "comfortable",
  alternatingRows: false,
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
          cache: { usingCachedData: false, unavailable: false },
          fields: [
            { key: "title", label: "Title", type: "text" },
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
      budget: { kind: "number", number: 1200 },
    },
  },
  {
    id: "r2",
    values: {
      title: { kind: "text", text: "Library kiosk" },
      budget: { kind: "number", number: 850 },
    },
  },
] as const;

async function render(
  config: Partial<TableConfig>,
  documents?: Record<string, WidgetDataDocument>,
) {
  const test = mountForTest(widget, {
    config: { ...base, ...config },
    resources: fixtureResources({ documents }),
  });
  const element = test.element as TableElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  return { test, element, root, text };
}

afterEach(() => document.body.replaceChildren());

describe("Table configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseTableConfig({ ...base })).toEqual({ ok: true, config: base });
  });

  it("treats missing presentation as blank and themed", () => {
    expect(parseTableConfig({ dataSourceId: SOURCE })).toMatchObject({
      ok: true,
      config: {
        columns: [],
        maximumRows: 10,
        showHeader: false,
        density: "comfortable",
        alternatingRows: false,
        background: null,
        foreground: null,
      },
    });
  });

  it("maps a superseded alignment name onto the current one", () => {
    expect(
      parseTableConfig({
        dataSourceId: SOURCE,
        columns: [{ field: "title", alignment: "right" }],
      }),
    ).toMatchObject({
      ok: true,
      config: { columns: [{ field: "title", label: "", align: "right" }] },
    });
  });

  it("builds plain columns from a superseded field selection", () => {
    expect(
      parseTableConfig({
        dataSourceId: SOURCE,
        columns: [],
        legacyFields: ["title", "budget"],
      }),
    ).toMatchObject({
      ok: true,
      config: {
        columns: [
          { field: "title", label: "", align: "auto" },
          { field: "budget", label: "", align: "auto" },
        ],
      },
    });
  });

  it.each([
    [null],
    [[]],
    [{ dataSourceId: 42 }],
    [{ dataSourceId: SOURCE, columns: {} }],
    [{ dataSourceId: SOURCE, columns: [{ label: "No field" }] }],
    [{ dataSourceId: SOURCE, columns: [{ field: "ok", align: "diagonal" }] }],
    [{ dataSourceId: SOURCE, maximumRows: 0 }],
    [{ dataSourceId: SOURCE, maximumRows: 101 }],
    [{ dataSourceId: SOURCE, density: "airy" }],
    [{ dataSourceId: SOURCE, showHeader: "yes" }],
  ])("rejects %j", (value) => {
    expect(parseTableConfig(value).ok).toBe(false);
  });
});

describe("Table data resolution", () => {
  it("resolves rows within the row bound", () => {
    const resolved = resolveTableData(
      { ...base, maximumRows: 1 },
      fixtureResources({ documents: documentWith([...records]) }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { total: 2 },
    });
    if (resolved.state === "ready") expect(resolved.data.rows).toHaveLength(1);
  });

  it("reports missing sources and empty records as empty", () => {
    const resources = fixtureResources({
      documents: documentWith([...records]),
    });
    expect(
      resolveTableData({ ...base, dataSourceId: "" }, resources),
    ).toMatchObject({ state: "empty" });
    expect(resolveTableData(base, fixtureResources())).toMatchObject({
      state: "empty",
    });
    expect(
      resolveTableData(base, fixtureResources({ documents: documentWith([]) })),
    ).toMatchObject({ state: "empty" });
  });

  it("reports a column-less table as empty and other datasets as an error", () => {
    const resources = fixtureResources({
      documents: documentWith([...records]),
    });
    expect(resolveTableData({ ...base, columns: [] }, resources)).toMatchObject(
      { state: "empty" },
    );
    const scalar: Record<string, WidgetDataDocument> = {
      [SOURCE]: {
        schemaVersion: 1,
        datasets: [
          {
            id: "total",
            kind: "scalar",
            cache: { usingCachedData: false, unavailable: false },
            scalar: { kind: "number", number: 2 },
          },
        ],
      },
    };
    expect(
      resolveTableData(base, fixtureResources({ documents: scalar })),
    ).toMatchObject({ state: "error", code: "incompatible_source" });
  });
});

describe("Table element", () => {
  it("renders a headed grid with typed values and reports ready", async () => {
    const { text, root, test } = await render({}, documentWith([...records]));
    expect(text(".heading")).toBe("Budgets");
    const headers = [...root.querySelectorAll("thead th")].map((cell) =>
      cell.textContent?.trim(),
    );
    expect(headers).toEqual(["Project", "Budget"]);
    const cells = [...root.querySelectorAll("tbody td")].map((cell) =>
      cell.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(cells).toEqual([
      "Lobby screen refresh",
      "$1,200.00",
      "Library kiosk",
      "$850.00",
    ]);
    // Semantic alignment puts the currency column right.
    expect(root.querySelector("tbody td.numeric")?.textContent).toContain(
      "$1,200.00",
    );
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("hides the header when the author turns it off", async () => {
    const { root, test } = await render(
      { showHeader: false },
      documentWith([...records]),
    );
    expect(root.querySelector("thead")).toBeNull();
    expect(root.querySelectorAll("tbody tr")).toHaveLength(2);
    test.dispose();
  });

  it("renders its empty message when the source has no records", async () => {
    const { text, test } = await render(
      { emptyText: "Nothing to compare." },
      documentWith([]),
    );
    expect(text(".tc-empty-title")).toBe("Nothing to compare.");
    expect(test.states).toEqual([{ state: "empty", reason: "no_records" }]);
    test.dispose();
  });
});

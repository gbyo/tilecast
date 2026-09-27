import { afterEach, describe, expect, it } from "vitest";
import { fixtureResources, mountForTest } from "@tilecast/widget-sdk/testing";
import type { WidgetDataDocument } from "@tilecast/widget-sdk";
import widget from "./index.ts";
import {
  groupMenuSections,
  parseMenuBoardConfig,
  resolveMenuBoardData,
  type MenuBoardConfig,
} from "./menu-board.ts";

type MenuBoardElement = HTMLElement & { updateComplete: Promise<unknown> };

const SOURCE = "11111111-1111-4111-8111-111111111111";

const base: MenuBoardConfig = {
  dataSourceId: SOURCE,
  titleField: "dish",
  descriptionField: "notes",
  priceField: "cost",
  categoryField: "section",
  heading: "Lunch",
  maximumItems: 12,
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
            { key: "dish", label: "Dish", type: "text" },
            { key: "notes", label: "Notes", type: "text" },
            {
              key: "cost",
              label: "Cost",
              type: "currency",
              currency: "USD",
            },
            { key: "section", label: "Section", type: "text" },
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
      dish: { kind: "text", text: "Tomato soup" },
      notes: { kind: "text", text: "Basil and cream" },
      cost: { kind: "currency", number: 6.5 },
      section: { kind: "text", text: "Starters" },
    },
  },
  {
    id: "r2",
    values: {
      dish: { kind: "text", text: "Baked trout" },
      notes: { kind: "text", text: "Herb butter" },
      cost: { kind: "currency", number: 16.5 },
      section: { kind: "text", text: "Mains" },
    },
  },
  {
    id: "r3",
    values: {
      dish: { kind: "text", text: "Bread" },
      cost: { kind: "currency", number: 3 },
      section: { kind: "text", text: "" },
    },
  },
] as const;

async function render(
  config: Partial<MenuBoardConfig>,
  documents?: Record<string, WidgetDataDocument>,
) {
  const test = mountForTest(widget, {
    config: { ...base, ...config },
    resources: fixtureResources({ documents }),
  });
  const element = test.element as MenuBoardElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  return { test, element, root, text };
}

afterEach(() => document.body.replaceChildren());

describe("Menu Board configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseMenuBoardConfig({ ...base })).toEqual({
      ok: true,
      config: base,
    });
  });

  it("treats missing slots and colors as blank and themed", () => {
    expect(parseMenuBoardConfig({ dataSourceId: SOURCE })).toMatchObject({
      ok: true,
      config: {
        titleField: "",
        maximumItems: 12,
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
    [{ dataSourceId: SOURCE, titleField: "x".repeat(121) }],
  ])("rejects %j", (value) => {
    expect(parseMenuBoardConfig(value).ok).toBe(false);
  });
});

describe("Menu Board data resolution", () => {
  it("resolves mapped items within the item bound", () => {
    const resolved = resolveMenuBoardData(
      { ...base, maximumItems: 2 },
      fixtureResources({ documents: documentWith([...records]) }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { total: 3, items: [{ id: "r1" }, { id: "r2" }] },
    });
    if (resolved.state === "ready") expect(resolved.data.items).toHaveLength(2);
  });

  it("reports an empty source, missing document and empty records as empty", () => {
    const resources = fixtureResources({
      documents: documentWith([...records]),
    });
    expect(
      resolveMenuBoardData({ ...base, dataSourceId: "" }, resources),
    ).toMatchObject({ state: "empty" });
    expect(resolveMenuBoardData(base, fixtureResources())).toMatchObject({
      state: "empty",
    });
    expect(
      resolveMenuBoardData(
        base,
        fixtureResources({ documents: documentWith([]) }),
      ),
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
            scalar: { kind: "number", number: 3 },
          },
        ],
      },
    };
    expect(
      resolveMenuBoardData(base, fixtureResources({ documents })),
    ).toMatchObject({ state: "error", code: "incompatible_source" });
  });
});

describe("Menu Board sections", () => {
  it("groups by category in first-appearance order with uncategorized last", () => {
    const resolved = resolveMenuBoardData(
      base,
      fixtureResources({ documents: documentWith([...records]) }),
    );
    if (resolved.state !== "ready") throw new Error("expected ready");
    const sections = groupMenuSections(
      resolved.data.items,
      resolved.data.fields,
      "section",
      "en-US",
    );
    expect(sections.map((section) => section.category)).toEqual([
      "Starters",
      "Mains",
      "",
    ]);
    expect(sections[0]?.items.map((item) => item.id)).toEqual(["r1"]);
  });

  it("treats every item as uncategorized without a category field", () => {
    const resolved = resolveMenuBoardData(
      { ...base, categoryField: "" },
      fixtureResources({ documents: documentWith([...records]) }),
    );
    if (resolved.state !== "ready") throw new Error("expected ready");
    const sections = groupMenuSections(
      resolved.data.items,
      resolved.data.fields,
      "",
      "en-US",
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]?.category).toBe("");
    expect(sections[0]?.items).toHaveLength(3);
  });
});

describe("Menu Board element", () => {
  it("renders sections with typed prices and reports ready", async () => {
    const { text, root, test } = await render({}, documentWith([...records]));
    expect(text(".heading")).toBe("Lunch");
    const names = [...root.querySelectorAll(".section-name")].map((node) =>
      node.textContent?.trim(),
    );
    expect(names).toEqual(["Starters", "Mains"]);
    const items = [...root.querySelectorAll(".item")];
    expect(items).toHaveLength(3);
    expect(text(".item .title")).toBe("Tomato soup");
    expect(text(".item .description")).toBe("Basil and cream");
    expect(text(".item .price")).toBe("$6.50");
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("renders its empty message when the source has no records", async () => {
    const { text, test } = await render(
      { emptyText: "Kitchen closed." },
      documentWith([]),
    );
    expect(text(".tc-empty-title")).toBe("Kitchen closed.");
    expect(test.states).toEqual([{ state: "empty", reason: "no_records" }]);
    test.dispose();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { fixtureResources, mountForTest } from "@tilecast/widget-sdk/testing";
import type { WidgetDataDocument } from "@tilecast/widget-sdk";
import widget from "./index.ts";
import {
  parseTickerConfig,
  resolveTickerData,
  type TickerConfig,
} from "./ticker.ts";

type TickerElement = HTMLElement & { updateComplete: Promise<unknown> };

const SOURCE = "11111111-1111-4111-8111-111111111111";

const base: TickerConfig = {
  dataSourceId: SOURCE,
  primaryField: "title",
  secondaryField: "source",
  legacyFields: [],
  legacyContentMode: "",
  leadingLabel: "News",
  separator: " • ",
  fieldSeparator: " — ",
  maxItems: 15,
  direction: "left",
  speed: "normal",
  emptyText: "",
  background: null,
  foreground: null,
};

const feedFields = [
  { key: "title", label: "Title", type: "text", role: "headline" },
  { key: "source", label: "Source", type: "text", role: "source_name" },
];

function documentWith(
  records: WidgetDataDocument["datasets"][number]["records"],
  fields = feedFields,
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
    id: "s1",
    values: {
      title: { kind: "text", text: "Library extends weekend hours" },
      source: { kind: "text", text: "City Wire" },
    },
  },
  {
    id: "s2",
    values: {
      title: { kind: "text", text: "School board approves calendar" },
      source: { kind: "text", text: "" },
    },
  },
] as const;

async function render(
  config: Partial<TickerConfig>,
  documents?: Record<string, WidgetDataDocument>,
) {
  const test = mountForTest(widget, {
    config: { ...base, ...config },
    resources: fixtureResources({ documents }),
  });
  const element = test.element as TickerElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  return { test, element, root, text };
}

afterEach(() => document.body.replaceChildren());

describe("Ticker configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseTickerConfig({ ...base })).toEqual({ ok: true, config: base });
  });

  it("treats missing text and colors as blank and themed", () => {
    expect(parseTickerConfig({ dataSourceId: SOURCE })).toMatchObject({
      ok: true,
      config: {
        primaryField: "",
        secondaryField: "",
        legacyFields: [],
        legacyContentMode: "",
        leadingLabel: "",
        separator: " • ",
        fieldSeparator: " — ",
        maxItems: 15,
        direction: "left",
        speed: "normal",
        background: null,
        foreground: null,
      },
    });
  });

  it.each([
    [null],
    [[]],
    [{ dataSourceId: 42 }],
    [{ dataSourceId: SOURCE, maxItems: 0 }],
    [{ dataSourceId: SOURCE, maxItems: 51 }],
    [{ dataSourceId: SOURCE, direction: "up" }],
    [{ dataSourceId: SOURCE, speed: "ludicrous" }],
    [{ dataSourceId: SOURCE, separator: 42 }],
    [{ dataSourceId: SOURCE, legacyFields: "title" }],
    [{ dataSourceId: SOURCE, legacyFields: [42] }],
  ])("rejects %j", (value) => {
    expect(parseTickerConfig(value).ok).toBe(false);
  });
});

describe("Ticker data resolution", () => {
  it("resolves items within the item bound", () => {
    const resolved = resolveTickerData(
      { ...base, maxItems: 1 },
      fixtureResources({ documents: documentWith([...records]) }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: {
        total: 2,
        primaryKey: "title",
        secondaryKey: "source",
        items: [{ id: "s1" }],
      },
    });
    if (resolved.state === "ready")
      expect(resolved.data.items).toHaveLength(1);
  });

  it("resolves persisted ordered field lists through legacy fields", () => {
    const resolved = resolveTickerData(
      { ...base, primaryField: "", secondaryField: "", legacyFields: ["title", "source"] },
      fixtureResources({ documents: documentWith([...records]) }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { primaryKey: "title", secondaryKey: "source" },
    });
  });

  it("scrolls source and time secondaries for persisted content modes", () => {
    for (const [mode, key] of [
      ["title_source", "source"],
      ["title_time", "date"],
      ["title", ""],
    ] as const) {
      const resolved = resolveTickerData(
        {
          ...base,
          primaryField: "title",
          secondaryField: "",
          legacyContentMode: mode,
        },
        fixtureResources({ documents: documentWith([...records]) }),
      );
      expect(resolved).toMatchObject({
        state: "ready",
        data: { primaryKey: "title", secondaryKey: key },
      });
    }
  });

  it("reports a ticker with no primary text as an error", () => {
    expect(
      resolveTickerData(
        { ...base, primaryField: "", legacyFields: [] },
        fixtureResources({ documents: documentWith([...records]) }),
      ),
    ).toMatchObject({ state: "error", code: "incompatible_source" });
  });

  it("reports an empty source, missing document and empty records as empty", () => {
    const resources = fixtureResources({
      documents: documentWith([...records]),
    });
    expect(
      resolveTickerData({ ...base, dataSourceId: "" }, resources),
    ).toMatchObject({ state: "empty" });
    expect(resolveTickerData(base, fixtureResources())).toMatchObject({
      state: "empty",
    });
    expect(
      resolveTickerData(
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
            scalar: { kind: "number", number: 2 },
          },
        ],
      },
    };
    expect(
      resolveTickerData(base, fixtureResources({ documents })),
    ).toMatchObject({ state: "error", code: "incompatible_source" });
  });
});

describe("Ticker element", () => {
  it("scrolls each item twice with separators and reports ready", async () => {
    const { text, root, test } = await render({}, documentWith([...records]));
    expect(text(".label")).toBe("News");
    // Each of the two items renders twice for the seamless loop.
    expect(root.querySelectorAll(".item")).toHaveLength(4);
    expect(text(".track")).toContain("Library extends weekend hours");
    expect(text(".track")).toContain("City Wire");
    expect(
      root.querySelector(".ticker")?.getAttribute("data-direction"),
    ).toBe("left");
    expect(
      root
        .querySelector(".ticker")
        ?.getAttribute("style"),
    ).toContain("--tc-ticker-seconds:40s");
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("reverses and quickens on configuration", async () => {
    const { root, test } = await render(
      { direction: "right", speed: "fast", leadingLabel: "" },
      documentWith([...records]),
    );
    expect(root.querySelector(".ticker")?.getAttribute("data-direction")).toBe(
      "right",
    );
    expect(root.querySelector(".ticker")?.getAttribute("style")).toContain(
      "--tc-ticker-seconds:25s",
    );
    expect(root.querySelector(".label")).toBeNull();
    test.dispose();
  });

  it("renders its empty message when the source has no items", async () => {
    const { text, test } = await render(
      { emptyText: "Nothing to scroll." },
      documentWith([]),
    );
    expect(text(".tc-empty-title")).toBe("Nothing to scroll.");
    expect(test.states).toEqual([{ state: "empty", reason: "no_records" }]);
    test.dispose();
  });
});

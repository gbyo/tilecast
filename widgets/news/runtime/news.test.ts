import { afterEach, describe, expect, it } from "vitest";
import { fixtureResources, mountForTest } from "@tilecast/widget-sdk/testing";
import type { WidgetDataDocument } from "@tilecast/widget-sdk";
import widget from "./index.ts";
import {
  parseNewsConfig,
  resolveNewsData,
  slotFieldKey,
  type NewsConfig,
} from "./news.ts";

type NewsElement = HTMLElement & { updateComplete: Promise<unknown> };

const SOURCE = "11111111-1111-4111-8111-111111111111";

const base: NewsConfig = {
  dataSourceId: SOURCE,
  heading: "Latest news",
  maxStories: 8,
  showSummary: true,
  showTime: true,
  showSource: true,
  emptyText: "",
  displayStyle: "headlines",
  background: null,
  foreground: null,
};

const feedFields = [
  { key: "title", label: "Title", type: "text", role: "headline" },
  { key: "description", label: "Description", type: "text", role: "summary" },
  { key: "date", label: "Date", type: "datetime", role: "published_at" },
  { key: "source", label: "Source", type: "text", role: "source_name" },
  { key: "author", label: "Author", type: "text", role: "author" },
];

function documentWith(
  records: WidgetDataDocument["datasets"][number]["records"],
  fields: {
    key: string;
    label: string;
    type: string;
    role?: string;
  }[] = feedFields,
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
      description: { kind: "text", text: "The main branch opens Sundays." },
      date: { kind: "datetime", datetime: "2026-09-27T14:00:00Z" },
      source: { kind: "text", text: "City Wire" },
      author: { kind: "text", text: "R. Alvarez" },
    },
  },
  {
    id: "s2",
    values: {
      title: { kind: "text", text: "School board approves calendar" },
      description: { kind: "text", text: "" },
      date: { kind: "datetime", datetime: "2026-09-26T09:30:00Z" },
      source: { kind: "text", text: "Schools Desk" },
      author: { kind: "text", text: "" },
    },
  },
] as const;

async function render(
  config: Partial<NewsConfig>,
  documents?: Record<string, WidgetDataDocument>,
) {
  const test = mountForTest(widget, {
    config: { ...base, ...config },
    resources: fixtureResources({ documents }),
  });
  const element = test.element as NewsElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  return { test, element, root, text };
}

afterEach(() => document.body.replaceChildren());

describe("News configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseNewsConfig({ ...base })).toEqual({ ok: true, config: base });
  });

  it("renders the legacy featured style as the lead story", () => {
    expect(parseNewsConfig({ displayStyle: "featured" })).toMatchObject({
      ok: true,
      config: { displayStyle: "lead" },
    });
  });

  it("treats a missing configuration as sensible defaults", () => {
    expect(parseNewsConfig({ dataSourceId: SOURCE })).toMatchObject({
      ok: true,
      config: {
        heading: "",
        maxStories: 8,
        showSummary: true,
        showTime: true,
        showSource: true,
        displayStyle: "headlines",
        background: null,
        foreground: null,
      },
    });
  });

  it.each([
    [null],
    [[]],
    [{ dataSourceId: 42 }],
    [{ dataSourceId: SOURCE, maxStories: 0 }],
    [{ dataSourceId: SOURCE, maxStories: 21 }],
    [{ dataSourceId: SOURCE, maxStories: 2.5 }],
    [{ dataSourceId: SOURCE, displayStyle: "ticker" }],
    [{ dataSourceId: SOURCE, showSummary: "yes" }],
  ])("rejects %j", (value) => {
    expect(parseNewsConfig(value).ok).toBe(false);
  });
});

describe("News slot resolution", () => {
  it("prefers declared roles over feed field names", () => {
    const fields = Object.fromEntries(
      [
        { key: "headline", label: "Headline", type: "text", role: "headline" },
        { key: "title", label: "Title", type: "text" },
      ].map((field) => [field.key, field]),
    );
    expect(slotFieldKey(fields, { roles: ["headline"], keys: ["title"] })).toBe(
      "headline",
    );
  });

  it("falls back to long-standing feed field names", () => {
    const fields = Object.fromEntries(
      [
        { key: "title", label: "Title", type: "text" },
        { key: "description", label: "Description", type: "text" },
      ].map((field) => [field.key, field]),
    );
    expect(slotFieldKey(fields, { roles: ["headline"], keys: ["title"] })).toBe(
      "title",
    );
    expect(slotFieldKey(fields, { roles: ["nope"], keys: ["missing"] })).toBe(
      "",
    );
  });
});

describe("News data resolution", () => {
  it("resolves nonstandard field keys by the projected semantic roles", () => {
    const documents = documentWith(
      [
        {
          id: "story-1",
          values: {
            story_heading: { kind: "text", text: "Library opens Sundays" },
            publication_time: {
              kind: "datetime",
              datetime: "2026-09-27T14:00:00Z",
            },
            outlet: { kind: "text", text: "City Wire" },
          },
        },
      ],
      [
        {
          key: "story_heading",
          label: "Title",
          type: "text",
          role: "headline",
        },
        {
          key: "publication_time",
          label: "Date",
          type: "datetime",
          role: "published_at",
        },
        { key: "outlet", label: "Source", type: "text", role: "source_name" },
      ],
    );
    const resolved = resolveNewsData(base, fixtureResources({ documents }));
    expect(resolved).toMatchObject({
      state: "ready",
      data: {
        keys: {
          headline: "story_heading",
          published: "publication_time",
          sourceName: "outlet",
        },
        stories: [
          {
            id: "story-1",
            values: {
              story_heading: { kind: "text", text: "Library opens Sundays" },
            },
          },
        ],
      },
    });
  });

  it("resolves stories within the story bound", () => {
    const resolved = resolveNewsData(
      { ...base, maxStories: 1 },
      fixtureResources({ documents: documentWith([...records]) }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { total: 2, stories: [{ id: "s1" }] },
    });
    if (resolved.state === "ready")
      expect(resolved.data.stories).toHaveLength(1);
  });

  it("reports a source with no headline-like field as an error", () => {
    const documents = documentWith(
      [...records],
      [{ key: "date", label: "Date", type: "datetime" }],
    );
    expect(
      resolveNewsData(base, fixtureResources({ documents })),
    ).toMatchObject({ state: "error", code: "incompatible_source" });
  });

  it("reports an empty source, missing document and empty records as empty", () => {
    const resources = fixtureResources({
      documents: documentWith([...records]),
    });
    expect(
      resolveNewsData({ ...base, dataSourceId: "" }, resources),
    ).toMatchObject({ state: "empty" });
    expect(resolveNewsData(base, fixtureResources())).toMatchObject({
      state: "empty",
    });
    expect(
      resolveNewsData(base, fixtureResources({ documents: documentWith([]) })),
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
      resolveNewsData(base, fixtureResources({ documents })),
    ).toMatchObject({ state: "error", code: "incompatible_source" });
  });
});

describe("News element", () => {
  it("renders headlines with summaries and meta, and reports ready", async () => {
    const { text, root, test } = await render({}, documentWith([...records]));
    expect(text(".heading")).toBe("Latest news");
    const stories = [...root.querySelectorAll(".story")];
    expect(stories).toHaveLength(2);
    expect(text(".story .headline")).toBe("Library extends weekend hours");
    expect(text(".story .summary")).toBe("The main branch opens Sundays.");
    expect(text(".story .meta")).toContain("City Wire");
    expect(text(".story .meta")).toContain("R. Alvarez");
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("hides summaries, times and sources when toggled off", async () => {
    const { root, test } = await render(
      { showSummary: false, showTime: false, showSource: false },
      documentWith([...records]),
    );
    expect(root.querySelector(".summary")).toBeNull();
    expect(root.querySelector(".meta")).toBeNull();
    test.dispose();
  });

  it("leads with the first story in the lead style", async () => {
    const { root, test } = await render(
      { displayStyle: "lead" },
      documentWith([...records]),
    );
    expect(root.querySelector(".news")?.getAttribute("data-style")).toBe(
      "lead",
    );
    expect(root.querySelectorAll(".lead-story")).toHaveLength(1);
    expect(root.querySelectorAll(".supporting .story")).toHaveLength(1);
    test.dispose();
  });

  it("renders its empty message when the source has no stories", async () => {
    const { text, test } = await render(
      { emptyText: "No stories right now." },
      documentWith([]),
    );
    expect(text(".tc-empty-title")).toBe("No stories right now.");
    expect(test.states).toEqual([{ state: "empty", reason: "no_records" }]);
    test.dispose();
  });
});

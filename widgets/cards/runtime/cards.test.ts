import { afterEach, describe, expect, it } from "vitest";
import { fixtureResources, mountForTest } from "@tilecast/widget-sdk/testing";
import type { WidgetDataDocument } from "@tilecast/widget-sdk";
import widget from "./index.ts";
import {
  parseCardsConfig,
  resolveCardsData,
  type CardsConfig,
} from "./cards.ts";

type CardsElement = HTMLElement & { updateComplete: Promise<unknown> };

const SOURCE = "11111111-1111-4111-8111-111111111111";

const base: CardsConfig = {
  dataSourceId: SOURCE,
  titleField: "title",
  subtitleField: "owner",
  bodyField: "detail",
  imageField: "cover",
  badgeField: "status",
  metadataField: "due",
  heading: "Projects",
  maximumItems: 6,
  emptyText: "",
  density: "comfortable",
  background: null,
  foreground: null,
};

const fields = [
  { key: "title", label: "Title", type: "text" },
  { key: "owner", label: "Owner", type: "text" },
  { key: "detail", label: "Detail", type: "text" },
  { key: "cover", label: "Cover", type: "asset" },
  { key: "status", label: "Status", type: "text" },
  { key: "due", label: "Due", type: "date" },
];

const records = [
  {
    id: "r1",
    values: {
      title: { kind: "text", text: "Lobby screen refresh" },
      owner: { kind: "text", text: "Content team" },
      detail: { kind: "text", text: "Replace the entrance display." },
      cover: { kind: "asset", assetId: "cover-a" },
      status: { kind: "text", text: "In progress" },
      due: { kind: "date", date: "2026-10-01" },
    },
  },
  {
    id: "r2",
    values: {
      title: { kind: "text", text: "Library kiosk" },
      owner: { kind: "text", text: "Facilities" },
    },
  },
] as const;

function documents(): Record<string, WidgetDataDocument> {
  return {
    [SOURCE]: {
      schemaVersion: 1,
      datasets: [
        { id: "records", kind: "records", fields, records: [...records] },
      ],
    },
  };
}

const media = { "cover-a/variant-a": "data:image/svg+xml,%3Csvg/%3E" };

async function render(
  config: Partial<CardsConfig>,
  input?: {
    documents?: Record<string, WidgetDataDocument>;
    media?: Record<string, string>;
  },
) {
  const test = mountForTest(widget, {
    config: { ...base, ...config },
    resources: fixtureResources(input),
  });
  const element = test.element as CardsElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  return { test, element, root, text };
}

afterEach(() => document.body.replaceChildren());

describe("Cards configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseCardsConfig({ ...base })).toEqual({ ok: true, config: base });
  });

  it("treats missing slots and colors as blank and themed", () => {
    expect(parseCardsConfig({ dataSourceId: SOURCE })).toMatchObject({
      ok: true,
      config: {
        titleField: "",
        maximumItems: 6,
        density: "comfortable",
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
    [{ dataSourceId: SOURCE, density: "airy" }],
    [{ dataSourceId: SOURCE, titleField: "x".repeat(121) }],
  ])("rejects %j", (value) => {
    expect(parseCardsConfig(value).ok).toBe(false);
  });
});

describe("Cards data resolution", () => {
  it("resolves cards within the item bound and resolves granted images", () => {
    const resolved = resolveCardsData(
      { ...base, maximumItems: 1 },
      fixtureResources({ documents: documents(), media }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { total: 2 },
    });
    if (resolved.state !== "ready") throw new Error("expected ready");
    expect(resolved.data.cards).toHaveLength(1);
    expect(resolved.data.cards[0]?.imageUri).toBe(
      "data:image/svg+xml,%3Csvg/%3E",
    );
  });

  it("reports missing sources and empty records as empty", () => {
    const resources = fixtureResources({ documents: documents(), media });
    expect(
      resolveCardsData({ ...base, dataSourceId: "" }, resources),
    ).toMatchObject({ state: "empty" });
    expect(resolveCardsData(base, fixtureResources())).toMatchObject({
      state: "empty",
    });
    expect(
      resolveCardsData(
        base,
        fixtureResources({
          documents: {
            [SOURCE]: {
              schemaVersion: 1,
              datasets: [
                { id: "records", kind: "records", fields, records: [] },
              ],
            },
          },
        }),
      ),
    ).toMatchObject({ state: "empty" });
  });

  it("reports a source without a records dataset as an error", () => {
    const docs: Record<string, WidgetDataDocument> = {
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
      resolveCardsData(base, fixtureResources({ documents: docs })),
    ).toMatchObject({ state: "error", code: "incompatible_source" });
  });
});

describe("Cards element", () => {
  it("renders mapped slots and only granted images, then reports ready", async () => {
    const { text, root, test } = await render(
      {},
      { documents: documents(), media },
    );
    expect(text(".heading")).toBe("Projects");
    const cards = [...root.querySelectorAll("article.card")];
    expect(cards).toHaveLength(2);
    expect(text(".card .title")).toBe("Lobby screen refresh");
    expect(text(".card .subtitle")).toBe("Content team");
    expect(text(".card .badge")).toBe("In progress");
    expect(text(".card .metadata")).toBe("Oct 1, 2026");
    // The granted cover renders; cards without one render no image.
    expect(root.querySelectorAll("img.photo")).toHaveLength(1);
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("renders its empty message when the source has no records", async () => {
    const { text, test } = await render(
      { emptyText: "Nothing to feature." },
      {
        documents: {
          [SOURCE]: {
            schemaVersion: 1,
            datasets: [{ id: "records", kind: "records", fields, records: [] }],
          },
        },
      },
    );
    expect(text(".tc-empty-title")).toBe("Nothing to feature.");
    expect(test.states).toEqual([{ state: "empty", reason: "no_records" }]);
    test.dispose();
  });
});

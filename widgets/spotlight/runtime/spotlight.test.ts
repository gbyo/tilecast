import { afterEach, describe, expect, it } from "vitest";
import {
  createWidgetResources,
  type WidgetDataDocument,
  type WidgetResources,
} from "@tilecast/widget-sdk";
import { fixtureResources, mountForTest } from "@tilecast/widget-sdk/testing";
import widget from "./index.ts";
import {
  parseSpotlightConfig,
  resolveSpotlightData,
  type SpotlightConfig,
} from "./spotlight.ts";

type SpotlightElement = HTMLElement & { updateComplete: Promise<unknown> };

const SOURCE = "11111111-1111-4111-8111-111111111111";
const asset = "22222222-2222-4222-8222-222222222222";
const variant = "33333333-3333-4333-8333-333333333333";
const uri = `tcmedia://variant/${asset}/${variant}`;

const base: SpotlightConfig = {
  dataSourceId: SOURCE,
  titleField: "title",
  subtitleField: "subtitle",
  bodyField: "body",
  badgeField: "status",
  metadataField: "date",
  assetId: "",
  variantId: "",
  emptyText: "",
  background: null,
  foreground: null,
};

const fields = [
  { key: "title", label: "Title", type: "text" },
  { key: "subtitle", label: "Subtitle", type: "text" },
  { key: "body", label: "Body", type: "text" },
  { key: "status", label: "Status", type: "text" },
  { key: "date", label: "Date", type: "date" },
];

const values = {
  title: { kind: "text", text: "Spring concert" },
  subtitle: { kind: "text", text: "City Symphonic Band" },
  body: {
    kind: "text",
    text: "An evening of overtures on the library lawn at half past six.",
  },
  status: { kind: "text", text: "Tickets open" },
  date: { kind: "text", text: "2026-09-28" },
};

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

function granted(documents?: Record<string, WidgetDataDocument>): {
  resources: WidgetResources;
} {
  return {
    resources: createWidgetResources(
      {
        documents: new Map(Object.entries(documents ?? {})),
        media: new Map([[`${asset}/${variant}`, uri]]),
      },
      {
        dataSources: documents ? [SOURCE] : [],
        media: [{ assetId: asset, variantId: variant }],
      },
    ),
  };
}

async function render(
  config: Partial<SpotlightConfig>,
  documents?: Record<string, WidgetDataDocument>,
  media?: Record<string, string>,
) {
  const test = mountForTest(widget, {
    config: { ...base, ...config },
    resources: fixtureResources({ documents, media }),
  });
  const element = test.element as SpotlightElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  return { test, element, root, text };
}

afterEach(() => document.body.replaceChildren());

describe("Spotlight configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseSpotlightConfig({ ...base })).toEqual({
      ok: true,
      config: base,
    });
  });

  it("treats missing presentation as blank and themed", () => {
    expect(
      parseSpotlightConfig({ dataSourceId: SOURCE, titleField: "title" }),
    ).toMatchObject({
      ok: true,
      config: {
        subtitleField: "",
        assetId: "",
        variantId: "",
        background: null,
        foreground: null,
      },
    });
  });

  it("parses the compiled image variant", () => {
    expect(
      parseSpotlightConfig({
        ...base,
        image: { assetId: asset, variantId: variant },
      }),
    ).toMatchObject({
      ok: true,
      config: { assetId: asset, variantId: variant },
    });
  });

  it.each([
    [null],
    [{ dataSourceId: 42 }],
    [{ dataSourceId: SOURCE, titleField: 42 }],
    [{ image: { assetId: "../../etc/passwd", variantId: "" } }],
    [{ image: { assetId: asset, variantId: "https://example.com/x.png" } }],
  ])("rejects %j", (value) => {
    expect(parseSpotlightConfig(value).ok).toBe(false);
  });
});

describe("Spotlight data resolution", () => {
  it("shows the first record without sorting or aggregating", () => {
    const resolved = resolveSpotlightData(
      base,
      fixtureResources({
        documents: recordsDocument([
          { id: "r1", values },
          {
            id: "r2",
            values: { ...values, title: { kind: "text", text: "Other" } },
          },
        ]),
      }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { src: null, values },
    });
  });

  it("skips a leading record without a title for the first usable one", () => {
    const resolved = resolveSpotlightData(
      base,
      fixtureResources({
        documents: recordsDocument([
          {
            id: "r1",
            values: { ...values, title: { kind: "text", text: "  " } },
          },
          { id: "r2", values },
        ]),
      }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { values },
    });
  });

  it("reads artwork only through the media grant", () => {
    const config = { ...base, assetId: asset, variantId: variant };
    const documents = recordsDocument([{ id: "r1", values }]);
    expect(
      resolveSpotlightData(config, granted(documents).resources),
    ).toMatchObject({ state: "ready", data: { src: uri } });
    expect(
      resolveSpotlightData(config, fixtureResources({ documents })),
    ).toMatchObject({ state: "empty", reason: "image_unavailable" });
  });

  it.each([
    ["no source", { ...base, dataSourceId: "" }, "no_source"],
    ["no records", base, "no_records"],
  ])("%s empties", (_label, config, reason) => {
    const documents = _label === "no records" ? recordsDocument([]) : undefined;
    expect(
      resolveSpotlightData(config, fixtureResources({ documents })),
    ).toMatchObject({ state: "empty", reason });
  });

  it("fails a source with no records dataset", () => {
    expect(
      resolveSpotlightData(
        base,
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

describe("Spotlight rendering", () => {
  it("shows every slot with badge and metadata", async () => {
    const { text } = await render({}, recordsDocument([{ id: "r1", values }]));
    expect(text(".spotlight-title")).toBe("Spring concert");
    expect(text(".spotlight-subtitle")).toBe("City Symphonic Band");
    expect(text(".spotlight-body")).toContain("library lawn");
    expect(text(".spotlight-badge-row")).toContain("Tickets open");
    expect(text(".spotlight-meta")).toBe("2026-09-28");
  });

  it("renders managed artwork with an empty alt", async () => {
    const { root } = await render(
      { image: { assetId: asset, variantId: variant } } as never,
      recordsDocument([{ id: "r1", values }]),
      { [`${asset}/${variant}`]: uri },
    );
    const image = root.querySelector("img.spotlight-art")!;
    expect(image.getAttribute("src")).toBe(uri);
    expect(image.getAttribute("alt")).toBe("");
  });

  it("omits missing optional slots", async () => {
    const { root, text } = await render(
      { subtitleField: "", bodyField: "", badgeField: "", metadataField: "" },
      recordsDocument([{ id: "r1", values }]),
    );
    expect(text(".spotlight-title")).toBe("Spring concert");
    expect(root.querySelector(".spotlight-subtitle")).toBeNull();
    expect(root.querySelector(".spotlight-body")).toBeNull();
    expect(root.querySelector(".tc-badge")).toBeNull();
  });

  it("shows the empty message when configured", async () => {
    const { text } = await render(
      { emptyText: "Nothing featured" },
      recordsDocument([]),
    );
    expect(text(".tc-empty-title")).toBe("Nothing featured");
  });
});

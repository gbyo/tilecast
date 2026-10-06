import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { WidgetDefinition } from "@/api/types";
import { widgetAuthoring } from "./widgetAuthoring";
import {
  initialDraft,
  sameDraft,
  stableSerialize,
  widgetSaveInput,
  withFieldDefaults,
} from "./widgetEditorModel";
import { validateWidgetDraft } from "./widgetEditorValidation";
import { definitionFrom, repositoryCatalog, savedWidget } from "./testing";

// Validation messages are looked up by key; the key is what these assert.
const t = ((key: string, options?: Record<string, unknown>) =>
  options && "count" in options
    ? `${key}:${String(options.count)}`
    : options && "value" in options
      ? `${key}:${String(options.value)}`
      : key) as unknown as TFunction<["content", "common"]>;

const catalog = repositoryCatalog();

function authoringFor(definition: WidgetDefinition) {
  const authoring = widgetAuthoring(definition, catalog);
  if (authoring.kind === "unsupported") throw new Error("unsupported");
  return authoring;
}

describe("Widget drafts", () => {
  it("start a new Widget from the definition defaults and a draft name", () => {
    const definition = definitionFrom(catalog, "countdown");
    const draft = initialDraft(
      definition,
      authoringFor(definition),
      undefined,
      "New Countdown",
    );
    expect(draft.name).toBe("New Countdown");
    expect(draft.description).toBe("");
    expect(draft.configuration).toMatchObject(definition.defaultConfiguration);
  });

  it("fill a missing value from the field's default, as the Server does", () => {
    expect(
      withFieldDefaults(
        [
          { key: "a", label: "A", control: "text", default: "x" },
          { key: "b", label: "B", control: "integer" },
        ],
        {},
      ),
    ).toEqual({ a: "x" });
  });

  it("open a saved web integration with only the keys its schema declares", () => {
    const definition = definitionFrom(catalog, "website");
    const draft = initialDraft(
      definition,
      authoringFor(definition),
      savedWidget("website", {
        url: "https://example.com/",
        displayUrl: "https://example.com/",
        allowedHosts: ["example.com"],
        createdAt: "2026-01-01T00:00:00Z",
        fallbackImageAssetId: null,
      }),
      "New Website",
    );
    expect(draft.configuration).not.toHaveProperty("displayUrl");
    expect(draft.configuration).not.toHaveProperty("createdAt");
    expect(draft.configuration).not.toHaveProperty("fallbackImageAssetId");
    expect(draft.configuration).toMatchObject({
      url: "https://example.com/",
      allowedHosts: ["example.com"],
      reloadPolicy: "on_each_activation",
    });
  });

  it("open a saved legacy chart with its old chart type as the style", () => {
    const definition = definitionFrom(catalog, "chart");
    const draft = initialDraft(
      definition,
      authoringFor(definition),
      savedWidget("chart", { chartType: "donut" }),
      "New Chart",
    );
    expect(draft.configuration["style"]).toBe("bar");
  });

  it("compare by value, so key order and undefined members do not count", () => {
    expect(
      sameDraft(
        { name: "A", description: "", configuration: { a: 1, b: 2 } },
        {
          name: "A",
          description: "",
          configuration: { b: 2, a: 1, c: undefined },
        },
      ),
    ).toBe(true);
    expect(
      sameDraft(
        { name: "A", description: "", configuration: { a: [1, 2] } },
        { name: "A", description: "", configuration: { a: [2, 1] } },
      ),
    ).toBe(false);
    expect(stableSerialize({ b: { d: 1, c: 2 }, a: 0 })).toBe(
      '{"a":0,"b":{"c":2,"d":1}}',
    );
  });

  it("save trimmed details and drop cleared values", () => {
    const definition = definitionFrom(catalog, "text");
    expect(
      widgetSaveInput(definition, {
        name: "  Notice ",
        description: " Lobby ",
        configuration: { body: "Hi", heading: undefined },
      }),
    ).toEqual({
      provider: "text",
      name: "Notice",
      description: "Lobby",
      configuration: { body: "Hi" },
    });
  });
});

describe("Widget draft validation", () => {
  const definition = definitionFrom(catalog, "text");
  const draft = (configuration: Record<string, unknown>, name = "Notice") => ({
    name,
    description: "",
    configuration,
  });

  it("accepts the definition's own defaults", () => {
    const valid = validateWidgetDraft(
      definition,
      draft({ ...definition.defaultConfiguration }),
      t,
    );
    expect(valid.valid).toBe(true);
  });

  it("requires a name and the definition's required values", () => {
    const result = validateWidgetDraft(definition, draft({ body: "" }, " "), t);
    expect(result.valid).toBe(false);
    expect(result.name).toBe("widgets.editor.validation.nameRequired");
    expect(result.byPath.get("body")).toBe(
      "widgets.editor.validation.required",
    );
    expect(result.issues[0]).toMatchObject({
      path: "body",
      section: "content",
    });
  });

  it("checks bounds, formats, and list limits", () => {
    const fields = [
      {
        key: "n",
        label: "N",
        control: "integer" as const,
        minimum: 1,
        maximum: 5,
      },
      { key: "u", label: "U", control: "url" as const },
      { key: "c", label: "C", control: "color" as const },
      {
        key: "hosts",
        label: "Hosts",
        control: "string_list" as const,
        maximumItems: 1,
      },
    ];
    const custom = {
      ...definition,
      configurationSchema: { fields },
    };
    const result = validateWidgetDraft(
      custom,
      draft({ n: 9, u: "ftp://example.com", c: "blue", hosts: ["a", "b"] }),
      t,
    );
    expect(Object.fromEntries(result.byPath)).toEqual({
      n: "widgets.editor.validation.maximum:5",
      u: "widgets.editor.validation.url",
      c: "widgets.editor.validation.color",
      hosts: "widgets.editor.validation.tooMany:1",
    });
  });

  it("ignores fields the author cannot see", () => {
    const countdown = definitionFrom(catalog, "countdown");
    const configuration = {
      ...countdown.defaultConfiguration,
      mode: "count_up",
      completionText: "x".repeat(5000),
    };
    expect(validateWidgetDraft(countdown, draft(configuration), t).valid).toBe(
      true,
    );
  });

  it("validates nested repeating-group items by path", () => {
    const fields = [
      {
        key: "items",
        label: "Items",
        control: "repeating_group" as const,
        maximumItems: 4,
        itemFields: [
          {
            key: "label",
            label: "Label",
            control: "text" as const,
            required: true,
          },
        ],
      },
    ];
    const result = validateWidgetDraft(
      { ...definition, configurationSchema: { fields } },
      draft({ items: [{ label: "A" }, { label: "" }] }),
      t,
    );
    expect([...result.byPath.keys()]).toEqual(["items.1.label"]);
  });
});

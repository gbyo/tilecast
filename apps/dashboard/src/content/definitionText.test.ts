import { afterEach, describe, expect, it } from "vitest";
import type { ContentDefinitionField } from "@/api/types";
import { i18n } from "@/i18n";
import { definitionText, localizeDefinitionField } from "./definitionText";
import { repositoryCatalog } from "@/components/content/widget-editor/testing";

afterEach(() => i18n.changeLanguage("en"));

const field: ContentDefinitionField = {
  key: "url",
  label: "Web address",
  labelKey: "definitions:website.fields.url.label",
  description: "The public page to show.",
  descriptionKey: "definitions:website.fields.url.description",
  control: "url",
};

describe("definitionText", () => {
  it("uses the literal when the definition names no key", () => {
    expect(definitionText("Ticker speed")).toBe("Ticker speed");
    expect(definitionText("Ticker speed", undefined)).toBe("Ticker speed");
  });

  it("resolves a definitions key in the active language", async () => {
    const key = "definitions:website.fields.scrollX.label";
    expect(definitionText("Horizontal scroll (px)", key)).toBe(
      "Horizontal scroll (px)",
    );
    await i18n.changeLanguage("es");
    expect(definitionText("Horizontal scroll (px)", key)).toBe(
      "Desplazamiento horizontal (px)",
    );
    await i18n.changeLanguage("ru");
    expect(definitionText("Horizontal scroll (px)", key)).toBe(
      "Горизонтальная прокрутка (px)",
    );
  });

  it("falls back to the literal when the key is unknown", async () => {
    await i18n.changeLanguage("ru");
    expect(
      definitionText("Plugin label", "definitions:plugin.fields.nope.label"),
    ).toBe("Plugin label");
  });

  it("does not read other namespaces, even for a key that exists", () => {
    expect(definitionText("Plugin label", "common:actions.save")).toBe(
      "Plugin label",
    );
    expect(definitionText("Plugin label", "nonsense")).toBe("Plugin label");
  });
});

describe("localizeDefinitionField", () => {
  it("leaves a literal-only field exactly as the plugin supplied it", () => {
    const literal: ContentDefinitionField = {
      key: "headline",
      label: "Headline",
      description: "Shown large.",
      control: "select",
      options: [{ value: "a", label: "Option A" }],
    };
    expect(localizeDefinitionField(literal)).toEqual(literal);
  });

  it("resolves the label, description, and option labels together", async () => {
    await i18n.changeLanguage("es");
    const localized = localizeDefinitionField({
      key: "reloadPolicy",
      label: "Reload",
      labelKey: "definitions:website.fields.reloadPolicy.label",
      control: "select",
      options: [
        {
          value: "interval",
          label: "Reload on an interval",
          labelKey: "definitions:website.fields.reloadPolicy.options.interval",
        },
        { value: "custom", label: "Plugin-added choice" },
      ],
    });
    expect(localized.label).toBe("Política de recarga");
    expect(localized.options).toEqual([
      {
        value: "interval",
        label: "Recargar por intervalo",
        labelKey: "definitions:website.fields.reloadPolicy.options.interval",
      },
      { value: "custom", label: "Plugin-added choice" },
    ]);
    expect(localizeDefinitionField(field).description).toBe(
      "La página pública que se mostrará. Usa HTTPS; el HTTP simple solo funciona con direcciones privadas cuando esta instalación lo permite.",
    );
  });

  it("keeps the description literal when only its key is unknown", () => {
    const localized = localizeDefinitionField({
      ...field,
      descriptionKey: "definitions:website.fields.url.missing",
    });
    expect(localized.description).toBe("The public page to show.");
  });

  it("localizes the fields of a repeating group", async () => {
    await i18n.changeLanguage("ru");
    const group: ContentDefinitionField = {
      key: "rows",
      label: "Rows",
      control: "repeating_group",
      itemFields: [field],
    };
    expect(localizeDefinitionField(group).itemFields![0]!.label).toBe(
      "Веб-адрес",
    );
  });
});

describe("the shipped Website and YouTube definitions", () => {
  const catalog = repositoryCatalog();
  const keyed = ["website", "youtube"].map((id) =>
    catalog.widgets.find((widget) => widget.id === id)!,
  );

  const keysOf = (fields: ContentDefinitionField[]): [string, string?][] =>
    fields.flatMap((entry): [string, string?][] => [
      [entry.label, entry.labelKey],
      ...(entry.description
        ? [[entry.description, entry.descriptionKey] as [string, string?]]
        : []),
      ...(entry.options ?? []).map((option): [string, string?] => [
        option.label,
        option.labelKey,
      ]),
    ]);

  it("carry a key for every author-facing string", () => {
    for (const definition of keyed)
      for (const [literal, key] of keysOf(
        definition.configurationSchema.fields,
      )) {
        expect(key, `${definition.id}: ${literal}`).toMatch(/^definitions:/);
      }
  });

  it("keep English identical to the literal each definition declares", () => {
    for (const definition of keyed)
      for (const [literal, key] of keysOf(
        definition.configurationSchema.fields,
      ))
        expect(definitionText(literal, key as string)).toBe(literal);
  });

  it.each(["es", "ru"] as const)(
    "define every author-facing string in %s",
    async (language) => {
      await i18n.changeLanguage(language);
      for (const definition of keyed)
        for (const [literal, key] of keysOf(
          definition.configurationSchema.fields,
        )) {
          const path = (key as string).slice("definitions:".length);
          // A string the locale lacks would silently show the English literal.
          expect(
            i18n.getResource(language, "definitions", path),
            `${language} ${key}`,
          ).toEqual(expect.any(String));
          const text = definitionText(literal, key);
          expect(text.trim()).not.toBe("");
        }
    },
  );
});

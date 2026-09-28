/**
 * The TypeScript upgrade must agree with contentdefs.UpgradeAuthorConfiguration
 * (apps/server/internal/contentdefs/upgrade_test.go uses the same cases).
 */
import { describe, expect, it } from "vitest";
import { templateReads, upgradeAuthorConfiguration } from "../src/upgrade.ts";
import table from "../../../widgets/table/tilecast.widget.json";
import catalog from "../../../apps/server/internal/contentdefs/definitions/catalog.json";

type Definition = {
  id: string;
  configurationSchema: { fields: { key: string }[] };
  component: { configTemplate: Record<string, unknown> };
};

const qrcode = (catalog.widgets as unknown as Definition[]).find(
  (definition) => definition.id === "qrcode",
)!;

describe("upgradeAuthorConfiguration", () => {
  it("fills V2 fields from the legacy keys the template falls back to", () => {
    const upgraded = upgradeAuthorConfiguration(
      qrcode.configurationSchema.fields,
      qrcode.component.configTemplate,
      {
        value: "https://example.org",
        label: "example.org",
        errorCorrection: "high",
        foregroundColor: "#000000",
      },
    );
    expect(upgraded.configuration).toEqual({
      payload: "https://example.org",
      shortLabel: "example.org",
      errorCorrection: "high",
      foregroundColor: "#000000",
    });
    expect([...upgraded.consumed].sort()).toEqual(["label", "value"]);
  });

  it("lets a current key win and keeps the legacy key untouched", () => {
    expect(
      upgradeAuthorConfiguration(
        qrcode.configurationSchema.fields,
        qrcode.component.configTemplate,
        { payload: "https://example.com", value: "https://example.org" },
      ).configuration,
    ).toEqual({ payload: "https://example.com", value: "https://example.org" });
  });

  it("keeps keys the component still reads", () => {
    const upgraded = upgradeAuthorConfiguration(
      table.configurationSchema.fields as never,
      table.component.configTemplate,
      {
        fields: ["title"],
        maximumItems: 7,
        emptyState: "None",
        rowSpacing: "compact",
      },
    );
    expect(upgraded.configuration).toEqual({
      fields: ["title"],
      maximumRows: 7,
      emptyText: "None",
      density: "compact",
    });
  });

  it("drops unknown keys and legacy item keys only when asked", () => {
    const saved = {
      columns: [
        { field: "title", label: "Name", format: "text", alignment: "left" },
      ],
      textScale: 120,
    };
    const fields = table.configurationSchema.fields as never;
    const template = table.component.configTemplate;
    expect(
      upgradeAuthorConfiguration(fields, template, saved).configuration,
    ).toEqual(saved);
    expect(
      upgradeAuthorConfiguration(fields, template, saved, { dropUnknown: true })
        .configuration,
    ).toEqual({ columns: [{ field: "title", label: "Name" }] });
  });

  it("does not mutate the saved configuration", () => {
    const saved = { value: "x" };
    upgradeAuthorConfiguration(
      qrcode.configurationSchema.fields,
      qrcode.component.configTemplate,
      saved,
    );
    expect(saved).toEqual({ value: "x" });
  });

  it("lists every key a template reads", () => {
    const reads = templateReads(table.component.configTemplate);
    expect(reads.has("fields")).toBe(true);
    expect(reads.has("emptyState")).toBe(true);
    expect(reads.has("textScale")).toBe(false);
  });
});

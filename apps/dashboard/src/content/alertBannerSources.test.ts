// Alert Banner needs only a message. A source with no severity must stay in
// the picker, and Studio's automatic mapping must not invent a severity.
import { describe, expect, it } from "vitest";
import type {
  ContentDefinitionField,
  DataSource,
  DataSourceDefinition,
  DataSourceField,
  WidgetDefinition,
} from "@/api/types";
import { suggestedSourceField } from "@/components/content/widget-editor/fields/fieldMapping";
import alertBannerManifest from "../../../../widgets/alert-banner/tilecast.widget.json";
import { compatibleSources, dataFormatGuideFor } from "./dataSourceBindings";

const alertBanner = alertBannerManifest as unknown as WidgetDefinition;
const fields = alertBanner.configurationSchema.fields;
const field = (key: string): ContentDefinitionField =>
  fields.find((entry) => entry.key === key)!;

function objectSource(
  id: string,
  outputs: readonly string[],
  kind: DataSourceDefinition["outputSchema"]["kind"] = "object",
): [DataSource, DataSourceDefinition] {
  return [
    { id, provider: id, name: id } as unknown as DataSource,
    {
      id,
      name: id,
      outputSchema: {
        kind,
        fields: outputs.map((key) => ({ key, label: key, type: "text" })),
      },
    } as unknown as DataSourceDefinition,
  ];
}

describe("Alert Banner Data Source compatibility", () => {
  const messageOnly = objectSource("message-only", ["message"]);
  const full = objectSource("full", ["message", "severity", "status"]);
  const noMessage = objectSource("no-message", ["severity"]);
  const records = objectSource("records", ["message"], "records");
  const sources = [messageOnly, full, noMessage, records];

  it("requires only a message field from a source", () => {
    expect(field("dataSourceId").requiredFields).toEqual({ message: "text" });
    expect(alertBannerManifest.requiredFieldTypes).toEqual({ message: "text" });
  });

  it("offers a message-only source and a richer source, never one without a message", () => {
    const ids = compatibleSources(
      field("dataSourceId"),
      sources.map(([source]) => source),
      sources.map(([, definition]) => definition),
    ).map((source) => source.id);
    expect(ids).toEqual(["message-only", "full"]);
  });

  it("describes severity and label as optional in the data format guide", () => {
    const guide = dataFormatGuideFor(field("dataSourceId"), fields);
    const byKey = Object.fromEntries(
      guide.fields.map((entry) => [entry.key, entry.required]),
    );
    expect(byKey["message"]).toBe(true);
    expect(byKey["severity"]).toBeFalsy();
  });
});

describe("Alert Banner automatic mapping", () => {
  const source = (
    ...entries: [key: string, role?: string][]
  ): DataSourceField[] =>
    entries.map(([key, role]) => ({ key, label: key, type: "text", role }));

  it("maps message, severity, and label from declared roles", () => {
    const managed = source(
      ["headline", "status"],
      ["body", "message"],
      ["level", "severity"],
    );
    expect(suggestedSourceField(field("messageField"), managed)).toBe("body");
    expect(suggestedSourceField(field("severityField"), managed)).toBe("level");
    expect(suggestedSourceField(field("labelField"), managed)).toBe("headline");
  });

  it("maps a plain source by key", () => {
    const plain = source(["message"], ["severity"], ["label"]);
    expect(suggestedSourceField(field("severityField"), plain)).toBe(
      "severity",
    );
    expect(suggestedSourceField(field("labelField"), plain)).toBe("label");
  });

  it("leaves severity and label unmapped for a message-only source", () => {
    const messageOnly = source(["message"]);
    expect(suggestedSourceField(field("messageField"), messageOnly)).toBe(
      "message",
    );
    expect(suggestedSourceField(field("severityField"), messageOnly)).toBe("");
    expect(suggestedSourceField(field("labelField"), messageOnly)).toBe("");
  });

  it("still guesses an ordinary optional slot from its type", () => {
    // Only fields that opt out with typeFallback: false skip the guess.
    const guessable: ContentDefinitionField = {
      key: "detailField",
      label: "Detail",
      control: "data_source_field",
      dataSourceFieldTypes: ["text"],
    };
    expect(suggestedSourceField(guessable, source(["notes"]))).toBe("notes");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const schemas = join(import.meta.dirname, "..", "..", "manifest-schema");
const read = (name: string) =>
  JSON.parse(readFileSync(join(schemas, name), "utf8")) as Record<
    string,
    unknown
  >;

describe("plugin_state wire entry", () => {
  // Player Core, the platforms, and the Shared Runtime parse this fixture;
  // the portable v21 schema must describe it too.
  it("validates the shared fixture against manifest schema v21", () => {
    const schema = read("schema-v21.json") as {
      $defs: { pluginState: Record<string, unknown> };
      properties: { plugins: { items: { oneOf: { $ref: string }[] } } };
    };
    expect(schema.properties.plugins.items.oneOf).toContainEqual({
      $ref: "#/$defs/pluginState",
    });
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validate = ajv.compile(schema.$defs.pluginState);
    const fixture = read("plugin-state-entry-fixture.json");
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...fixture, config: {} })).toBe(false);
    expect(validate({ ...fixture, state: [] })).toBe(false);
  });
});

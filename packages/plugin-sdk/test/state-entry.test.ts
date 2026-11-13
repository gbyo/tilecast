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

// The entry reuses the Layout font family definition of schema v11. The
// portable v11 schema references older schema files, so the test inlines
// only that definition.
function compilePluginState() {
  const v21 = read("schema-v21.json") as {
    $defs: { pluginState: Record<string, unknown> };
  };
  const layoutFont = (
    read("schema-v11.json") as { $defs: { layoutFont: unknown } }
  ).$defs.layoutFont;
  const entry = JSON.parse(
    JSON.stringify(v21.$defs.pluginState).replace(
      '"schema-v11.json#/$defs/layoutFont"',
      '"#/$defs/layoutFont"',
    ),
  ) as Record<string, unknown>;
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  return ajv.compile({ ...entry, $defs: { layoutFont } });
}

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
    const validate = compilePluginState();
    const fixture = read("plugin-state-entry-fixture.json");
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...fixture, config: {} })).toBe(false);
    expect(validate({ ...fixture, state: [] })).toBe(false);
  });

  it("describes the library fonts a state entry declares", () => {
    const validate = compilePluginState();
    const fixture = read("plugin-state-entry-fixture.json");
    const uuid = "5c0a2f8e-3c1b-4d2a-9e7f-0a1b2c3d4e5f";
    const family = {
      id: uuid,
      family: "Inter",
      faces: [
        {
          assetId: uuid,
          variantId: uuid,
          style: "normal",
          weightMin: 100,
          weightMax: 900,
          unicodeRange: "U+0000-00FF",
        },
      ],
    };
    expect(validate({ ...fixture, fonts: [family] })).toBe(true);
    expect(validate({ ...fixture, fonts: null })).toBe(true);
    expect(validate({ ...fixture, fonts: Array(5).fill(family) })).toBe(false);
    expect(validate({ ...fixture, fonts: [{ ...family, faces: [] }] })).toBe(
      false,
    );
    expect(
      validate({
        ...fixture,
        fonts: [
          { ...family, faces: [{ ...family.faces[0], style: "oblique" }] },
        ],
      }),
    ).toBe(false);
  });
});

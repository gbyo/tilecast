import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parsePluginManifest, pluginManifestJSONSchema } from "../src/manifest";

const fixtures = join(import.meta.dirname, "..", "testdata", "manifests");

function load(group: "valid" | "invalid") {
  return readdirSync(join(fixtures, group))
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      name,
      value: JSON.parse(readFileSync(join(fixtures, group, name), "utf8")),
    }));
}

// The same fixtures run through the Go parser (go/plugin/manifest_test.go),
// so the two validators cannot drift apart silently.
describe("plugin manifest schema", () => {
  it.each(load("valid"))("accepts $name", ({ value }) => {
    expect(() => parsePluginManifest(value)).not.toThrow();
  });

  it.each(load("invalid"))("rejects $name", ({ value }) => {
    expect(() => parsePluginManifest(value)).toThrow();
  });

  it("fills in documented defaults", () => {
    const manifest = parsePluginManifest(
      JSON.parse(readFileSync(join(fixtures, "valid", "minimal.json"), "utf8")),
    );
    expect(manifest.installable).toBe(true);
    expect(manifest.capabilities).toEqual({
      playerManifest: false,
      backgroundWorkers: false,
      network: [],
      hardware: [],
      heartbeat: [],
    });
  });

  it("publishes a Draft 2020-12 JSON Schema that matches the checked-in file", () => {
    const generated = pluginManifestJSONSchema();
    expect(generated.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    const committed = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "..",
          "schema",
          "tilecast-plugin.schema.json",
        ),
        "utf8",
      ),
    );
    expect(committed).toEqual(generated);
  });

  // The JSON Schema is the portable contract for other languages and editors.
  // It must reach the same verdict as the Zod schema it was generated from.
  it("validates the fixtures with a Draft 2020-12 validator", () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(pluginManifestJSONSchema());
    for (const { name, value } of load("valid")) {
      expect(
        validate(value),
        `${name}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    }
    for (const { name, value } of load("invalid")) {
      expect(validate(value), name).toBe(false);
    }
  });
});

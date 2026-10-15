import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  isPlayerFacing,
  parsePluginManifest,
  playerEntryTypes,
  pluginManifestJSONSchema,
  runtimeEntrypoint,
} from "../src/manifest";

const fixtures = join(import.meta.dirname, "..", "testdata", "manifests");

function load(group: "valid" | "invalid" | "invalid-semantic") {
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

  // Cross-field rules a JSON Schema cannot state. Zod and Go both refuse
  // these; the portable schema accepts their structure.
  it.each(load("invalid-semantic"))("rejects $name", ({ value }) => {
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

  it("normalizes v1 and v2 Player declarations", () => {
    const fixture = (name: string) =>
      parsePluginManifest(
        JSON.parse(readFileSync(join(fixtures, "valid", name), "utf8")),
      );
    const v1 = fixture("complete.json");
    expect(playerEntryTypes(v1)).toEqual(["transit_alert"]);
    expect(isPlayerFacing(v1)).toBe(true);
    expect(runtimeEntrypoint(v1)).toBe("./runtime/index.ts");

    const serverStudio = fixture("v2-server-studio.json");
    expect(playerEntryTypes(serverStudio)).toEqual([]);
    expect(isPlayerFacing(serverStudio)).toBe(false);
    expect(runtimeEntrypoint(serverStudio)).toBeUndefined();

    const surfaces = fixture("v2-player-surface.json");
    expect(playerEntryTypes(surfaces)).toEqual(["service_notice"]);
    expect(isPlayerFacing(surfaces)).toBe(true);
    if (surfaces.apiVersion !== 2) throw new Error("expected v2");
    expect(surfaces.player?.runtime?.surfaces.map((s) => s.tier)).toEqual([
      "emergency",
      "ambient",
    ]);

    const native = fixture("v2-native.json");
    if (native.apiVersion !== 2) throw new Error("expected v2");
    expect(native.player?.native).toEqual([
      { id: "receiver", services: { required: [], optional: [] } },
    ]);
  });
});

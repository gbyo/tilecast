import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  externalPluginManifestJSONSchema,
  parseExternalPluginManifest,
} from "../src/external-plugin";

const fixtures = join(
  import.meta.dirname,
  "..",
  "testdata",
  "external-plugins",
);
describe("external Plugin API v2", () => {
  for (const group of ["valid", "invalid"] as const) {
    for (const name of readdirSync(join(fixtures, group)).filter((name) =>
      name.endsWith(".json"),
    )) {
      it(`${group}: ${name}`, () => {
        const value: unknown = JSON.parse(
          readFileSync(join(fixtures, group, name), "utf8"),
        );
        if (group === "valid")
          expect(() => parseExternalPluginManifest(value)).not.toThrow();
        else expect(() => parseExternalPluginManifest(value)).toThrow();
      });
    }
  }
  it("keeps the generated portable schema current", () => {
    expect(externalPluginManifestJSONSchema()).toEqual(
      JSON.parse(
        readFileSync(
          join(
            import.meta.dirname,
            "..",
            "schema",
            "external-plugin.schema.json",
          ),
          "utf8",
        ),
      ),
    );
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPackageNamespace,
  packageManifestJSONSchema,
  parsePackageManifest,
  satisfiesTilecastRange,
} from "../src/manifest";

const fixtures = join(import.meta.dirname, "..", "testdata", "manifests");

function load(group: "valid" | "invalid") {
  return readdirSync(join(fixtures, group))
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      name,
      value: JSON.parse(readFileSync(join(fixtures, group, name), "utf8")),
    }));
}

// The same fixtures run through the Go parser (go/package/manifest_test.go),
// so the two validators cannot drift apart silently.
describe("package manifest schema", () => {
  it.each(load("valid"))("accepts $name", ({ value }) => {
    expect(() => parsePackageManifest(value)).not.toThrow();
  });

  it.each(load("invalid"))("rejects $name", ({ value }) => {
    expect(() => parsePackageManifest(value)).toThrow();
  });

  it("accepts the Hello Services sample manifest", () => {
    const sample = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "..",
          "..",
          "package-samples",
          "hello-services",
          "tilecast.package.json",
        ),
        "utf8",
      ),
    );
    const manifest = parsePackageManifest(sample);
    expect(manifest.apiVersion).toBe(3);
    expect(manifest.packageId).toBe("example.hello-services");
    expect(manifest.capabilities?.services?.map((grant) => grant.id)).toEqual([
      "organization.read",
      "screens.read",
      "audit.write",
    ]);
  });

  it("publishes a Draft 2020-12 JSON Schema that matches the checked-in file", () => {
    const generated = packageManifestJSONSchema();
    expect(generated.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    const committed = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "..",
          "schema",
          "tilecast-package.schema.json",
        ),
        "utf8",
      ),
    );
    expect(committed).toEqual(generated);
  });
});

describe("package namespace rule", () => {
  it.each([
    ["acme.athletics", "acme.athletics", true],
    ["acme.athletics.scoreboard", "acme.athletics", true],
    ["acme.other", "acme.athletics", false],
    ["acme.athletics2", "acme.athletics", false],
    ["other.athletics", "acme.athletics", false],
  ])("%s in %s is %s", (contribution, packageId, expected) => {
    expect(isPackageNamespace(contribution, packageId)).toBe(expected);
  });
});

describe("tilecast compatibility ranges", () => {
  it.each([
    [">=1.2.0 <2.0.0", "1.2.0", true],
    [">=1.2.0 <2.0.0", "1.9.4", true],
    [">=1.2.0 <2.0.0", "2.0.0", false],
    [">=1.2.0 <2.0.0", "1.1.9", false],
    [">=1.1", "1.1.0", true],
    [">=1.1", "1.0.9", false],
    ["=1.4.2", "1.4.2", true],
    ["=1.4.2", "1.4.3", false],
    [">2.0.0", "2.0.1", true],
    [">2.0.0", "2.0.0", false],
    [">=0.20.0 <1.0.0", "0.26.0-beta.1", true],
    [">=0.27.0", "0.26.0-beta.12", false],
    [">=0.26.0", "0.26.0-beta.0", false],
    [">=0.20.0", "0.26.0-rc.1", false],
  ])("%s satisfies %s is %s", (range, version, expected) => {
    expect(satisfiesTilecastRange(range, version)).toBe(expected);
  });

  it("fails closed on malformed input", () => {
    expect(satisfiesTilecastRange(">=1.2.0 || <2.0.0", "1.5.0")).toBe(false);
    expect(satisfiesTilecastRange(">=1.2.0", "one.two.three")).toBe(false);
    expect(satisfiesTilecastRange("", "1.5.0")).toBe(false);
    expect(satisfiesTilecastRange(">=1.2.0", "")).toBe(false);
  });
});
